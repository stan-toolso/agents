import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { Fragment, useState } from 'react';
import { Badge, Button, ButtonGroup, Card, Form, Modal, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import {
  BACKFILL_DELIVERY_QUALITY_TASKS,
  CANCEL_DELIVERY,
  DELIVER,
  DELIVERIES,
  DELIVERY_ACTIVE,
  DELIVERY_QUALITY_REPORT,
  DELIVERY_STATUS_LABELS,
  DEPLOY_CONFIG,
  normalizeQualityTag,
  SET_DELIVERY_QUALITY_SETTINGS,
  SET_DEPLOY_CONFIG,
  SET_TASK_DELIVERY,
  TASK_QUALITY_DELIVERY,
  type Delivery,
  type DeliveryQualityReport,
  type DeliveryQualitySettings,
  type DeliveryQualityTask,
  type DeployConfig,
  type TaskQualityDelivery,
} from '../graphql/deliveries';
import { formatDuration, timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';

type Role = 'ADMIN' | 'MEMBER' | 'VIEWER' | 'GUEST' | null | undefined;

export function DeliveryStatusBadge({ status }: { status: Delivery['status'] }) {
  const s = DELIVERY_STATUS_LABELS[status] ?? { label: String(status).toLowerCase(), variant: 'secondary' };
  return (
    <Badge bg={s.variant} className="delivery-status">
      {status === 'RUNNING' && <span className="spinner-border spinner-border-sm me-1 delivery-spinner" aria-hidden />}
      {s.label}
    </Badge>
  );
}

const lastStep = (d: Delivery) => d.steps[d.steps.length - 1]?.message ?? null;

/**
 * Dernière livraison montrée à côté du bouton de la session : un échec ou un conflit reste affiché jusqu'à la livraison
 * suivante (sinon il passe inaperçu : il arrive en arrière-plan, après le clic) ; une réussite, une heure.
 */
const showLatest = (d: Delivery) =>
  d.status === 'FAILED' || d.status === 'CONFLICT' || (d.status === 'SUCCEEDED' && Date.now() - new Date(d.finishedAt ?? d.createdAt).getTime() < 3_600_000);

/**
 * Bouton « Livrer » d'une session ou d'une tâche : fusionne la base dans la branche, pousse, ouvre ou reprend la PR,
 * attend la CI verte puis fusionne avec le compte de la personne ; un administrateur peut demander ensuite le
 * déploiement du projet. Affiche la livraison en cours du dossier (relevée toutes les 10 s).
 */
export function DeliverButton({ projectId, sessionId, taskId, worksessionId, branch, myRole, look = 'cc' }: { projectId: string; sessionId?: string; taskId?: string; worksessionId?: string | null; branch?: string | null; myRole: Role; look?: 'cc' | 'bootstrap' }) {
  const client = useApolloClient();
  const { confirm, showError } = useDialogs();
  const canWrite = myRole === 'ADMIN' || myRole === 'MEMBER';
  const filter = worksessionId ? { worksessionId } : { taskId };
  const { data } = usePollingQuery<{ deliveries: Delivery[] }>(DELIVERIES, { variables: { projectId, ...filter, kind: 'merge', limit: 1 }, pollInterval: 10_000, skip: !canWrite || (!worksessionId && !taskId) });
  const [deliver, { loading }] = useMutation(DELIVER, { refetchQueries: ['Deliveries'] });
  const [cancel] = useMutation(CANCEL_DELIVERY, { refetchQueries: ['Deliveries'] });
  if (!canWrite) return null;
  const latest = data?.deliveries[0] ?? null;
  const active = latest && DELIVERY_ACTIVE.includes(latest.status);

  const start = async () => {
    let config: DeployConfig | null = null;
    if (myRole === 'ADMIN') {
      const r = await client.query<{ deployConfig: DeployConfig | null }>({ query: DEPLOY_CONFIG, variables: { projectId }, fetchPolicy: 'network-only' }).catch(() => null);
      config = r?.data.deployConfig ?? null;
    }
    const message = `Fusionne la branche de base dans ${branch ? `« ${branch} »` : 'la branche'}, pousse, ouvre ou reprend la pull request, attend que sa CI soit verte puis la fusionne avec votre compte et passe ses tâches à « terminée ». Chaque étape s'écrit dans la session ; un conflit est confié à son agent. Les fichiers doivent être commités.`;
    let deploy = false;
    if (config) {
      const r = await confirm({ title: 'Livrer', message, confirmLabel: 'Livrer', checkbox: { label: `Puis mettre en production (déploiement du projet sur « ${config.vaultItem} », après CI verte, regroupé avec les autres livraisons)`, defaultChecked: true } });
      if (!r) return;
      deploy = r.checked;
    } else if (!(await confirm({ title: 'Livrer', message, confirmLabel: 'Livrer' }))) return;
    try {
      await deliver({ variables: { sessionId: sessionId ?? null, taskId: sessionId ? null : (taskId ?? null), deploy } });
    } catch (err) {
      void showError(err as Error);
    }
  };

  const btnClass = look === 'cc' ? 'cc-btn' : undefined;
  const title = active ? `Livraison en cours : ${lastStep(latest!) ?? '…'}` : latest ? `Dernière livraison ${DELIVERY_STATUS_LABELS[latest.status]?.label ?? latest.status} ${timeAgo(latest.createdAt)}${latest.error ? ` : ${latest.error}` : ''}` : 'Fusionner sur la branche principale après CI verte (et mettre en production)';
  const label = active ? (
    <>
      <span className="spinner-border spinner-border-sm me-1 delivery-spinner" aria-hidden /> Livraison en cours
    </>
  ) : (
    <>
      <i className="bi bi-rocket-takeoff" /> Livrer
    </>
  );
  const onCancel = async () => {
    if (!latest) return;
    if (!(await confirm({ title: 'Annuler la livraison', message: "La livraison s'arrête (rien n'est fusionné ensuite). Ce qui est déjà poussé le reste.", confirmLabel: 'Annuler la livraison', cancelLabel: 'Continuer', danger: true }))) return;
    cancel({ variables: { id: latest.id } }).catch((err) => void showError(err as Error));
  };
  return (
    <>
      {look === 'cc' ? (
        <button type="button" className={`${btnClass} accent`} disabled={loading || Boolean(active)} title={title} onClick={() => void start()}>
          {label}
        </button>
      ) : (
        <Button size="sm" variant="outline-primary" disabled={loading || Boolean(active)} title={title} onClick={() => void start()}>
          {label}
        </Button>
      )}
      {active && latest.cancellable &&
        (look === 'cc' ? (
          <button type="button" className="cc-btn" title="Arrêter la livraison en cours" onClick={() => void onCancel()}>
            Annuler la livraison
          </button>
        ) : (
          <Button size="sm" variant="link" className="p-0 ms-2" onClick={() => void onCancel()}>
            Annuler
          </Button>
        ))}
      {latest && !active && look === 'cc' && showLatest(latest) && (
        <Link to={`/projects/${projectId}/deliveries`} className={`delivery-last delivery-last-${latest.status.toLowerCase()}`} title={latest.error ?? lastStep(latest) ?? undefined}>
          <i className={`bi ${latest.status === 'SUCCEEDED' ? 'bi-check-circle' : 'bi-exclamation-triangle'}`} aria-hidden /> Livraison {DELIVERY_STATUS_LABELS[latest.status]?.label ?? latest.status.toLowerCase()}
          {latest.error && latest.status !== 'CONFLICT' ? ` : ${latest.error}` : ''}
        </Link>
      )}
      {latest && !active && look === 'bootstrap' && (
        <span className="ms-2 text-secondary small" title={latest.error ?? undefined}>
          Dernière livraison <DeliveryStatusBadge status={latest.status} /> {timeAgo(latest.createdAt)}
        </span>
      )}
    </>
  );
}

/** Historique des livraisons d'un projet : qui, quoi, quel commit, durée, résultat ; étapes et sortie dépliables. */
export function DeliveryTable({ deliveries, canCancel, canEditQuality = false }: { deliveries: Delivery[]; canCancel: (d: Delivery) => boolean; canEditQuality?: boolean }) {
  const { confirm, showError } = useDialogs();
  const [open, setOpen] = useState<string | null>(null);
  const [cancel] = useMutation(CANCEL_DELIVERY, { refetchQueries: ['Deliveries'] });
  const [setTaskDelivery] = useMutation(SET_TASK_DELIVERY, { refetchQueries: ['Deliveries', 'DeliveryQualityReport'] });
  const detach = async (q: DeliveryQualityTask) => {
    if (!q.task) return;
    if (!(await confirm({ title: 'Détacher la tâche', message: `« ${q.task.title} » ne sera plus comptée comme une régression de cette livraison (correction gardée : le calcul automatique n'y revient pas).`, confirmLabel: 'Détacher' }))) return;
    setTaskDelivery({ variables: { taskId: q.task.id, deliveryId: null } }).catch((err) => void showError(err as Error));
  };
  const onCancel = async (d: Delivery) => {
    if (!(await confirm({ title: 'Annuler', message: d.kind === 'DEPLOY' ? 'Ce déploiement ne sera pas lancé.' : "La livraison s'arrête (rien n'est fusionné ensuite).", confirmLabel: 'Annuler', cancelLabel: 'Continuer', danger: true }))) return;
    cancel({ variables: { id: d.id } }).catch((err) => void showError(err as Error));
  };
  if (!deliveries.length) return <div className="text-secondary fst-italic">Aucune livraison pour l'instant.</div>;
  return (
    <Table size="sm" hover responsive className="delivery-table align-middle">
      <thead>
        <tr>
          <th>Quoi</th>
          <th>Résultat</th>
          <th className="d-none d-md-table-cell">Qui</th>
          <th className="d-none d-md-table-cell">Commit</th>
          <th className="d-none d-md-table-cell">Durée</th>
          <th>Quand</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {deliveries.map((d) => (
          <Fragment key={d.id}>
            <tr className="delivery-row" onClick={() => setOpen(open === d.id ? null : d.id)} role="button">
              <td>
                <i className={`bi ${d.kind === 'DEPLOY' ? 'bi-cloud-upload' : 'bi-git'} me-1 text-secondary`} />
                {d.kind === 'DEPLOY' ? 'Déploiement' : 'Livraison'}
                {d.branch && <span className="font-monospace small ms-1">{d.branch}</span>}
                {d.prNumber != null && (
                  <a href={d.prUrl ?? undefined} target="_blank" rel="noreferrer" className="ms-1 small" onClick={(e) => e.stopPropagation()}>
                    #{d.prNumber}
                  </a>
                )}
                {d.task && (
                  <div className="small text-truncate">
                    <Link to={`/tasks/${d.task.id}`} onClick={(e) => e.stopPropagation()}>
                      {d.task.title}
                    </Link>
                  </div>
                )}
              </td>
              <td>
                <DeliveryStatusBadge status={d.status} />
                {(d.qualityTasks?.length ?? 0) > 0 && (
                  <span className="delivery-quality-count ms-1" title={`${d.qualityTasks.length} tâche(s) qualité créée(s) après cette livraison :\n${d.qualityTasks.map((q) => q.task?.title ?? '?').join('\n')}`}>
                    <i className="bi bi-bug me-1" />
                    {d.qualityTasks.length}
                  </span>
                )}
                {(d.status === 'RUNNING' || d.status === 'QUEUED') && lastStep(d) && <div className="small text-secondary text-truncate delivery-last-step">{lastStep(d)}</div>}
                {d.error && d.status !== 'CANCELLED' && <div className="small text-danger text-truncate delivery-last-step" title={d.error}>{d.error}</div>}
              </td>
              <td className="d-none d-md-table-cell small">
                {d.requestedBy?.name ?? '—'}
                {d.joinedBy.length > 0 && <span className="text-secondary" title={d.joinedBy.map((u) => u.name).join(', ')}> +{d.joinedBy.length}</span>}
              </td>
              <td className="d-none d-md-table-cell font-monospace small">{d.sha ? d.sha.slice(0, 7) : '—'}</td>
              <td className="d-none d-md-table-cell small">{d.durationSeconds != null ? formatDuration(d.durationSeconds * 1000) : '—'}</td>
              <td className="small text-nowrap" title={new Date(d.createdAt).toLocaleString()}>
                {timeAgo(d.createdAt)}
              </td>
              <td className="text-end text-nowrap">
                {d.cancellable && canCancel(d) && (
                  <Button
                    size="sm"
                    variant="link"
                    className="p-0 me-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onCancel(d);
                    }}
                  >
                    Annuler
                  </Button>
                )}
                <i className={`bi bi-chevron-${open === d.id ? 'up' : 'down'} text-secondary`} />
              </td>
            </tr>
            {open === d.id && (
              <tr className="delivery-detail">
                <td colSpan={7}>
                  {d.session && (
                    <div className="small mb-1">
                      Session : <Link to={`/sessions/${d.session.id}`}>{d.session.name}</Link>
                    </div>
                  )}
                  <ol className="delivery-steps small mb-2">
                    {d.steps.map((s, i) => (
                      <li key={i} className={`delivery-step delivery-step-${s.level}`}>
                        <span className="text-secondary me-2">{new Date(s.at).toLocaleTimeString()}</span>
                        {s.message}
                      </li>
                    ))}
                  </ol>
                  {d.output && <pre className="delivery-output small mb-0">{d.output}</pre>}
                  {(d.qualityTasks?.length ?? 0) > 0 && (
                    <div className="delivery-quality small mt-2">
                      <div className="fw-semibold mb-1">
                        <i className="bi bi-bug me-1" />
                        Tâches qualité créées après cette livraison
                      </div>
                      <ul className="list-unstyled mb-0">
                        {d.qualityTasks.map((q, i) => (
                          <li key={q.task?.id ?? i} className="d-flex align-items-center gap-2 flex-wrap">
                            {q.task ? <Link to={`/tasks/${q.task.id}`}>{q.task.title}</Link> : <span className="text-secondary">tâche supprimée</span>}
                            {q.task && <span className="text-secondary">créée {timeAgo(q.task.createdAt)}</span>}
                            <span className="text-secondary">· {q.source === 'MANUAL' ? `rattachée par ${q.linkedBy?.name ?? 'une personne'}` : 'rattachement calculé'}</span>
                            {canEditQuality && q.task && (
                              <Button size="sm" variant="link" className="p-0" onClick={() => void detach(q)}>
                                Détacher
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </Table>
  );
}

/** Configuration du déploiement du projet (administrateurs) : serveur SSH du coffre, commande, branche, délai. */
export function DeployConfigModal({ projectId, config, onClose }: { projectId: string; config: DeployConfig | null; onClose: () => void }) {
  const { confirm, showError } = useDialogs();
  const [vaultItem, setVaultItem] = useState(config?.vaultItem ?? '');
  const [command, setCommand] = useState(config?.command ?? '');
  const [branch, setBranch] = useState(config?.branch ?? '');
  const [timeout, setTimeoutMinutes] = useState(String(config?.timeoutMinutes ?? 30));
  const [save, { loading }] = useMutation(SET_DEPLOY_CONFIG, { refetchQueries: ['DeployConfig'] });
  const submit = async (input: Record<string, unknown> | null) => {
    try {
      await save({ variables: { projectId, input } });
      onClose();
    } catch (err) {
      void showError(err as Error);
    }
  };
  const remove = async () => {
    if (await confirm({ title: 'Retirer le déploiement', message: 'Plus aucune livraison ne mettra ce projet en production depuis Skipper.', confirmLabel: 'Retirer', danger: true })) await submit(null);
  };
  return (
    <Modal show onHide={onClose} size="lg">
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit({ vaultItem, command, branch: branch.trim() || null, timeoutMinutes: Number(timeout) || 30 });
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title>Déploiement du projet</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Skipper lance cette commande sur un serveur SSH du coffre, à la demande d'un administrateur (son clic vaut accord), jamais deux à la fois, et seulement quand la CI de la branche déployée est verte. Les demandes faites pendant un déploiement se regroupent en un seul déploiement suivant.
          </p>
          <Form.Group className="mb-3">
            <Form.Label>Serveur SSH (nom de l'élément du coffre)</Form.Label>
            <Form.Control value={vaultItem} onChange={(e) => setVaultItem(e.target.value)} placeholder="skipper-1" required />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Commande</Form.Label>
            <Form.Control as="textarea" rows={3} className="font-monospace" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sudo -iu skipper ~/skipper/deploy/cellule/deploy.sh --ref {sha}" required />
            <Form.Text>
              <code>{'{sha}'}</code> : le commit dont la CI est verte ; <code>{'{branch}'}</code> : sa branche. Utilisez <code>{'{sha}'}</code> pour déployer exactement ce qui a été vérifié.
            </Form.Text>
          </Form.Group>
          <div className="d-flex gap-3 flex-wrap">
            <Form.Group className="mb-3" style={{ flex: '1 1 200px' }}>
              <Form.Label>Branche déployée</Form.Label>
              <Form.Control value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branche principale du projet" />
            </Form.Group>
            <Form.Group className="mb-3" style={{ flex: '0 1 160px' }}>
              <Form.Label>Délai maximal (min)</Form.Label>
              <Form.Control type="number" min={1} max={120} value={timeout} onChange={(e) => setTimeoutMinutes(e.target.value)} />
            </Form.Group>
          </div>
        </Modal.Body>
        <Modal.Footer>
          {config && (
            <Button variant="outline-danger" className="me-auto" onClick={() => void remove()} disabled={loading}>
              Retirer
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading}>
            Enregistrer
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

const pct = (rate: number | null) => (rate == null ? '—' : `${Math.round(rate * 100)} %`);

/**
 * Régressions des livraisons (onglet Livraisons) : part des livraisons suivies d'au moins une tâche qualité dans la
 * fenêtre réglée, au total et par auteur des pull requests emportées (personnes et agents). Réglages : administrateurs.
 */
export function DeliveryQualityPanel({ projectId, admin }: { projectId: string; admin: boolean }) {
  const [days, setDays] = useState(90);
  const [configuring, setConfiguring] = useState(false);
  const q = useQuery<{ deliveryQualityReport: DeliveryQualityReport }>(DELIVERY_QUALITY_REPORT, { variables: { projectId, days }, fetchPolicy: 'cache-and-network' });
  const r = q.data?.deliveryQualityReport;
  return (
    <Card className="mb-3 delivery-quality-card">
      <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
          <div className="fw-semibold flex-grow-1">
            <i className="bi bi-bug me-1" />
            Régressions après livraison
          </div>
          <ButtonGroup size="sm">
            {[30, 90, 365].map((n) => (
              <Button key={n} variant={days === n ? 'primary' : 'outline-secondary'} onClick={() => setDays(n)}>
                {n} j
              </Button>
            ))}
          </ButtonGroup>
          {admin && (
            <Button size="sm" variant="outline-secondary" onClick={() => setConfiguring(true)}>
              <i className="bi bi-gear me-1" />
              Réglages
            </Button>
          )}
        </div>
        {q.error && <div className="small text-danger">{q.error.message}</div>}
        {r && (
          <>
            <div className="small text-secondary mb-2">
              Tâches étiquetées {r.settings.tags.map((t) => `« ${t} »`).join(', ')} créées dans les {r.settings.windowHours} h qui suivent une livraison, rattachées à la plus récente.
            </div>
            <div className="d-flex flex-wrap gap-4 mb-2">
              <div>
                <div className="delivery-quality-value">{pct(r.regressionRate)}</div>
                <div className="small text-secondary">des livraisons suivies d'une tâche qualité</div>
              </div>
              <div>
                <div className="delivery-quality-value">
                  {r.deliveriesWithQualityTasks} / {r.deliveries}
                </div>
                <div className="small text-secondary">livraisons concernées</div>
              </div>
              <div>
                <div className="delivery-quality-value">{r.qualityTasks}</div>
                <div className="small text-secondary">tâches qualité</div>
              </div>
            </div>
            {r.byAuthor.length > 0 && (
              <Table size="sm" responsive className="small mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Auteur des PR</th>
                    <th className="text-end d-none d-md-table-cell">PR livrées</th>
                    <th className="text-end">Livraisons</th>
                    <th className="text-end d-none d-md-table-cell">Avec tâche qualité</th>
                    <th className="text-end">Taux</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byAuthor.map((a, i) => (
                    <tr key={a.user?.id ?? i}>
                      <td>
                        {a.isAgent && <i className="bi bi-robot me-1 text-secondary" title="Agent" />}
                        {a.user?.name ?? 'inconnu'}
                      </td>
                      <td className="text-end d-none d-md-table-cell">{a.pullRequests}</td>
                      <td className="text-end">{a.deliveries}</td>
                      <td className="text-end d-none d-md-table-cell">{a.deliveriesWithQualityTasks}</td>
                      <td className="text-end fw-semibold text-nowrap">{pct(a.regressionRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </Card.Body>
      {configuring && r && <DeliveryQualitySettingsModal projectId={projectId} settings={r.settings} onClose={() => setConfiguring(false)} />}
    </Card>
  );
}

/** Réglages qualité d'un projet (administrateurs) : étiquettes, fenêtre, rattrapage. */
export function DeliveryQualitySettingsModal({ projectId, settings, onClose }: { projectId: string; settings: DeliveryQualitySettings; onClose: () => void }) {
  const { alert, showError } = useDialogs();
  const [tags, setTags] = useState(settings.tags.join(', '));
  const [windowHours, setWindowHours] = useState(String(settings.windowHours));
  const refetchQueries = ['DeliveryQualityReport', 'Deliveries'];
  const [save, { loading }] = useMutation(SET_DELIVERY_QUALITY_SETTINGS, { refetchQueries });
  const [backfill, { loading: backfilling }] = useMutation<{ backfillDeliveryQualityTasks: number }>(BACKFILL_DELIVERY_QUALITY_TASKS, { refetchQueries });
  const submit = async (reset: boolean) => {
    try {
      const list = tags.split(',').map((t) => t.trim()).filter(Boolean);
      await save({ variables: reset ? { projectId, reset: true } : { projectId, tags: list, windowHours: Number(windowHours) } });
      onClose();
    } catch (err) {
      void showError(err as Error);
    }
  };
  const recompute = async () => {
    try {
      const res = await backfill({ variables: { projectId } });
      const n = res.data?.backfillDeliveryQualityTasks ?? 0;
      await alert({ title: 'Rattachements recalculés', message: n ? `${n} rattachement(s) mis à jour.` : 'Rien à changer.' });
    } catch (err) {
      void showError(err as Error);
    }
  };
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title>Tâches qualité des livraisons</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="small text-secondary">
          Une tâche portant l'une de ces étiquettes, créée dans la fenêtre qui suit une livraison réussie (un déploiement, ou une fusion « Livrer » si le projet ne déploie pas par Skipper), est rattachée à la plus récente. Les corrections faites à la main sont gardées.
        </p>
        <Form.Group className="mb-3">
          <Form.Label>Étiquettes qualité</Form.Label>
          <Form.Control value={tags} onChange={(e) => setTags(e.target.value)} placeholder="bug, regression, qualite" />
          <Form.Text>Séparées par des virgules ; sans tenir compte des majuscules ni des accents.</Form.Text>
        </Form.Group>
        <Form.Group>
          <Form.Label>Fenêtre après la livraison (heures)</Form.Label>
          <Form.Control type="number" min={1} max={720} value={windowHours} onChange={(e) => setWindowHours(e.target.value)} />
        </Form.Group>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="link" className="me-auto" onClick={() => void recompute()} disabled={backfilling} title="Recalcule les rattachements automatiques de toutes les tâches du projet">
          Recalculer
        </Button>
        {settings.custom && (
          <Button variant="outline-secondary" onClick={() => void submit(true)} disabled={loading}>
            Revenir au défaut
          </Button>
        )}
        <Button onClick={() => void submit(false)} disabled={loading}>
          Enregistrer
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

const deliveryLabel = (d: { kind: string; sha: string | null; finishedAt: string | null; createdAt: string; prNumber?: number | null }) =>
  `${d.kind === 'DEPLOY' ? 'Déploiement' : 'Livraison'}${d.sha ? ` ${d.sha.slice(0, 7)}` : d.prNumber != null ? ` #${d.prNumber}` : ''} · ${new Date(d.finishedAt ?? d.createdAt).toLocaleString()}`;

/**
 * Fiche d'une tâche : la livraison à laquelle elle est rattachée comme tâche qualité, et la correction à la main
 * (autre livraison, aucune, ou retour au calcul). Affichée pour une tâche rattachée ou portant une étiquette qualité.
 */
export function TaskQualityDelivery({ taskId, projectId, canWrite }: { taskId: string; projectId: string; canWrite: boolean }) {
  const { showError } = useDialogs();
  const [editing, setEditing] = useState(false);
  const q = useQuery<{ task: TaskQualityDelivery | null; deliveryQualitySettings: { tags: string[]; windowHours: number } }>(TASK_QUALITY_DELIVERY, { variables: { taskId, projectId }, fetchPolicy: 'cache-and-network' });
  const deliveriesQ = useQuery<{ deliveries: Delivery[] }>(DELIVERIES, { variables: { projectId, limit: 50 }, skip: !editing });
  const [setLink, { loading }] = useMutation(SET_TASK_DELIVERY, { refetchQueries: ['TaskQualityDelivery'] });
  const task = q.data?.task;
  const settings = q.data?.deliveryQualitySettings;
  if (!task || !settings) return null;
  const link = task.qualityDelivery;
  const wanted = new Set(settings.tags.map(normalizeQualityTag));
  const isQuality = task.tags.some((t) => wanted.has(normalizeQualityTag(t)));
  if (!link && !isQuality) return null;
  const apply = (variables: Record<string, unknown>) =>
    setLink({ variables: { taskId, ...variables } })
      .then(() => setEditing(false))
      .catch((err) => void showError(err as Error));
  const choices = (deliveriesQ.data?.deliveries ?? []).filter((d) => d.status === 'SUCCEEDED');
  return (
    <div className="task-quality-delivery small mt-2">
      <i className="bi bi-bug me-1 text-secondary" />
      {link?.delivery ? (
        <>
          Tâche qualité rattachée au{' '}
          <Link to={`/projects/${projectId}/deliveries`}>{deliveryLabel(link.delivery).replace(/^Déploiement/, 'déploiement').replace(/^Livraison/, 'livraison')}</Link>
        </>
      ) : link ? (
        <>Tâche qualité rattachée à aucune livraison</>
      ) : (
        <>Tâche qualité créée hors des {settings.windowHours} h qui suivent une livraison : rattachée à aucune</>
      )}
      {link && <span className="text-secondary"> ({link.source === 'MANUAL' ? `corrigé par ${link.linkedBy?.name ?? 'une personne'}` : 'calculé'})</span>}
      {canWrite && !editing && (
        <Button size="sm" variant="link" className="p-0 ms-2 align-baseline" onClick={() => setEditing(true)}>
          Corriger
        </Button>
      )}
      {editing && (
        <div className="d-flex flex-wrap gap-2 align-items-center mt-1">
          <Form.Select
            size="sm"
            style={{ maxWidth: 360 }}
            disabled={loading || deliveriesQ.loading}
            value={link?.delivery?.id ?? ''}
            onChange={(e) => void apply({ deliveryId: e.target.value || null })}
          >
            <option value="">Aucune livraison</option>
            {link?.delivery && !choices.some((d) => d.id === link.delivery!.id) && <option value={link.delivery.id}>{deliveryLabel(link.delivery)}</option>}
            {choices.map((d) => (
              <option key={d.id} value={d.id}>
                {deliveryLabel(d)}
              </option>
            ))}
          </Form.Select>
          {link?.source === 'MANUAL' && (
            <Button size="sm" variant="outline-secondary" disabled={loading} onClick={() => void apply({ reset: true })}>
              Revenir au calcul
            </Button>
          )}
          <Button size="sm" variant="link" className="p-0" onClick={() => setEditing(false)}>
            Fermer
          </Button>
        </div>
      )}
    </div>
  );
}
