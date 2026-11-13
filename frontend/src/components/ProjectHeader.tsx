import type { ReactNode } from 'react';
import { Badge, Button, Nav } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { PROJECT_UNREAD_MESSAGES } from '../graphql/conversations';
import { PROJECT_TABS, type ProjectPageInfo, type ProjectTabsSetting } from '../graphql/cockpit';
import { effectiveTabs } from '../lib/projectTabs';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useSessionLauncher } from './SessionLauncher';
import { openProjectWindow, projectWindowId } from '../lib/projectWindow';

export type ProjectTab = 'overview' | 'conversations' | 'chats' | 'repo' | 'files' | 'tasks' | 'artifacts' | 'agents' | 'pullRequests' | 'deliveries' | 'context' | 'vault' | 'env' | 'schedules' | 'workflows' | 'history' | 'audit' | 'usage' | 'members' | 'settings' | `page:${string}`;

export const TABS: { key: ProjectTab; label: string; path: string; icon: string; title?: string; absolute?: boolean }[] = [
  { key: 'overview', label: 'Tableau de bord', path: '', icon: 'bi-speedometer2', title: 'Ce qui attend une réponse, l’équipe au travail, le flux des tâches et la consommation du projet' },
  { key: 'conversations', label: 'Conversations', path: '/conversations', icon: 'bi-chat-left-text', title: 'Canaux de conversation d’équipe : mentionnez les personnes et les agents du projet, qui répondent dans le fil' },
  { key: 'repo', label: 'Dépôt', path: '/repo', icon: 'bi-code-square', title: 'Dépôt git : branches, commits et fichiers ; dépôt hébergé par Skipper et ses sauvegardes' },
  { key: 'files', label: 'Fichiers', path: '/files', icon: 'bi-folder2-open', title: 'Dossier du projet sur le serveur : parcourir, lire et modifier ses fichiers (projets sans dépôt git ; ceux d’un dépôt se lisent dans Dépôt)' },
  { key: 'tasks', label: 'Tâches', path: '/tasks', icon: 'bi-check2-square' },
  { key: 'artifacts', label: 'Artefacts', path: '/artifacts', icon: 'bi-collection', title: 'Artefacts du projet : pages, tableaux de bord et diapositives publiés par les agents ; en créer un, en mettre en favori' },
  { key: 'agents', label: 'Agents', path: '/agents', icon: 'bi-robot', title: 'Agents du projet (Product Manager, Developer…) : membres qui ne sont pas des personnes, avec leurs comptes, instructions et déclencheurs' },
  { key: 'pullRequests', label: 'Pull requests', path: '/pull-requests', icon: 'bi-git', title: 'Pull requests suivies : à fusionner, fusionnées' },
  { key: 'deliveries', label: 'Livraisons', path: '/deliveries', icon: 'bi-rocket-takeoff', title: 'Livraisons et déploiements : CI de la branche principale, mise en production sous verrou, historique (qui, quel commit, durée, résultat)' },
  { key: 'context', label: 'Contexte', path: '/context', icon: 'bi-journal-text', title: 'Bibliothèque d’instructions consultée par les agents' },
  { key: 'vault', label: 'Coffre', path: '/vault', icon: 'bi-shield-lock', title: 'Serveurs, bases, API, sites et comptes utilisables par les agents' },
  { key: 'env', label: 'Environnement', path: '/env', icon: 'bi-file-earmark-lock', title: 'Fichiers .env (ou autres) écrits dans chaque nouvelle session, avec des valeurs du coffre' },
  { key: 'schedules', label: 'Planifications', path: '/schedules', icon: 'bi-alarm', title: 'Sessions relancées à heures fixes : prochaines échéances, historique des exécutions' },
  { key: 'workflows', label: 'Workflows', path: '/workflows', icon: 'bi-diagram-3', title: 'Workflows : enchaînements d’appels de modèle, de sessions et de tâches' },
  { key: 'history', label: 'Historique', path: '/history', icon: 'bi-clock-history', title: 'Sessions et work sessions archivées' },
  { key: 'usage', label: 'Consommation', path: '/usage', icon: 'bi-bar-chart-line', title: 'Coût du projet par jour, semaine, modèle et session ; budget mensuel' },
  { key: 'audit', label: 'Journal', path: '/audit', icon: 'bi-list-check', title: 'Journal d’audit : qui a fait quoi, personnes et agents (sessions, demandes, tâches, membres, coffre, git…), avec filtres et export CSV' },
  { key: 'members', label: 'Membres', path: '/members', icon: 'bi-people', title: 'Personnes et agents du projet : rôles, invitations par e-mail, retraits' },
  { key: 'settings', label: 'Réglages', path: '/settings', icon: 'bi-gear', title: 'Dossier de travail, instructions permanentes, autorisations mémorisées, conteneur, clés d’API' },
];

/** Non-lus des canaux du projet, sur l'onglet Conversations (relevé toutes les 30 s). */
function UnreadBadge({ projectId }: { projectId: string }) {
  const { data } = usePollingQuery<{ project: { id: string; unreadMessages: number } | null }>(PROJECT_UNREAD_MESSAGES, { variables: { id: projectId }, pollInterval: 30_000 });
  const n = data?.project?.unreadMessages ?? 0;
  if (!n) return null;
  return (
    <Badge bg="primary" pill className="ms-1 project-tab-badge">
      {n}
    </Badge>
  );
}

