import AgentAvatar from './AgentAvatar';
import { agentKindLabels } from '../graphql/agents';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { TaskMention, TaskMentionable, TaskReaction } from '../graphql/operations';
import { usePendingAttachments, toAttachmentInputs, type AttachmentInput } from '../lib/attachments';
import { timeAgo } from '../lib/humanize';
import { initialsOf } from '../workbench/WorkspaceTabs';
import AttachmentChips from './AttachmentChips';
import { useDialogs } from './Dialogs';
import Markdown, { withMentionLinks } from './Markdown';

/**
 * Le moteur d'un fil de discussion à la Slack, commun au fil d'une tâche (TaskThread) et aux canaux de conversation
 * d'un projet (ChannelThread) : messages racines avec leurs réponses en fil, réactions par emoji, mentions en
 * pastilles, zone de saisie avec suggestions de mention. Les données et les mutations viennent de l'enveloppe, par
 * `ThreadApi` ; ici seulement le rendu et les interactions. Styles `tt-*` dans workbench.css.
 */

/** Emojis proposés d'un clic (les plus courants d'un fil de travail). */
const QUICK_EMOJIS = ['👍', '👀', '✅', '🎉', '❤️', '🤔', '❓', '🚀', '👎', '🙏'];

export const fmtFull = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Un message tel que le fil le rend : commentaire de tâche ou message de canal. */
export interface ThreadMessage {
  id: string;
  parentId: string | null;
  authorType: 'human' | 'agent';
  authorName: string;
  author: { id: string; name: string } | null;
  authorSession: { id: string; name: string } | null;
  /** Agent de projet dont la session a écrit le message. */
  agent?: { id: string; name: string; kind: 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM'; avatar: { emoji: string | null; color: string | null } } | null;
  body: string;
  mentions: TaskMention[];
  reactions: TaskReaction[];
  editable: boolean;
  deletable: boolean;
  attachments?: { id: string; name: string; mediaType: string; size: number }[];
  /** Sessions reliées au fil dont l'agent travaille en ce moment (« X répond… »), pour une racine. */
  respondingSessions?: { id: string; name: string; agent: { id: string; name: string } | null }[];
  createdAt: string;
  updatedAt: string;
}

/** Ce que l'enveloppe sait faire : écrire, modifier, supprimer, réagir ; et comment rendre les fichiers d'un message. */
export interface ThreadApi {
  /** Préfixe des ancres des messages (`#comment-<id>` pour une tâche, `#m-<id>` pour un canal). */
  anchor: string;
  /** Le composer accepte des fichiers. */
  files: boolean;
  send(input: { body: string; parentId: string | null; attachments: AttachmentInput[] | null }): Promise<unknown>;
  update(input: { id: string; body: string; removeAttachmentIds: string[] | null }): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  toggleReaction(messageId: string | null, emoji: string): void;
  /** Fichiers d'un message (lecture, ou édition avec les fichiers à retirer). */
  renderAttachments?: (m: ThreadMessage, edit?: { removed: string[]; onToggleRemove: (id: string) => void }) => ReactNode;
}

interface ThreadContextValue {
  api: ThreadApi;
  mentionables: TaskMentionable[];
  canWrite: boolean;
  compact: boolean;
}

const ThreadContext = createContext<ThreadContextValue | null>(null);

export function useThread(): ThreadContextValue {
  const ctx = useContext(ThreadContext);
  if (!ctx) throw new Error('useThread hors d’un ThreadProvider');
  return ctx;
}

/** Enveloppe d'un fil : fournit l'API, les mentions possibles et les droits aux messages et à la saisie. */
export function ThreadProvider({ api, mentionables, canWrite, compact = false, children }: { api: ThreadApi; mentionables: TaskMentionable[]; canWrite: boolean; compact?: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ api, mentionables, canWrite, compact }), [api, mentionables, canWrite, compact]);
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

