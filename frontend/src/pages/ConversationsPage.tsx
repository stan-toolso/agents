import { useMutation } from '@apollo/client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Form, Modal } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AgentAvatar from '../components/AgentAvatar';
import ChannelThread from '../components/ChannelThread';
import ConversationTaskThread from '../components/ConversationTaskThread';
import { useDialogs } from '../components/Dialogs';
import { ProjectPageLoading } from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import { agentKindLabels } from '../graphql/agents';
import { CREATE_CONVERSATION, FOLLOWED_TASK_THREADS, PROJECT_CONVERSATIONS, SET_CONVERSATION_ARCHIVED, UPDATE_CONVERSATION, type Conversation, type FollowedTaskThread } from '../graphql/conversations';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { initialsOf } from '../workbench/WorkspaceTabs';
import { useTabTitle } from '../workbench/TabsContext';
import './conversations.css';

interface Member {
  role: string;
  user: { id: string; name: string; email: string; kind: 'PERSON' | 'AGENT'; lastLoginAt: string | null };
}
interface ProjectAgent {
  id: string;
  name: string;
  kind: 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM';
  description: string;
  enabled: boolean;
  avatar: { emoji: string | null; color: string | null };
}
interface Data {
  project: { id: string; name: string; description: string | null; myRole: 'ADMIN' | 'MEMBER' | 'VIEWER'; isPersonal: boolean; unreadMessages: number; conversations: Conversation[]; members: Member[]; agents: ProjectAgent[] } | null;
}

/** `task-<id>` : le fil d'une tâche ouvert dans l'onglet (fils de tâches suivis). */
const TASK_SLUG = /^task-(.+)$/;