/** Onglets d'un invité du projet (conversations et artefacts partagés seulement) : les conversations, rien d'autre. */
const GUEST_TABS: typeof TABS = TABS.filter((t) => t.key === 'conversations');

/** Onglets de l'espace personnel : pas de workflows, mais les chats (qui ont leur propre page). */
const PERSONAL_TABS: typeof TABS = [
  { key: 'overview', label: 'Aperçu', path: '', icon: 'bi-person-circle' },
  { key: 'chats', label: 'Chats', path: '/chats', icon: 'bi-chat-left-text', title: 'Conversations légères, sans dossier de travail, avec accès à tous vos projets', absolute: true },
  ...TABS.filter((t) => t.key === 'files' || t.key === 'tasks' || t.key === 'artifacts' || t.key === 'schedules' || t.key === 'context' || t.key === 'vault' || t.key === 'env' || t.key === 'history'),
];

export interface ProjectHeaderProject {
  id: string;
  name: string;
  description?: string | null;
  myRole?: 'ADMIN' | 'MEMBER' | 'VIEWER' | 'GUEST';
  /** Espace personnel : en-tête « Mon espace personnel », sans retour aux projets, onglets propres. */
  isPersonal?: boolean;
}

/**
 * En-tête commun des pages d'un projet : retour à la liste, nom, description, actions (nouvelle session, modifier,
 * actions propres à la page), puis la barre d'onglets qui mène aux pages du projet (aperçu, tâches, contexte, coffre…).
 * Les onglets sont des liens : chaque page garde sa route et son onglet du workbench.
 */
export default function ProjectHeader({ project, active, actions }: { project: ProjectHeaderProject; active: ProjectTab; actions?: ReactNode }) {
  const { openNewSession } = useSessionLauncher();
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const guest = project.myRole === 'GUEST';
  const personal = Boolean(project.isPersonal);
  // Onglets masqués, ordre et pages personnalisées : une requête légère, partagée par toutes les pages du projet (cache).
  // Pas pour un invité (ces champs lui sont fermés) : il n'a que les conversations.
  const { data: tabsData } = useQuery<{ project: { id: string; gitUrl: string | null; tabs: ProjectTabsSetting | null; pages: ProjectPageInfo[] } | null }>(PROJECT_TABS, { variables: { id: project.id }, skip: personal || guest, fetchPolicy: 'cache-first' });
  // « Fichiers » : seulement pour un projet sans dépôt git (sinon « Dépôt » montre les fichiers, et le checkout principal n'est pas où l'on travaille).
  const projectTabs = tabsData?.project && !tabsData.project.gitUrl ? TABS : TABS.filter((t) => t.key !== 'files');
  const tabs = personal ? PERSONAL_TABS : guest ? GUEST_TABS : effectiveTabs(projectTabs, tabsData?.project?.tabs, tabsData?.project?.pages ?? []);
  return (
    <>
      <div className="d-flex align-items-start justify-content-between flex-wrap gap-2 mb-2">
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          {personal ? (
            <Link to="/" className="small">
              ← Tableau de bord
            </Link>
          ) : projectWindowId || guest ? null : (
            <Link to="/projects" className="small">
              ← Projets
            </Link>
          )}
          <h1 className="h3 mb-0">{personal ? 'Mon espace personnel' : project.name}</h1>
          {personal ? <div className="text-secondary">Vos sessions, chats et tâches, à vous seul ; les agents y ont accès à tous vos projets.</div> : project.description && <div className="text-secondary">{project.description}</div>}
        </div>
        <div className="d-flex gap-2 flex-wrap align-items-center">
          {canWrite && (
            <Button size="sm" onClick={() => openNewSession({ projectId: project.id })}>
              <i className="bi bi-plus-lg me-1" /> Nouvelle session
            </Button>
          )}
          {!personal && !projectWindowId && !guest && (
            <Button size="sm" variant="outline-secondary" onClick={() => openProjectWindow(project.id)} title="Ouvrir dans une nouvelle fenêtre dédiée à ce projet : sidebar, notifications, messages et recherche limités au projet" aria-label="Ouvrir dans une nouvelle fenêtre">
              <i className="bi bi-window-plus" />
            </Button>
          )}
          {project.myRole === 'ADMIN' && (
            <Button as={Link as any} to={`/projects/${project.id}/edit`} size="sm" variant="outline-secondary">
              Modifier
            </Button>
          )}
          {actions}
        </div>
      </div>
      <Nav variant="tabs" className="project-tabs mb-3" activeKey={active}>
        {tabs.map((t) => (
          <Nav.Item key={t.key}>
            <Nav.Link as={Link as any} to={t.absolute ? t.path : `/projects/${project.id}${t.path}`} eventKey={t.key} title={t.title}>
              <i className={`bi ${t.icon} me-1`} />
              {t.label}
              {t.key === 'conversations' && !personal && <UnreadBadge projectId={project.id} />}
            </Nav.Link>
          </Nav.Item>
        ))}
      </Nav>
    </>
  );
}