/** Racines et réponses d'une liste de messages à plat (une réponse dont la racine manque est montrée en racine). */
export function groupThread<T extends { id: string; parentId: string | null }>(messages: T[]): { roots: T[]; byParent: Map<string, T[]> } {
  const byParent = new Map<string, T[]>();
  const ids = new Set(messages.map((c) => c.id));
  const roots: T[] = [];
  for (const c of messages) {
    if (c.parentId && ids.has(c.parentId)) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
    else roots.push(c);
  }
  return { roots, byParent };
}

/** Un lien `#<ancre>-<id>` (notification de mention ou de réponse) amène au message et le met en relief. */
export function useThreadAnchor(anchor: string, ready: boolean): void {
  useEffect(() => {
    if (!ready || !window.location.hash.startsWith(`#${anchor}-`)) return;
    const el = document.getElementById(window.location.hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('tt-flash');
    const t = setTimeout(() => el.classList.remove('tt-flash'), 2500);
    return () => clearTimeout(t);
  }, [anchor, ready]);
}

/** Avatar d'un auteur : initiales d'une personne, robot pour une session d'agent, avatar nommé pour un agent du projet. */
export function Avatar({ name, agent, projectAgent }: { name: string; agent: boolean; projectAgent?: { name: string; avatar: { emoji: string | null; color: string | null } } | null }) {
  if (projectAgent) return <AgentAvatar agent={projectAgent} size={28} className="tt-avatar tt-avatar-agent-named" title={`${projectAgent.name} (agent du projet)`} />;
  return agent ? (
    <span className="tt-avatar tt-avatar-agent" title="Session d'agent">
      <i className="bi bi-robot" />
    </span>
  ) : (
    <span className="tt-avatar" title={name}>
      {initialsOf(name)}
    </span>
  );
}

/** Barre des réactions d'un message : une puce par emoji (en relief si l'on en est), et le bouton « + ». */
export function Reactions({ reactions, onToggle }: { reactions: TaskReaction[]; onToggle: (emoji: string) => void }) {
  const { canWrite, compact } = useThread();
  const [picking, setPicking] = useState(false);
  if (!reactions.length && !canWrite) return null;
  return (
    <div className="tt-reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`tt-reaction${r.mine ? ' mine' : ''}`}
          title={`${r.actors.join(', ')}${canWrite ? (r.mine ? ' · cliquer pour retirer' : ' · cliquer pour réagir aussi') : ''}`}
          disabled={!canWrite}
          onClick={() => onToggle(r.emoji)}
        >
          <span className="tt-reaction-emoji">{r.emoji}</span> {r.count}
        </button>
      ))}
      {canWrite && (
        <span className="tt-react-wrap">
          <button type="button" className={`tt-reaction tt-react-add${picking ? ' open' : ''}${reactions.length || !compact ? '' : ' tt-react-quiet'}`} title="Réagir" aria-label="Ajouter une réaction" onClick={(e) => { e.stopPropagation(); setPicking((p) => !p); }}>
            <i className="bi bi-emoji-smile" />
            <i className="bi bi-plus" />
          </button>
          {picking && <EmojiPicker onPick={(e) => { onToggle(e); setPicking(false); }} onClose={() => setPicking(false)} />}
        </span>
      )}
    </div>
  );
}

/** Choix d'un emoji : les plus courants, ou un emoji tapé au clavier. Se ferme au clic ailleurs (le bouton qui l'ouvre arrête la propagation de son clic) et à l'échappement. */
function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState('');
  useEffect(() => {
    const close = () => onClose();
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div className="tt-emoji-picker" role="dialog" aria-label="Choisir une réaction" onClick={(e) => e.stopPropagation()}>
      {QUICK_EMOJIS.map((e) => (
        <button key={e} type="button" className="tt-emoji" onClick={() => onPick(e)} title={e}>
          {e}
        </button>
      ))}
      <input
        className="tt-emoji-custom"
        placeholder="autre…"
        aria-label="Autre emoji"
        value={custom}
        maxLength={8}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom.trim()) {
            e.preventDefault();
            onPick(custom.trim());
          }
        }}
      />
    </div>
  );
}

