import { useState } from 'react';
import GoneNotice from '../components/GoneNotice';
import { isGoneError } from '../lib/gone';
import { useMutation } from '@apollo/client';
import { Alert, Button, Dropdown, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import AgentAvatar from '../components/AgentAvatar';
import { useDialogs } from '../components/Dialogs';
import { ProjectPageLoading } from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import TaskModal from '../components/TaskModal';
import CockpitBoard, { CustomizeButton } from '../cockpit/CockpitBoard';
import type { CockpitContext } from '../cockpit/registry';
import { useCockpit } from '../cockpit/useCockpit';
import { RUN_AGENT_ACTION, SUMMON_AGENT } from '../graphql/agents';
import { PROJECT_DASHBOARD, type ProjectDashboard, type ProjectTeamMember } from '../graphql/dashboard';
import type { Project, Task } from '../graphql/operations';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';
import './dashboard.css';
import './conversations.css';

const REFETCH = ['ProjectDashboard'];

interface Data {
  project: (Pick<Project, 'id' | 'name' | 'description' | 'myRole' | 'isPersonal' | 'gitUrl'> & { git: { branch: string; commit: string } | null }) | null;
  projectDashboard: ProjectDashboard;
}

/**
 * Tableau de bord d'un projet (onglet par défaut) : ce qui attend une réponse, le canal général pour parler à l'équipe,
 * qui fait quoi, le flux des tâches par étiquette d'état, le débit, la consommation, les prochaines échéances et
 * l'activité récente. Une seule requête, rafraîchie toutes les 10 s ; le canal se rafraîchit de lui-même. Les blocs et
 * leur ordre sont l'agencement `project:<id>` partagé par l'équipe (cockpit configurable : « Personnaliser »).
 */
export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = usePollingQuery<Data>(PROJECT_DASHBOARD, { variables: { id }, pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const [newTask, setNewTask] = useState(false);
  const { user, costUnit } = useAuth();
  const showCostTile = costUnit === 'CREDIT' || Boolean(user?.isSuperAdmin);
  const project = data?.project ?? null;
  const d = data?.projectDashboard ?? null;
  useTabTitle(project?.name);
  useGitTarget(project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);
  const cockpit = useCockpit(project ? `project:${project.id}` : null);

  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (isGoneError(error) || (!error && !project)) return <GoneNotice what="Ce projet" />;
  if (error && !data) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project || !d) return <Alert variant="warning">Projet introuvable.</Alert>;
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const ctx: CockpitContext = { kind: 'project', viewer: user, showCostTile, home: null, project: { project, d, canWrite }, refetch: REFETCH };

  return (
    <>
      <ProjectHeader
        project={project}
        active="overview"
        actions={
          canWrite ? (
            <>
              <ReleaseButton team={d.team} tasks={d.tasks} />
              <CustomizeButton cockpit={cockpit} />
              <Button size="sm" variant="outline-primary" onClick={() => setNewTask(true)}>
                <i className="bi bi-plus-lg me-1" /> Nouvelle tâche
              </Button>
            </>
          ) : undefined
        }
      />
      {newTask && <TaskModal task={null} projectId={project.id} onClose={() => setNewTask(false)} />}
      {error && <Alert variant="warning" className="py-2 small">Dernier rafraîchissement en échec : {error.message}</Alert>}

      {cockpit.layout ? <CockpitBoard cockpit={cockpit} ctx={ctx} scopeLabel={project.isPersonal ? 'votre espace' : 'le tableau de bord du projet'} /> : <div className="text-secondary small"><Spinner animation="border" size="sm" /> Agencement…</div>}
    </>
  );
}

/** Clé de l'action « Préparer une release » du modèle Product Manager (backend/src/agents/templates.ts). */
const RELEASE_ACTION = 'release';
/** Consigne donnée à un Product Manager qui n'a pas (ou plus) l'action « release » dans sa fiche. */
const RELEASE_FALLBACK =
  "Prépare une release : liste les pull requests fusionnées depuis la dernière release et les tâches qu'elles livrent, crée une tâche « Release du <date> » avec les notes de version, et demande dans son fil l'accord d'un administrateur avant toute mise en production. Suis les conventions de release du projet et de ta bibliothèque de contexte.";

type ReleaseAgent = NonNullable<ProjectTeamMember['agent']>;

/** Agents du projet (actifs) qui savent faire une release : action « release » dans leur fiche, sinon Product Manager. */
function releaseAgents(team: ProjectTeamMember[]): ReleaseAgent[] {
  const agents = team.map((m) => m.agent).filter((a): a is ReleaseAgent => Boolean(a));
  const withAction = agents.filter((a) => a.actions?.some((x) => x.key === RELEASE_ACTION));
  return withAction.length ? withAction : agents.filter((a) => a.kind === 'PRODUCT_MANAGER');
}

/**
 * « Lancer une release » en un clic : convoque l'agent Product Manager du projet avec son action « Préparer une
 * release » (notes de version, tâche de release, accord d'un administrateur dans le fil avant la mise en production),
 * puis ouvre sa session. Invisible sans agent capable ; menu quand il y en a plusieurs ; confirmation seulement si une
 * release semble déjà en cours (tâche « Release… » en cours).
 */
function ReleaseButton({ team, tasks }: { team: ProjectTeamMember[]; tasks: Task[] }) {
  const navigate = useNavigate();
  const { confirm, showError } = useDialogs();
  const [run, { loading: running }] = useMutation<{ runAgentAction: { id: string } }>(RUN_AGENT_ACTION, { refetchQueries: ['Sidebar', 'Sessions', ...REFETCH] });
  const [summon, { loading: summoning }] = useMutation<{ summonAgent: { id: string } }>(SUMMON_AGENT, { refetchQueries: ['Sidebar', 'Sessions', ...REFETCH] });
  const agents = releaseAgents(team);
  if (!agents.length) return null;
  const ongoing = tasks.find((t) => t.status === 'IN_PROGRESS' && /^release\b/i.test(t.title.trim()));
  const busy = running || summoning;

  const launch = async (agent: ReleaseAgent) => {
    if (ongoing && !(await confirm({ title: 'Release déjà en cours', message: `La tâche « ${ongoing.title} » est encore en cours. Lancer quand même une nouvelle release avec ${agent.name} ?`, confirmLabel: 'Lancer quand même' }))) return;
    try {
      const sessionId = agent.actions?.some((a) => a.key === RELEASE_ACTION)
        ? (await run({ variables: { id: agent.id, key: RELEASE_ACTION } })).data?.runAgentAction.id
        : (await summon({ variables: { id: agent.id, text: RELEASE_FALLBACK } })).data?.summonAgent.id;
      if (sessionId) navigate(`/sessions/${sessionId}`);
    } catch (err) {
      showError(err);
    }
  };

  const title = `Convoque ${agents.length === 1 ? agents[0].name : 'un Product Manager'} : notes de version et tâche de release, puis accord d’un administrateur dans le fil avant la mise en production`;
  const icon = busy ? <Spinner animation="border" size="sm" className="me-1" /> : <i className="bi bi-rocket-takeoff me-1" />;
  return (
    <>
      {ongoing && (
        <Link to={`/tasks/${ongoing.id}`} className="btn btn-sm btn-link text-decoration-none" title={ongoing.title}>
          <i className="bi bi-hourglass-split me-1" />Release en cours
        </Link>
      )}
      {agents.length === 1 ? (
        <Button size="sm" variant="outline-success" disabled={busy} onClick={() => void launch(agents[0])} title={title}>
          {icon} Lancer une release
        </Button>
      ) : (
        <Dropdown>
          <Dropdown.Toggle size="sm" variant="outline-success" disabled={busy} title={title}>
            {icon} Lancer une release
          </Dropdown.Toggle>
          <Dropdown.Menu>
            {agents.map((a) => (
              <Dropdown.Item key={a.id} onClick={() => void launch(a)}>
                <AgentAvatar agent={a} size={18} className="me-2" />
                {a.name}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown>
      )}
    </>
  );
}
