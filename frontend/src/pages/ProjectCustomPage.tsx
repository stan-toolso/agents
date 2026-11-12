import { useQuery } from '@apollo/client';
import { Alert, Spinner } from 'react-bootstrap';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import CockpitBoard, { CustomizeButton } from '../cockpit/CockpitBoard';
import type { CockpitContext } from '../cockpit/registry';
import { useCockpit } from '../cockpit/useCockpit';
import GoneNotice from '../components/GoneNotice';
import { ProjectPageLoading } from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import { PROJECT_TABS, type ProjectPageInfo, type ProjectTabsSetting } from '../graphql/cockpit';
import { PROJECT_DASHBOARD, type ProjectDashboard } from '../graphql/dashboard';
import type { Project } from '../graphql/operations';
import { isGoneError } from '../lib/gone';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';
import './dashboard.css';
import './conversations.css';

interface Data {
  project: (Pick<Project, 'id' | 'name' | 'description' | 'myRole' | 'isPersonal' | 'gitUrl'> & { git: { branch: string; commit: string } | null }) | null;
  projectDashboard: ProjectDashboard;
}

/**
 * Page personnalisée d'un projet (/projects/<id>/p/<slug>) : un onglet de plus dont le contenu est l'agencement de la
 * portée `project:<id>:page:<slug>`, vide au départ. Les mêmes blocs que le tableau de bord y sont disponibles (même
 * requête de données), plus les artefacts épinglés : une page « Reporting client » peut n'être qu'un artefact en pleine
 * largeur, ou une composition.
 */
export default function ProjectCustomPage() {
  const { id = '', slug = '' } = useParams();
  const { data, loading, error } = usePollingQuery<Data>(PROJECT_DASHBOARD, { variables: { id }, pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const { data: tabsData } = useQuery<{ project: { id: string; tabs: ProjectTabsSetting | null; pages: ProjectPageInfo[] } | null }>(PROJECT_TABS, { variables: { id } });
  const { user, costUnit } = useAuth();
  const showCostTile = costUnit === 'CREDIT' || Boolean(user?.isSuperAdmin);
  const project = data?.project ?? null;
  const d = data?.projectDashboard ?? null;
  const page = tabsData?.project?.pages.find((p) => p.slug === slug) ?? null;
  useTabTitle(page ? `${page.title} · ${project?.name ?? ''}` : project?.name);
  useGitTarget(project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);
  const cockpit = useCockpit(project && page ? `project:${project.id}:page:${slug}` : null);

  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (isGoneError(error) || (!error && !project)) return <GoneNotice what="Ce projet" />;
  if (error && !data) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project || !d) return <Alert variant="warning">Projet introuvable.</Alert>;
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const ctx: CockpitContext = { kind: 'project', viewer: user, showCostTile, home: null, project: { project, d, canWrite }, refetch: ['ProjectDashboard'] };

  return (
    <>
      <ProjectHeader project={project} active={`page:${slug}`} actions={canWrite ? <CustomizeButton cockpit={cockpit} /> : undefined} />
      {tabsData && !page ? (
        <Alert variant="warning">Cette page n’existe pas (ou plus) dans ce projet.</Alert>
      ) : cockpit.layout ? (
        <>
          {cockpit.layout.blocks.length === 0 && !cockpit.editing && (
            <div className="text-secondary small mb-3">
              Page vide pour l’instant{canWrite ? ' : « Personnaliser » pour y placer des blocs natifs ou des artefacts, ou demandez-le à un agent (outil cockpit, portée ' : ''}
              {canWrite && <code>page:{slug}</code>}
              {canWrite ? ').' : '.'}
            </div>
          )}
          <CockpitBoard cockpit={cockpit} ctx={ctx} scopeLabel={`la page « ${page?.title ?? slug} »`} />
        </>
      ) : (
        <div className="text-secondary small"><Spinner animation="border" size="sm" /> Agencement…</div>
      )}
    </>
  );
}