/**
 * Zone de saisie d'un message : Markdown, fichiers collés ou déposés (si l'API les accepte), ⌘/Ctrl+Entrée pour
 * envoyer, et suggestions de mention dès que l'on tape « @ » (membres du projet, agents, sessions ; flèches pour
 * choisir, Entrée ou Tab pour insérer). Pas de <form> : vit dans des formulaires.
 */
export function Composer({
  parentId = null,
  placeholder,
  autoFocus,
  onSent,
  onCancel,
  compact,
  sendLabel,
}: {
  parentId?: string | null;
  placeholder: string;
  autoFocus?: boolean;
  onSent?: () => void;
  onCancel?: () => void;
  compact?: boolean;
  sendLabel?: string;
}) {
  const { api, mentionables } = useThread();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = usePendingAttachments();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const canSend = Boolean(text.trim() || (api.files && files.items.length));
  const send = async () => {
    if (!canSend || loading) return;
    setLoading(true);
    setError(null);
    try {
      const attachments = api.files && files.items.length ? await toAttachmentInputs(files.items) : null;
      await api.send({ body: text, parentId, attachments });
      setText('');
      files.reset();
      onSent?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Suggestions : « @ » en début de mot avant le curseur, puis jusqu'à 40 caractères sans retour à la ligne.
  const detect = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|[\s(«"'])@([^@\n]{0,40})$/u.exec(before);
    if (!m) return setMention(null);
    const query = m[2];
    const start = caret - query.length - 1;
    setMention((cur) => (cur && cur.start === start ? { ...cur, query } : { start, query, index: 0 }));
  }, []);
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = fold(mention.query.trim());
    const hits = mentionables.filter((m) => !q || fold(m.label).includes(q) || fold(m.text).includes(q) || (m.detail ? fold(m.detail).includes(q) : false));
    // Les personnes et agents d'abord, puis les sessions ; au plus huit.
    const rank = (m: TaskMentionable) => (m.kind === 'user' ? 0 : m.kind === 'session' ? 1 : 2);
    return [...hits].sort((x, y) => rank(x) - rank(y)).slice(0, 8);
  }, [mention, mentionables]);
  const insert = (m: TaskMentionable) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}${m.text} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const pos = mention.start + m.text.length + 1;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({ ...mention, index: (mention.index + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(suggestions[mention.index] ?? suggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && onCancel) {
      onCancel();
    }
  };
  return (
    <div className={`tt-composer${compact ? ' compact' : ''}`}>
      <div className="tt-composer-box">
        <Form.Control
          as="textarea"
          ref={ref}
          rows={compact ? 2 : 3}
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) => detect(text, (e.target as HTMLTextAreaElement).selectionStart ?? text.length)}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={api.files ? files.onPaste : undefined}
          onDrop={api.files ? files.onDrop : undefined}
          onDragOver={api.files ? files.onDragOver : undefined}
          onKeyDown={onKeyDown}
        />
        {mention && suggestions.length > 0 && (
          <div className="tt-mention-menu" role="listbox" aria-label="Mentionner">
            {suggestions.map((m, i) => (
              <button
                key={`${m.kind}:${m.id}`}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className={`tt-mention-item${i === mention.index ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(m)}
              >
                <i className={`bi ${m.kind === 'session' || m.detail === 'agent' ? 'bi-robot' : 'bi-person'}`} />
                <span className="tt-mention-label">{m.label}</span>
                {m.detail && <span className="tt-mention-detail">{m.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tt-composer-foot">
        {api.files && <AttachmentChips items={files.items} onAdd={(f) => files.add(f)} onRemove={files.remove} disabled={loading} error={files.error} />}
        <span className="tt-composer-hint">@ pour mentionner · Markdown · ⌘/Ctrl+Entrée</span>
        <span className="tt-composer-actions">
          {onCancel && (
            <Button size="sm" variant="link" className="text-secondary" onClick={onCancel}>
              Annuler
            </Button>
          )}
          <Button size="sm" variant={parentId ? 'outline-primary' : 'primary'} disabled={loading || !canSend} onClick={() => void send()} title="Envoyer (⌘/Ctrl+Entrée)">
            {loading ? 'Envoi…' : (sendLabel ?? (parentId ? 'Répondre' : 'Envoyer'))}
          </Button>
        </span>
      </div>
      {error && (
        <Alert variant="danger" className="mt-2 mb-0 py-1 small">
          {error}
        </Alert>
      )}
    </div>
  );
}

/** Un message du fil : avatar, auteur, date, texte (mentions en pastilles), fichiers, réactions ; actions au survol. */
export function MessageView({ c, onReply, isReply }: { c: ThreadMessage; onReply?: () => void; isReply?: boolean }) {
  const { api, canWrite } = useThread();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [body, setBody] = useState(c.body);
  const [removed, setRemoved] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const { user } = useAuth();
  const { confirm, showError } = useDialogs();
  const edited = new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;
  const mentionsMe = Boolean(user && c.mentions.some((m) => m.kind === 'user' && m.id === user.id));
  const agent = c.authorType === 'agent';
  const attachments = c.attachments ?? [];
  const save = async () => {
    setSaving(true);
    try {
      await api.update({ id: c.id, body, removeAttachmentIds: removed.length ? removed : null });
      setEditing(false);
    } catch (err) {
      void showError(err as Error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div id={`${api.anchor}-${c.id}`} className={`tt-msg${isReply ? ' tt-reply' : ''}${mentionsMe ? ' tt-mentions-me' : ''}`}>
      <Avatar name={c.authorName} agent={agent} projectAgent={c.agent} />
      <div className="tt-msg-main">
        <div className="tt-msg-head">
          {c.authorSession ? (
            <Link to={`/sessions/${c.authorSession.id}`} className="tt-author">
              {c.authorName}
            </Link>
          ) : (
            <span className="tt-author">{c.authorName}</span>
          )}
          {agent && <span className="tt-badge-agent">{c.agent ? agentKindLabels[c.agent.kind] : 'agent'}</span>}
          <span className="tt-time" title={fmtFull(c.createdAt)}>
            {timeAgo(c.createdAt)}
            {edited && ' · modifié'}
          </span>
          <span className="tt-msg-actions">
            {canWrite && (
              <span className="tt-react-wrap">
                <button type="button" className="tt-icon-btn" title="Réagir" aria-label="Réagir" onClick={(e) => { e.stopPropagation(); setPicking((p) => !p); }}>
                  <i className="bi bi-emoji-smile" />
                </button>
                {picking && <EmojiPicker onPick={(e) => { api.toggleReaction(c.id, e); setPicking(false); }} onClose={() => setPicking(false)} />}
              </span>
            )}
            {canWrite && onReply && (
              <button type="button" className="tt-icon-btn" title="Répondre dans le fil" aria-label="Répondre dans le fil" onClick={onReply}>
                <i className="bi bi-reply" />
              </button>
            )}
            {c.editable && !editing && (
              <button type="button" className="tt-icon-btn" title="Modifier" aria-label="Modifier" onClick={() => setEditing(true)}>
                <i className="bi bi-pencil" />
              </button>
            )}
            {c.deletable && (
              <button
                type="button"
                className="tt-icon-btn"
                title="Supprimer"
                aria-label="Supprimer"
                onClick={async () => {
                  if (await confirm({ title: 'Supprimer le message', message: isReply ? 'Supprimer cette réponse ?' : 'Supprimer ce message et ses réponses ?', confirmLabel: 'Supprimer', danger: true })) api.remove(c.id).catch((e) => void showError(e as Error));
                }}
              >
                <i className="bi bi-trash" />
              </button>
            )}
          </span>
        </div>
        {editing ? (
          <div className="mt-1">
            <Form.Control as="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            {api.renderAttachments?.(c, { removed, onToggleRemove: (id) => setRemoved((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id])) })}
            <div className="d-flex gap-2 mt-1">
              <Button size="sm" variant="outline-secondary" onClick={() => { setEditing(false); setBody(c.body); setRemoved([]); }}>
                Annuler
              </Button>
              <Button size="sm" disabled={saving || (!body.trim() && removed.length >= attachments.length)} onClick={() => void save()}>
                Enregistrer
              </Button>
            </div>
          </div>
        ) : (
          <>
            {c.body && <Markdown text={withMentionLinks(c.body, c.mentions)} className="tt-body" />}
            {api.renderAttachments?.(c)}
          </>
        )}
        <Reactions reactions={c.reactions} onToggle={(e) => api.toggleReaction(c.id, e)} />
      </div>
    </div>
  );
}

/** « Ben répond… » : les sessions d'agent reliées au fil qui travaillent en ce moment. */
function Responding({ sessions }: { sessions: NonNullable<ThreadMessage['respondingSessions']> }) {
  if (!sessions.length) return null;
  const names = [...new Set(sessions.map((s) => s.agent?.name ?? s.name))];
  return (
    <div className="tt-responding">
      <span className="tt-responding-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {names.slice(0, 2).join(' et ')}
      {names.length > 2 && ` et ${names.length - 2} autre${names.length > 3 ? 's' : ''}`} {names.length > 1 ? 'répondent' : 'répond'}…
      {sessions[0] && (
        <Link to={`/sessions/${sessions[0].id}`} className="ms-2">
          voir la session
        </Link>
      )}
    </div>
  );
}

/** Un message racine avec son fil de réponses (replié au-delà de trois) et, à la demande, la zone pour y répondre. */
export function RootMessage({ root, replies, replyPlaceholder }: { root: ThreadMessage; replies: ThreadMessage[]; replyPlaceholder?: string }) {
  const { canWrite } = useThread();
  const [open, setOpen] = useState(replies.length <= 3);
  const [replying, setReplying] = useState(false);
  const last = replies[replies.length - 1];
  const participants = [...new Set(replies.map((r) => r.authorName))];
  const responding = root.respondingSessions ?? [];
  return (
    <div className="tt-root">
      <MessageView c={root} onReply={() => { setReplying(true); setOpen(true); }} />
      {(replies.length > 0 || replying || responding.length > 0) && (
        <div className="tt-thread">
          {replies.length > 0 && (
            <button type="button" className="tt-thread-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <i className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}`} />
              {replies.length} réponse{replies.length > 1 ? 's' : ''}
              {!open && last && (
                <span className="tt-thread-meta">
                  {' · '}
                  {participants.slice(0, 3).join(', ')}
                  {participants.length > 3 && ` et ${participants.length - 3} autre${participants.length > 4 ? 's' : ''}`}
                  {' · dernière '}
                  {timeAgo(last.createdAt)}
                </span>
              )}
            </button>
          )}
          {open && replies.map((r) => <MessageView key={r.id} c={r} isReply />)}
          <Responding sessions={responding} />
          {open && canWrite && !replying && replies.length > 0 && (
            <button type="button" className="tt-thread-reply-link" onClick={() => setReplying(true)}>
              <i className="bi bi-reply" /> Répondre dans le fil
            </button>
          )}
          {replying && <Composer parentId={root.id} placeholder={replyPlaceholder ?? `Répondre à ${root.authorName}…`} autoFocus compact onSent={() => setReplying(false)} onCancel={() => setReplying(false)} />}
        </div>
      )}
    </div>
  );
}
