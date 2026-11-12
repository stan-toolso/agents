import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Form } from 'react-bootstrap';
import { Link, useLocation } from 'react-router-dom';
import ChannelThread from '../components/ChannelThread';
import { PROJECT_CONVERSATIONS, UNREAD_MESSAGES_BY_PROJECT, type Conversation } from '../graphql/conversations';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useShortcut } from '../lib/useShortcut';
import { useTabs } from './TabsContext';
import '../pages/conversations.css';
import { projectWindowId } from '../lib/projectWindow';

const OPEN_KEY = 'skipper.messages.open';
const PROJECT_KEY = 'skipper.messages.project';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

interface UnreadData {
  unreadMessagesByProject: { count: number; project: { id: string; name: string } }[];
}
interface ProjectData {
  project: { id: string; myRole: 'ADMIN' | 'MEMBER' | 'VIEWER'; isPersonal: boolean; conversations: Conversation[] } | null;
}

/** Le contenu du panneau : sélecteur de projet, canaux en pastilles avec leurs non-lus, et le canal choisi. */
function Panel({ projects, projectId, onProject, onClose }: { projects: UnreadData['unreadMessagesByProject']; projectId: string; onProject: (id: string) => void; onClose: () => void }) {
  const { data } = usePollingQuery<ProjectData>(PROJECT_CONVERSATIONS, { variables: { id: projectId, includeArchived: false }, pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const project = data?.project?.id === projectId ? data.project : null;
  const channels = useMemo(() => (project?.conversations ?? []).filter((c) => !c.archivedAt), [project]);
  const [slugByProject, setSlugByProject] = useState<Record<string, string>>({});
  const current = channels.find((c) => c.slug === slugByProject[projectId]) ?? channels.find((c) => c.slug === 'general') ?? channels[0] ?? null;
  const canWrite = project?.myRole === 'ADMIN' || project?.myRole === 'MEMBER';

  return (
    <aside className="msg-panel" aria-label="Messages">
      <div className="msg-head">
        <i className="bi bi-chat-square-text" />
        <Form.Select size="sm" className="msg-project" value={projectId} onChange={(e) => onProject(e.target.value)} aria-label="Projet">
          {projects.map((p) => (
            <option key={p.project.id} value={p.project.id}>
              {p.project.name}
              {p.count > 0 ? ` (${p.count})` : ''}
            </option>
          ))}
        </Form.Select>
        {current && (
          <Link to={`/projects/${projectId}/conversations/${current.slug}`} className="msg-icon-btn" title="Ouvrir la page Conversations du projet" onClick={onClose}>
            <i className="bi bi-arrows-angle-expand" />
          </Link>
        )}
        <button type="button" className="msg-icon-btn" title="Fermer (Échap)" aria-label="Fermer les messages" onClick={onClose}>
          <i className="bi bi-x-lg" />
        </button>
      </div>
      {channels.length > 1 && (
        <div className="msg-channels">
          {channels.map((c) => (
            <button key={c.id} type="button" className={`msg-channel${current?.id === c.id ? ' active' : ''}${c.unreadCount ? ' unread' : ''}`} title={c.topic || undefined} onClick={() => setSlugByProject((s) => ({ ...s, [projectId]: c.slug }))}>
              <span className="ch-hash">#</span>
              {c.slug}
              {c.unreadCount > 0 && current?.id !== c.id && (
                <Badge bg="primary" pill className="ch-unread ms-1">
                  {c.unreadCount}
                </Badge>
              )}
            </button>
          ))}
        </div>
      )}
      {current?.topic && <div className="msg-topic">{current.topic}</div>}
      <div className="msg-body ch-scroll">
        {current ? <ChannelThread key={current.id} conversationId={current.id} canWrite={canWrite} compact /> : <div className="text-secondary p-3">{data ? 'Aucun canal.' : 'Chargement…'}</div>}
      </div>
    </aside>
  );
}

/**
 * Bouton « Messages » de la barre du haut, présent sur toutes les pages : le total des non-lus des canaux de mes
 * projets, et un panneau latéral (non modal : on continue à travailler à côté) qui ouvre le canal du projet affiché,
 * ou celui qui a le plus de non-lus, ou le dernier consulté. Raccourci Alt+M.
 */
export default function MessagesButton() {
  const location = useLocation();
  const { activeKey, workspaces } = useTabs();
  const [open, setOpenState] = useState(() => read(OPEN_KEY) === '1');
  const setOpen = (v: boolean) => {
    setOpenState(v);
    write(OPEN_KEY, v ? '1' : '0');
  };
  const { data } = usePollingQuery<UnreadData>(UNREAD_MESSAGES_BY_PROJECT, { pollInterval: open ? 10_000 : 30_000 });
  // Fenêtre dédiée à un projet : seulement ses canaux.
  const projects = useMemo(() => [...(data?.unreadMessagesByProject ?? [])].filter((p) => !projectWindowId || p.project.id === projectWindowId).sort((a, b) => a.project.name.localeCompare(b.project.name)), [data]);
  const total = projects.reduce((n, p) => n + p.count, 0);
  const [chosen, setChosen] = useState<string | null>(() => read(PROJECT_KEY));

  // Le projet affiché (page ou onglet actif) devient celui du panneau.
  const shownProject = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? (activeKey ? workspaces.get(activeKey)?.projectId : undefined) ?? null;
  // Seulement quand on change de page : un choix fait dans le panneau tient jusqu'à la navigation suivante.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!shownProject || applied.current === shownProject || !projects.some((p) => p.project.id === shownProject)) return;
    applied.current = shownProject;
    setChosen(shownProject);
  }, [shownProject, projects]);

  const projectId = useMemo(() => {
    if (chosen && projects.some((p) => p.project.id === chosen)) return chosen;
    const unread = [...projects].sort((a, b) => b.count - a.count)[0];
    return unread?.project.id ?? null;
  }, [chosen, projects]);

  useShortcut({ id: 'messages.toggle', keys: ['alt+code:KeyM'], label: 'Ouvrir ou fermer les messages', scope: 'global', area: 'Messages' }, () => setOpen(!open));
  useShortcut({ id: 'messages.close', keys: ['Escape'], label: 'Fermer les messages', scope: 'context', area: 'Messages', preventDefault: false }, () => setOpen(false), open);

  if (data && projects.length === 0) return null;
  return (
    <>
      <button type="button" className={`wb-bell-btn${open ? ' open' : ''}`} title={total ? `Messages : ${total} non lu${total > 1 ? 's' : ''} (Alt+M)` : 'Messages des canaux (Alt+M)'} aria-label="Messages" onClick={() => setOpen(!open)}>
        <i className="bi bi-chat-square-text" />
        {total > 0 && <span className="wb-bell-count">{total > 99 ? '99+' : total}</span>}
      </button>
      {open && projectId && (
        <Panel
          projects={projects}
          projectId={projectId}
          onProject={(id) => {
            setChosen(id);
            write(PROJECT_KEY, id);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
