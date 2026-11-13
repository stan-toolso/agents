import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Card } from 'react-bootstrap';
import { useParams } from 'react-router-dom';
import { DeliveryQualityPanel, DeliveryTable, DeployConfigModal } from '../components/Deliveries';
import { DeliveryPolicyCard } from '../components/DeliveryPolicy';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import { CI_STATUS, DELIVERIES, DELIVERIES_PROJECT, DEPLOY_CONFIG, REQUEST_DEPLOY, type CiStatus, type Delivery, type DeployConfig } from '../graphql/deliveries';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

type PageProject = ProjectHeaderProject & { gitUrl: string | null; gitBranch: string | null };
type Kind = 'all' | 'merge' | 'deploy';

const CI_LABELS: Record<CiStatus['verdict'], { label: string; variant: string; icon: string }> = {
  success: { label: 'verte', variant: 'success', icon: 'bi-check-circle' },
  failure: { label: 'rouge', variant: 'danger', icon: 'bi-x-circle' },
  pending: { label: 'en cours', variant: 'warning', icon: 'bi-hourglass-split' },
  none: { label: 'aucun check', variant: 'secondary', icon: 'bi-dash-circle' },
};

/**
 * Livraisons d'un projet : état de la CI de la branche déployée, bouton « Déployer » (administrateurs, sous verrou,
 * seulement après CI verte, demandes regroupées), configuration de la commande, et historique des livraisons
 * (« Livrer » des sessions et tâches) et des déploiements.
 */
export default function ProjectDeliveriesPage() {
  const { id = '' } = useParams();
  const { showError } = useDialogs();
  const projectQ = useQuery<{ project: PageProject | null }>(DELIVERIES_PROJECT, { variables: { id } });
  const project = projectQ.data?.project;
  const [kind, setKind] = useState<Kind>('all');
  const [configuring, setConfiguring] = useState(false);
  const configQ = useQuery<{ deployConfig: DeployConfig | null }>(DEPLOY_CONFIG, { variables: { projectId: id } });
  const config = configQ.data?.deployConfig ?? null;
  const branch = config?.branch || project?.gitBranch || 'main';
  const ciQ = usePollingQuery<{ ciStatus: CiStatus }>(CI_STATUS, { variables: { projectId: id, ref: branch }, pollInterval: 30_000, skip: !project?.gitUrl || !/github\.com/i.test(project.gitUrl) });
  const deliveriesQ = usePollingQuery<{ deliveries: Delivery[] }>(DELIVERIES, { variables: { projectId: id, kind: kind === 'all' ? null : kind, limit: 100 }, pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const [requestDeploy, { loading: requesting }] = useMutation(REQUEST_DEPLOY, { refetchQueries: ['Deliveries'] });
  useTabTitle(project ? `Livraisons · ${project.name}` : null);

  if (projectQ.loading && !project) return <PageLoading />;
  if (projectQ.error) return <Alert variant="danger">Erreur : {projectQ.error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const admin = project.myRole === 'ADMIN';
  const deliveries = deliveriesQ.data?.deliveries ?? [];
  const runningDeploy = deliveries.find((d) => d.kind === 'DEPLOY' && d.status === 'RUNNING');
  const queuedDeploy = deliveries.find((d) => d.kind === 'DEPLOY' && d.status === 'QUEUED');
  const ci = ciQ.data?.ciStatus;
  const ciLabel = ci ? (CI_LABELS[ci.verdict] ?? CI_LABELS.none) : null;

  const deploy = async () => {
    try {
      await requestDeploy({ variables: { projectId: id } });
    } catch (err) {
      void showError(err as Error);
    }
  };

  return (
    <>
      <ProjectHeader project={project} active="deliveries" />
      {!project.gitUrl ? (
        <Alert variant="secondary">Ce projet n'est pas relié à un dépôt git : rien à livrer.</Alert>
      ) : (
        <Card className="mb-3 deploy-card">
          <Card.Body className="d-flex flex-wrap gap-3 align-items-center">
            <div className="flex-grow-1" style={{ minWidth: 240 }}>
              <div className="fw-semibold">
                <i className="bi bi-cloud-upload me-1" />
                Mise en production
              </div>
              {config ? (
                <div className="small text-secondary">
                  <span className="font-monospace">{config.command}</span> sur « {config.vaultItem} » · branche <span className="font-monospace">{branch}</span>
                </div>
              ) : (
                <div className="small text-secondary">Aucun déploiement configuré : « Livrer » fusionne seulement sur la branche principale.</div>
              )}
              <div className="small mt-1">
                CI de <span className="font-monospace">{branch}</span> :{' '}
                {ci && ciLabel ? (
                  <Badge bg={ciLabel.variant} title={ci.checks.map((c) => `${c.name} : ${c.state}`).join('\n')}>
                    <i className={`bi ${ciLabel.icon} me-1`} />
                    {ciLabel.label}
                  </Badge>
                ) : ciQ.error ? (
                  <span className="text-secondary">{ciQ.error.message}</span>
                ) : (
                  <span className="text-secondary">…</span>
                )}
                {ci && <span className="font-monospace text-secondary ms-1">{ci.sha.slice(0, 7)}</span>}
              </div>
              {(runningDeploy || queuedDeploy) && (
                <div className="small mt-1">
                  {runningDeploy && <span>Déploiement en cours ({runningDeploy.steps[runningDeploy.steps.length - 1]?.message ?? '…'}). </span>}
                  {queuedDeploy && <span>Un déploiement attend la fin du précédent{queuedDeploy.joinedBy.length ? ` (${queuedDeploy.joinedBy.length + 1} demandes regroupées)` : ''}.</span>}
                </div>
              )}
            </div>
            {admin && (
              <div className="d-flex gap-2 flex-wrap">
                {config && (
                  <Button onClick={() => void deploy()} disabled={requesting} title={queuedDeploy ? 'Rejoindre le déploiement qui attend déjà' : `Déployer le dernier commit de ${branch} dont la CI est verte`}>
                    <i className="bi bi-rocket-takeoff me-1" />
                    {queuedDeploy ? 'Rejoindre le déploiement en attente' : 'Déployer'}
                  </Button>
                )}
                <Button variant="outline-secondary" onClick={() => setConfiguring(true)}>
                  <i className="bi bi-gear me-1" />
                  {config ? 'Configurer' : 'Configurer le déploiement'}
                </Button>
              </div>
            )}
          </Card.Body>
        </Card>
      )}
      {project.gitUrl && <DeliveryPolicyCard projectId={id} admin={admin} />}
      {project.gitUrl && <DeliveryQualityPanel projectId={id} admin={admin} />}
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <ButtonGroup size="sm">
          {(['all', 'merge', 'deploy'] as Kind[]).map((k) => (
            <Button key={k} variant={kind === k ? 'primary' : 'outline-secondary'} onClick={() => setKind(k)}>
              {k === 'all' ? 'Toutes' : k === 'merge' ? 'Fusions' : 'Déploiements'}
            </Button>
          ))}
        </ButtonGroup>
        <span className="small text-secondary ms-auto">« Livrer » se lance depuis une session ou une tâche.</span>
      </div>
      {deliveriesQ.error && <Alert variant="danger">Erreur : {deliveriesQ.error.message}</Alert>}
      <DeliveryTable deliveries={deliveries} canCancel={(d) => (d.kind === 'DEPLOY' ? admin : project.myRole !== 'VIEWER')} canEditQuality={project.myRole === 'ADMIN' || project.myRole === 'MEMBER'} />
      {configuring && <DeployConfigModal projectId={id} config={config} onClose={() => setConfiguring(false)} />}
    </>
  );
}
