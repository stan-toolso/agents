import { useQuery } from '@apollo/client';
import { Alert, Button } from 'react-bootstrap';
import { useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import UsageReportView, { BudgetMeter, PeriodPicker, useEditBudget, useUsagePeriod } from '../components/UsageReportView';
import { USAGE_PROJECT } from '../graphql/usage';
import { formatCost } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';

interface PageProject {
  id: string;
  name: string;
  description: string | null;
  myRole: 'ADMIN' | 'MEMBER' | 'VIEWER';
  isPersonal: boolean;
  monthlyBudgetUsd: number | null;
  monthUsd: number;
}

/**
 * Onglet « Consommation » d'un projet (tous ses membres) : relevé du projet sur 7, 30 ou 90 jours et son budget
 * mensuel, modifiable par ses administrateurs (au-delà, le projet ne lance plus de session).
 */
export default function ProjectUsagePage() {
  const { id = '' } = useParams();
  const [days, setDays] = useUsagePeriod();
  const { data, loading, error } = useQuery<{ project: PageProject | null }>(USAGE_PROJECT, { variables: { id }, fetchPolicy: 'cache-and-network' });
  const editBudget = useEditBudget();
  const project = data?.project;
  useTabTitle(project ? `Consommation · ${project.name}` : null);
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const isAdmin = project.myRole === 'ADMIN';
  const budget = project.monthlyBudgetUsd;
  return (
    <>
      <ProjectHeader project={project} active="usage" />
      <div className="d-flex align-items-center flex-wrap gap-3 mb-3">
        <div className="d-flex align-items-center gap-2 flex-wrap" style={{ minWidth: 0 }}>
          <span className="text-secondary small">Ce mois-ci : {formatCost(project.monthUsd)}</span>
          {budget ? (
            <div style={{ width: 200 }}>
              <BudgetMeter monthUsd={project.monthUsd} budget={budget} />
            </div>
          ) : (
            <span className="text-secondary small">· aucun budget mensuel</span>
          )}
          {isAdmin && (
            <Button size="sm" variant="outline-secondary" onClick={() => void editBudget(project.id, project.name, budget)}>
              <i className="bi bi-piggy-bank me-1" /> {budget ? 'Modifier le budget' : 'Fixer un budget'}
            </Button>
          )}
        </div>
        <div className="ms-auto">
          <PeriodPicker days={days} onChange={setDays} />
        </div>
      </div>
      {budget != null && project.monthUsd >= budget && (
        <Alert variant="danger" className="py-2">
          <i className="bi bi-exclamation-octagon me-1" /> Budget mensuel atteint : le projet ne lance plus de session ni de tour jusqu’au mois prochain{isAdmin ? ', sauf si vous relevez le budget' : ' (un administrateur du projet peut relever le budget)'}.
        </Alert>
      )}
      <UsageReportView projectId={project.id} days={days} canEditBudget={isAdmin} />
    </>
  );
}
