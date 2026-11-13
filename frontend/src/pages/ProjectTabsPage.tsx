import { useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { Alert } from 'react-bootstrap';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import ProjectTabsCard from '../cockpit/ProjectTabsCard';
import PageLoading from '../components/PageLoading';
import { PROJECT_CONFIG_SHELL } from '../graphql/projectConfig';
import { useTabTitle } from '../workbench/TabsContext';

/** Configuration › Onglets et pages : onglets affichés dans le projet, leur ordre, et les pages personnalisées. */
export default function ProjectTabsPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ project: ProjectHeaderProject | null }>(PROJECT_CONFIG_SHELL, { variables: { id }, fetchPolicy: 'cache-first' });
  const project = data?.project;
  useTabTitle(project ? `Onglets et pages · ${project.name}` : 'Onglets et pages');
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  return (
    <>
      <ProjectHeader project={project} active="pages" />
      <ProjectTabsCard projectId={project.id} canManage={project.myRole === 'ADMIN'} />
    </>
  );
}
