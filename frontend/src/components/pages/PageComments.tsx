import { useMutation } from '@apollo/client';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Form } from 'react-bootstrap';
import { useAuth } from '../../auth/AuthContext';
import { ADD_SHARED_PAGE_COMMENT, DELETE_SHARED_PAGE_COMMENT, REPLY_SHARED_PAGE_COMMENT, RESOLVE_SHARED_PAGE_COMMENT, SHARED_PAGE_COMMENTS, UPDATE_SHARED_PAGE_COMMENT, type SharedPage, type SharedPageAnchor, type SharedPageComment } from '../../graphql/misc';
import { timeAgo } from '../../lib/humanize';
import { usePollingQuery } from '../../lib/usePollingQuery';
import { useDialogs } from '../Dialogs';
import { Avatar } from '../Thread';
import './pageComments.css';

type Filter = 'open' | 'resolved' | 'all';

/** Message échangé avec le script injecté dans la page (voir backend/src/sharedPages/comment-client.js). */
interface FrameMessage {
  skipperComments: 1;
  type: string;
  [key: string]: unknown;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Ancre reçue de la page : données non fiables (HTML publié), on ne garde que les champs attendus, bornés. */
function cleanAnchor(raw: unknown): SharedPageAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const selector = str(a.selector, 500).trim();
  if (!selector) return null;
  return { selector, text: str(a.text, 200).trim() || null, tag: str(a.tag, 40).toLowerCase() || null };
}

export function anchorLabel(anchor: SharedPageAnchor): string {
  const tag = anchor.tag ? `<${anchor.tag}>` : 'élément';
  return anchor.text ? `${tag} « ${anchor.text.length > 60 ? `${anchor.text.slice(0, 59)}…` : anchor.text} »` : `${tag} ${anchor.selector}`;
}

interface Props {
  page: SharedPage;
  /** Version affichée dans le cadre (un commentaire créé maintenant s'y rattache). */
  version: number;
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** Mode « pointer un élément » : tenu par la page, qui affiche aussi la barre d'annulation au-dessus du cadre. */
  picking: boolean;
  setPicking: (on: boolean) => void;
  /** Commentaire à mettre en avant à l'ouverture (lien d'une notification `?comment=`). */
  initialFocus?: string | null;
  /**
   * Panneau visible. Fermé, le composant reste monté (caché) : les repères restent dessinés dans la page et un clic
   * sur l'un d'eux rouvre le panneau directement sur le commentaire (`onOpen`).
   */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Propriétaire d'une page publiée par une session : envoie les commentaires à traiter à cette session. */
  onSendToAgent?: () => Promise<void>;
}

/**
 * Panneau des commentaires d'une page partagée : commentaires généraux ou ancrés sur un élément de la page (choisi en
 * cliquant dedans), chacun une micro-conversation avec ses réponses et un état « traité ». Dialogue avec le script
 * injecté dans la page par postMessage : repères numérotés, choix d'un élément, mise en avant.
 */