/** Formulaire de création ou de modification d'un canal (nom, sujet). */
function ChannelModal({ projectId, channel, onClose }: { projectId: string; channel: Conversation | null; onClose: (created?: Conversation) => void }) {
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [create, { loading: creating, error: createError }] = useMutation<{ createConversation: Conversation }>(CREATE_CONVERSATION, { refetchQueries: ['ProjectConversations'] });
  const [update, { loading: updating, error: updateError }] = useMutation<{ updateConversation: Conversation }>(UPDATE_CONVERSATION, { refetchQueries: ['ProjectConversations', 'ConversationMessages'] });
  const error = createError ?? updateError;
  const general = channel?.slug === 'general';
  const submit = async () => {
    if (!name.trim() && !general) return;
    if (channel) {
      const res = await update({ variables: { id: channel.id, name: general ? null : name, topic } }).catch(() => null);
      if (res?.data) onClose(res.data.updateConversation);
    } else {
      const res = await create({ variables: { projectId, name, topic } }).catch(() => null);
      if (res?.data) onClose(res.data.createConversation);
    }
  };
  return (
    <Modal show onHide={() => onClose()} centered>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">{channel ? `Modifier #${channel.slug}` : 'Nouveau canal'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Nom</Form.Label>
            <Form.Control autoFocus={!channel} value={name} disabled={general} placeholder="livraisons, idées, support…" maxLength={60} onChange={(e) => setName(e.target.value)} />
            {general && <Form.Text>Le canal général ne se renomme pas.</Form.Text>}
          </Form.Group>
          <Form.Group>
            <Form.Label>Sujet</Form.Label>
            <Form.Control value={topic} placeholder="De quoi parle-t-on ici ?" maxLength={250} onChange={(e) => setTopic(e.target.value)} />
          </Form.Group>
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => onClose()}>
            Annuler
          </Button>
          <Button type="submit" disabled={creating || updating || (!general && !name.trim())}>
            {channel ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/**
 * Hauteur du cadre du canal : jusqu'au bas de la fenêtre depuis sa position réelle (l'en-tête du projet change de
 * hauteur avec la description et la largeur), pour que seul le fil défile et que la zone de saisie reste visible.
 */
function useFillHeight<T extends HTMLElement>(ready: boolean) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!ready || !el) return;
    const measure = () => {
      if (!el.offsetParent) return; // onglet caché : on mesurera à son retour (le ResizeObserver le signale)
      const box = el.getBoundingClientRect();
      // La page peut avoir défilé : on mesure depuis le haut du contenu, pas depuis la vue.
      let top = box.top;
      for (let p = el.parentElement; p; p = p.parentElement) top += p.scrollTop;
      setHeight(Math.max(360, Math.floor(window.innerHeight - top - 16)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ready]);
  return { ref, height };
}

/**
 * Page Conversations d'un projet : la liste des canaux à gauche (non-lus en évidence), le canal ouvert au centre avec
 * ses fils, et à droite qui est là (membres et agents, à mentionner d'un clic). Route /projects/:id/conversations/:slug?
 * (le général par défaut) ; `#m-<id>` amène à un message. Sous les canaux, les fils de tâches que je suis (j'y ai
 * écrit, réagi ou été mentionné, ou je suis responsable ou rapporteur de la tâche) : `task-<id>` ouvre le fil de la
 * tâche au centre, le même que sur sa page.
 */
export default function ConversationsPage() {
  const { id = '', slug } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = usePollingQuery<Data>(PROJECT_CONVERSATIONS, { variables: { id, includeArchived: true }, pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const [editing, setEditing] = useState<{ channel: Conversation | null } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { confirm, showError } = useDialogs();
  const fill = useFillHeight<HTMLDivElement>(Boolean(data?.project));
  const [setArchived] = useMutation(SET_CONVERSATION_ARCHIVED, { refetchQueries: ['ProjectConversations'], onError: (e) => void showError(e) });
  const { data: followedData } = usePollingQuery<{ project: { id: string; followedTaskThreads: FollowedTaskThread[] } | null }>(FOLLOWED_TASK_THREADS, { variables: { id }, pollInterval: 30_000 });
  const [showTasks, setShowTasks] = useState(true);
  const project = data?.project ?? null;
  const channels = useMemo(() => project?.conversations ?? [], [project]);
  const followed = followedData?.project?.followedTaskThreads ?? [];
  // Un canal qui s'appellerait « task-… » garde la priorité.
  const taskId = slug && !channels.some((c) => c.slug === slug) ? (TASK_SLUG.exec(slug)?.[1] ?? null) : null;
  const current = useMemo(() => (taskId ? null : (channels.find((c) => c.slug === (slug ?? 'general')) ?? channels.find((c) => c.slug === 'general') ?? channels[0] ?? null)), [channels, slug, taskId]);
  const currentTask = taskId ? followed.find((t) => t.task.id === taskId) : undefined;
  useTabTitle(current ? `#${current.slug}` : currentTask ? currentTask.task.title : 'Conversations');
  // Un slug inconnu ramène au canal général.
  useEffect(() => {
    if (project && slug && !taskId && channels.length && !channels.some((c) => c.slug === slug)) navigate(`/projects/${id}/conversations`, { replace: true });
  }, [project, slug, taskId, channels, id, navigate]);

  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (error && !data) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  if (project.isPersonal) return <Alert variant="info">L'espace personnel n'a pas de canaux : ses chats en tiennent lieu.</Alert>;
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const isAdmin = project.myRole === 'ADMIN';
  const active = channels.filter((c) => !c.archivedAt);
  const archived = channels.filter((c) => c.archivedAt);
  const people = project.members.filter((m) => m.user.kind !== 'AGENT');
  const agents = project.agents.filter((a) => a.enabled);

  return (
    <>
      <ProjectHeader
        project={project}
        active="conversations"
        actions={
          canWrite ? (
            <Button size="sm" variant="outline-primary" onClick={() => setEditing({ channel: null })}>
              <i className="bi bi-plus-lg me-1" /> Canal
            </Button>
          ) : undefined
        }
      />
      {editing && <ChannelModal projectId={project.id} channel={editing.channel} onClose={(created) => { setEditing(null); if (created && !editing.channel) navigate(`/projects/${id}/conversations/${created.slug}`); }} />}

      <div className="ch-wrap">
      <div className="ch-layout" ref={fill.ref} style={fill.height ? ({ '--ch-height': `${fill.height}px` } as React.CSSProperties) : undefined}>
        <aside className="ch-channels">
          <div className="ch-side-title">Canaux</div>
          <ul className="ch-channel-list">
            {active.map((c) => (
              <li key={c.id}>
                <Link to={`/projects/${id}/conversations/${c.slug}`} className={`ch-channel${current?.id === c.id ? ' active' : ''}${c.unreadCount ? ' unread' : ''}`} title={c.topic || undefined}>
                  <span className="ch-hash">#</span>
                  <span className="ch-channel-name">{c.slug}</span>
                  {c.unreadCount > 0 && <Badge bg="primary" pill className="ch-unread">{c.unreadCount}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
          {archived.length > 0 && (
            <>
              <button type="button" className="ch-side-toggle" onClick={() => setShowArchived((s) => !s)}>
                <i className={`bi ${showArchived ? 'bi-chevron-down' : 'bi-chevron-right'}`} /> {archived.length} archivé{archived.length > 1 ? 's' : ''}
              </button>
              {showArchived && (
                <ul className="ch-channel-list">
                  {archived.map((c) => (
                    <li key={c.id}>
                      <Link to={`/projects/${id}/conversations/${c.slug}`} className={`ch-channel archived${current?.id === c.id ? ' active' : ''}`}>
                        <span className="ch-hash">#</span>
                        <span className="ch-channel-name">{c.slug}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {canWrite && (
            <button type="button" className="ch-side-toggle" onClick={() => setEditing({ channel: null })}>
              <i className="bi bi-plus" /> Nouveau canal
            </button>
          )}
          {followed.length > 0 && (
            <div className="ch-task-threads">
              <button type="button" className="ch-side-title ch-side-title-toggle" onClick={() => setShowTasks((v) => !v)} title="Fils des tâches où vous avez écrit, réagi ou été mentionné, et des tâches dont vous êtes responsable ou rapporteur">
                <i className={`bi ${showTasks ? 'bi-chevron-down' : 'bi-chevron-right'}`} /> Fils de tâches
              </button>
              {showTasks && (
                <ul className="ch-channel-list">
                  {followed.map((t) => (
                    <li key={t.id}>
                      <Link to={`/projects/${id}/conversations/${t.slug}`} className={`ch-channel ch-task-thread${taskId === t.task.id ? ' active' : ''}${t.task.status === 'DONE' || t.task.status === 'CANCELLED' ? ' archived' : ''}`} title={`${t.task.title} · ${t.messageCount} message${t.messageCount > 1 ? 's' : ''}${t.lastMessageAt ? ` · ${timeAgo(t.lastMessageAt)}` : ''}`}>
                        <i className="bi bi-check2-square ch-hash" />
                        <span className="ch-channel-name">{t.task.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>

        <section className="ch-main">
          {taskId ? (
            <ConversationTaskThread key={taskId} taskId={taskId} canWrite={canWrite} />
          ) : current ? (
            <>
              <div className="ch-head">
                <div className="ch-head-title">
                  <span className="ch-hash">#</span>
                  {current.slug}
                  {current.archivedAt && (
                    <Badge bg="secondary" className="ms-2">
                      archivé
                    </Badge>
                  )}
                </div>
                <div className="ch-head-topic">{current.topic || <span className="text-secondary">Pas de sujet.</span>}</div>
                <div className="ch-head-actions">
                  {canWrite && (
                    <Button size="sm" variant="link" className="text-secondary p-0" title="Modifier le nom ou le sujet" onClick={() => setEditing({ channel: current })}>
                      <i className="bi bi-pencil" />
                    </Button>
                  )}
                  {isAdmin && current.slug !== 'general' && (
                    <Button
                      size="sm"
                      variant="link"
                      className="text-secondary p-0"
                      title={current.archivedAt ? 'Rouvrir le canal' : 'Archiver le canal'}
                      onClick={async () => {
                        if (current.archivedAt || (await confirm({ title: 'Archiver le canal', message: `Archiver #${current.slug} ? Il reste lisible, sans nouveau message.`, confirmLabel: 'Archiver' }))) setArchived({ variables: { id: current.id, archived: !current.archivedAt } });
                      }}
                    >
                      <i className={`bi ${current.archivedAt ? 'bi-arrow-counterclockwise' : 'bi-archive'}`} />
                    </Button>
                  )}
                </div>
              </div>
              <div className="ch-body ch-scroll">
                <ChannelThread key={current.id} conversationId={current.id} canWrite={canWrite} />
              </div>
            </>
          ) : (
            <div className="text-secondary p-3">Aucun canal.</div>
          )}
        </section>

        <aside className="ch-people">
          <div className="ch-side-title">Qui est là</div>
          <ul className="ch-people-list">
            {agents.map((a) => (
              <li key={a.id} title={a.description || undefined}>
                <Link to={`/projects/${id}/agents/${a.id}`} className="ch-person">
                  <AgentAvatar agent={a} size={22} />
                  <span className="ch-person-name">{a.name}</span>
                  <span className="ch-person-detail">{agentKindLabels[a.kind]}</span>
                </Link>
              </li>
            ))}
            {people.map((m) => (
              <li key={m.user.id}>
                <span className="ch-person">
                  <span className="ch-initials">{initialsOf(m.user.name || m.user.email)}</span>
                  <span className="ch-person-name">{m.user.name || m.user.email}</span>
                  <span className="ch-person-detail">{m.user.lastLoginAt ? timeAgo(m.user.lastLoginAt) : ''}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="ch-side-hint">
            Mentionnez une personne (<code>@Nom</code>) pour la prévenir ; mentionnez un agent pour qu'il réponde dans le fil.
          </div>
        </aside>
      </div>
      </div>
    </>
  );
}
