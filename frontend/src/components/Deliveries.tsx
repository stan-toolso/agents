import { useApolloClient, useMutation } from '@apollo/client';
import { Fragment, useState } from 'react';
import { Badge, Button, Form, Modal, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { CANCEL_DELIVERY, DELIVER, DELIVERIES, DELIVERY_ACTIVE, DELIVERY_STATUS_LABELS, DEPLOY_CONFIG, SET_DEPLOY_CONFIG, type Delivery, type DeployConfig } from '../graphql/deliveries';
import { formatDuration, timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';

type Role = 'ADMIN' | 'MEMBER' | 'VIEWER' | null | undefined;

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
      {latest && !active && look === 'bootstrap' && (
        <span className="ms-2 text-secondary small" title={latest.error ?? undefined}>
          Dernière livraison <DeliveryStatusBadge status={latest.status} /> {timeAgo(latest.createdAt)}
        </span>
      )}
    </>
  );
}

/** Historique des livraisons d'un projet : qui, quoi, quel commit, durée, résultat ; étapes et sortie dépliables. */
export function DeliveryTable({ deliveries, canCancel }: { deliveries: Delivery[]; canCancel: (d: Delivery) => boolean }) {
  const { confirm, showError } = useDialogs();
  const [open, setOpen] = useState<string | null>(null);
  const [cancel] = useMutation(CANCEL_DELIVERY, { refetchQueries: ['Deliveries'] });
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