export default function PageComments({ page, version, frameRef, picking, setPicking, initialFocus, open, onOpen, onClose, onSendToAgent }: Props) {
  const { user } = useAuth();
  const { confirm, showError } = useDialogs();
  const { data } = usePollingQuery<{ sharedPage: { id: string; version: number; openComments: number; comments: SharedPageComment[] } | null }>(SHARED_PAGE_COMMENTS, { variables: { id: page.id }, pollInterval: 10_000 });
  const comments = useMemo(() => data?.sharedPage?.comments ?? [], [data]);
  const [filter, setFilter] = useState<Filter>('open');
  const [draft, setDraft] = useState('');
  const [anchor, setAnchor] = useState<SharedPageAnchor | null>(null);
  const [focused, setFocused] = useState<string | null>(initialFocus ?? null);
  const [found, setFound] = useState<Set<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const refetch = { refetchQueries: ['SharedPageComments', 'SharedPage'], onError: (e: Error) => void showError(e) };
  const [add, { loading: adding }] = useMutation(ADD_SHARED_PAGE_COMMENT, refetch);
  const [reply] = useMutation(REPLY_SHARED_PAGE_COMMENT, refetch);
  const [update] = useMutation(UPDATE_SHARED_PAGE_COMMENT, refetch);
  const [resolve] = useMutation(RESOLVE_SHARED_PAGE_COMMENT, refetch);
  const [remove] = useMutation(DELETE_SHARED_PAGE_COMMENT, refetch);

  const post = useCallback(
    (msg: Omit<FrameMessage, 'skipperComments'>) => {
      frameRef.current?.contentWindow?.postMessage({ skipperComments: 1, ...msg }, '*');
    },
    [frameRef],
  );

  // Numéros des repères : stables, dans l'ordre de création des commentaires ancrés, quel que soit le filtre.
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    comments.filter((c) => c.anchor).forEach((c, i) => map.set(c.id, i + 1));
    return map;
  }, [comments]);
  const visible = useMemo(() => comments.filter((c) => (filter === 'open' ? !c.resolved : filter === 'resolved' ? c.resolved : true)), [comments, filter]);
  const openCount = comments.filter((c) => !c.resolved).length;

  // Repères envoyés à la page : les commentaires ancrés visibles, et celui mis en avant.
  const sendAnchors = useCallback(() => {
    post({
      type: 'anchors',
      anchors: visible.filter((c) => c.anchor).map((c) => ({ id: c.id, n: numbers.get(c.id), selector: c.anchor!.selector, resolved: c.resolved, focused: c.id === focused, title: c.body.slice(0, 200) })),
    });
  }, [post, visible, numbers, focused]);
  useEffect(sendAnchors, [sendAnchors]);
  useEffect(() => post({ type: picking ? 'pick' : 'cancel' }), [post, picking]);

  // Messages du script de la page (source vérifiée : le cadre lui-même).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as FrameMessage | null;
      if (!m || typeof m !== 'object' || m.skipperComments !== 1) return;
      if (m.type === 'ready') sendAnchors();
      else if (m.type === 'picked') {
        const a = cleanAnchor(m.anchor);
        if (a) setAnchor(a);
        setPicking(false);
      } else if (m.type === 'cancelled') setPicking(false);
      else if (m.type === 'pin') {
        // Clic sur un repère dans la page : droit au commentaire (panneau ouvert s'il ne l'était pas).
        const id = str(m.id, 80);
        if (comments.some((c) => c.id === id)) {
          setFocused(id);
          setFlash(id);
          if (filter !== 'all' && !visible.some((c) => c.id === id)) setFilter('all');
          onOpen();
        }
      } else if (m.type === 'found') setFound(new Set(Array.isArray(m.ids) ? m.ids.filter((x): x is string => typeof x === 'string') : []));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameRef, sendAnchors, setPicking, comments, visible, filter, onOpen]);

  // Commentaire mis en avant (repère cliqué, lien de notification) : visible et à l'écran, une fois le panneau affiché
  // (caché, scrollIntoView ne ferait rien).
  useEffect(() => {
    if (!focused || !open) return;
    const c = comments.find((x) => x.id === focused);
    if (!c) return;
    if (filter === 'open' && c.resolved) setFilter('all');
    const node = listRef.current?.querySelector<HTMLElement>(`[data-comment="${focused}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused, open, comments, filter]);
  // Éclair sur la carte visée par un clic de repère, retiré ensuite pour pouvoir rejouer l'animation.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const focus = (c: SharedPageComment) => {
    setFocused(c.id);
    if (c.anchor) post({ type: 'focus', selector: c.anchor.selector });
  };

  const submit = async () => {
    if (!draft.trim()) return;
    await add({ variables: { pageId: page.id, body: draft.trim(), anchor, version } });
    setDraft('');
    setAnchor(null);
    setFilter((f) => (f === 'resolved' ? 'open' : f));
  };

  return (
    <aside className={`pc-panel${open ? '' : ' hidden'}`} aria-label="Commentaires" aria-hidden={!open}>
      <div className="pc-head">
        <span className="pc-title">
          Commentaires {openCount > 0 && <span className="pc-count">{openCount}</span>}
        </span>
        <Form.Select size="sm" className="pc-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filtrer les commentaires">
          <option value="open">À traiter ({openCount})</option>
          <option value="resolved">Traités ({comments.length - openCount})</option>
          <option value="all">Tous ({comments.length})</option>
        </Form.Select>
        <button type="button" className="tt-icon-btn pc-close" title="Fermer" aria-label="Fermer les commentaires" onClick={onClose}>
          <i className="bi bi-x-lg" />
        </button>
      </div>

      <div className="pc-compose">
        {anchor ? (
          <div className="pc-anchor-chip">
            <i className="bi bi-geo-alt-fill" />
            <span className="pc-anchor-text" title={anchor.selector}>
              {anchorLabel(anchor)}
            </span>
            <button type="button" className="tt-icon-btn" title="Retirer l'ancre (commentaire général)" onClick={() => setAnchor(null)}>
              <i className="bi bi-x" />
            </button>
          </div>
        ) : picking ? (
          <div className="pc-anchor-chip picking">
            <i className="bi bi-cursor" /> Cliquez sur un élément de la page…
            <button type="button" className="tt-icon-btn ms-auto" title="Annuler" onClick={() => setPicking(false)}>
              <i className="bi bi-x" />
            </button>
          </div>
        ) : null}
        <Form.Control
          as="textarea"
          rows={2}
          size="sm"
          placeholder={anchor ? 'Votre commentaire sur cet élément…' : 'Commentaire général sur la page…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div className="pc-compose-row">
          {!anchor && (
            <button type="button" className={`cc-btn${picking ? ' accent' : ''}`} onClick={() => setPicking(!picking)} title="Commenter un endroit précis de la page">
              <i className="bi bi-geo-alt" /> {picking ? 'Annuler' : 'Pointer un endroit'}
            </button>
          )}
          <button type="button" className="cc-btn accent ms-auto" disabled={adding || !draft.trim()} onClick={() => void submit()} title="Ctrl+Entrée">
            <i className="bi bi-send" /> Commenter
          </button>
        </div>
      </div>

      {onSendToAgent && openCount > 0 && (
        <div className="pc-agent-row">
          <button type="button" className="cc-btn" onClick={() => void onSendToAgent()} title="L'agent qui a publié la page prend en compte les commentaires à traiter, publie une nouvelle version et les marque traités">
            <i className="bi bi-robot" /> Transmettre à l'agent ({openCount})
          </button>
        </div>
      )}
      <div className="pc-list" ref={listRef}>
        {!data && <div className="pc-empty">Chargement…</div>}
        {data && visible.length === 0 && (
          <div className="pc-empty">
            {comments.length === 0 ? "Aucun commentaire pour l'instant. Écrivez une remarque générale, ou pointez un endroit de la page." : filter === 'open' ? 'Tout est traité.' : 'Aucun commentaire traité.'}
          </div>
        )}
        {visible.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            number={numbers.get(c.id) ?? null}
            pageVersion={version}
            missing={Boolean(c.anchor) && found !== null && !found.has(c.id)}
            focused={c.id === focused}
            flash={c.id === flash}
            canDelete={user?.id === c.author.id || page.viewerAccess.owner}
            userId={user?.id ?? null}
            onFocus={() => focus(c)}
            onReply={(body) => reply({ variables: { commentId: c.id, body } })}
            onEdit={(id, body) => update({ variables: { id, body } })}
            onResolve={(resolved) => resolve({ variables: { id: c.id, resolved } })}
            onDelete={async (id, isReply) => {
              if (await confirm({ title: isReply ? 'Supprimer la réponse' : 'Supprimer le commentaire', message: isReply ? 'Supprimer cette réponse ?' : `Supprimer ce commentaire${c.replies.length ? ` et ses ${c.replies.length} réponse${c.replies.length > 1 ? 's' : ''}` : ''} ?`, confirmLabel: 'Supprimer', danger: true })) {
                await remove({ variables: { id } });
                if (id === focused) setFocused(null);
              }
            }}
          />
        ))}
      </div>
    </aside>
  );
}

interface CardProps {
  comment: SharedPageComment;
  number: number | null;
  pageVersion: number;
  /** Ancré, mais l'élément n'est pas retrouvé dans la version affichée. */
  missing: boolean;
  focused: boolean;
  /** Animation d'arrivée (clic sur un repère). */
  flash: boolean;
  canDelete: boolean;
  userId: string | null;
  onFocus: () => void;
  onReply: (body: string) => Promise<unknown>;
  onEdit: (id: string, body: string) => Promise<unknown>;
  onResolve: (resolved: boolean) => Promise<unknown>;
  onDelete: (id: string, isReply: boolean) => Promise<unknown>;
}

/** Un commentaire racine : ancre, auteur, texte, réponses, saisie d'une réponse, traité / rouvert. */
function CommentCard({ comment: c, number, pageVersion, missing, focused, flash, canDelete, userId, onFocus, onReply, onEdit, onResolve, onDelete }: CardProps) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const sendReply = async () => {
    if (!replyText.trim()) return;
    setSending(true);
    try {
      await onReply(replyText.trim());
      setReplyText('');
      setReplying(false);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`pc-card${c.resolved ? ' resolved' : ''}${focused ? ' focused' : ''}${flash ? ' pc-flash' : ''}`} data-comment={c.id} onClick={onFocus}>
      {c.anchor ? (
        <div className={`pc-anchor${missing ? ' missing' : ''}`} title={missing ? `Élément introuvable dans la version ${pageVersion} : ${c.anchor.selector}` : c.anchor.selector}>
          {number != null && <span className={`pc-pin${c.resolved ? ' done' : ''}`}>{number}</span>}
          <span className="pc-anchor-text">{anchorLabel(c.anchor)}</span>
          {missing && <i className="bi bi-exclamation-triangle" title="Élément introuvable dans cette version" />}
        </div>
      ) : (
        <div className="pc-anchor general">
          <i className="bi bi-chat-left-text" /> Général
        </div>
      )}
      <Message comment={c} userId={userId} canDelete={canDelete} onEdit={onEdit} onDelete={(id) => onDelete(id, false)} />
      {c.replies.map((r) => (
        <Message key={r.id} comment={r} reply userId={userId} canDelete={userId === r.author.id || canDelete} onEdit={onEdit} onDelete={(id) => onDelete(id, true)} />
      ))}
      <div className="pc-card-foot" onClick={(e) => e.stopPropagation()}>
        {replying ? (
          <div className="pc-reply-box">
            <Form.Control
              as="textarea"
              rows={2}
              size="sm"
              autoFocus
              placeholder="Votre réponse…"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendReply();
                if (e.key === 'Escape') setReplying(false);
              }}
            />
            <div className="pc-compose-row">
              <button type="button" className="cc-btn" onClick={() => setReplying(false)}>
                Annuler
              </button>
              <button type="button" className="cc-btn accent ms-auto" disabled={sending || !replyText.trim()} onClick={() => void sendReply()}>
                Répondre
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="pc-link" onClick={() => setReplying(true)}>
              <i className="bi bi-reply" /> Répondre
            </button>
            {c.resolved ? (
              <button type="button" className="pc-link ms-auto" onClick={() => void onResolve(false)} title={c.resolvedBy ? `Traité par ${c.resolvedBy.name}${c.resolvedAt ? ` ${timeAgo(c.resolvedAt)}` : ''}` : undefined}>
                <i className="bi bi-arrow-counterclockwise" /> Rouvrir
              </button>
            ) : (
              <button type="button" className="pc-link ms-auto pc-resolve" onClick={() => void onResolve(true)}>
                <i className="bi bi-check2-circle" /> Traité
              </button>
            )}
          </>
        )}
      </div>
      {c.version !== pageVersion && <div className="pc-version">Sur la version {c.version}</div>}
    </div>
  );
}

/** Un message de la micro-conversation (le commentaire lui-même ou une réponse), modifiable par son auteur. */
function Message({ comment: c, reply = false, userId, canDelete, onEdit, onDelete }: { comment: SharedPageComment; reply?: boolean; userId: string | null; canDelete: boolean; onEdit: (id: string, body: string) => Promise<unknown>; onDelete: (id: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const mine = userId === c.author.id;
  const save = async () => {
    if (text.trim() && text.trim() !== c.body) await onEdit(c.id, text.trim());
    setEditing(false);
  };
  return (
    <div className={`pc-msg${reply ? ' pc-reply' : ''}`}>
      <Avatar name={c.author.name} agent={c.viaAgent} />
      <div className="pc-msg-main">
        <div className="pc-msg-head">
          <span className="tt-author">{c.author.name}</span>
          {c.viaAgent && <span className="tt-badge-agent">agent</span>}
          <span className="tt-time" title={new Date(c.createdAt).toLocaleString('fr-FR')}>
            {timeAgo(c.createdAt)}
            {c.updatedAt !== c.createdAt && ' · modifié'}
          </span>
          <span className="tt-msg-actions" onClick={(e) => e.stopPropagation()}>
            {mine && !editing && (
              <button type="button" className="tt-icon-btn" title="Modifier" onClick={() => setEditing(true)}>
                <i className="bi bi-pencil" />
              </button>
            )}
            {canDelete && (
              <button type="button" className="tt-icon-btn" title="Supprimer" onClick={() => void onDelete(c.id)}>
                <i className="bi bi-trash" />
              </button>
            )}
          </span>
        </div>
        {editing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <Form.Control
              as="textarea"
              rows={3}
              size="sm"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === 'Escape') {
                  setText(c.body);
                  setEditing(false);
                }
              }}
            />
            <div className="pc-compose-row">
              <button
                type="button"
                className="cc-btn"
                onClick={() => {
                  setText(c.body);
                  setEditing(false);
                }}
              >
                Annuler
              </button>
              <button type="button" className="cc-btn accent ms-auto" disabled={!text.trim()} onClick={() => void save()}>
                Enregistrer
              </button>
            </div>
          </div>
        ) : (
          <div className="pc-body">{c.body}</div>
        )}
      </div>
    </div>
  );
}
