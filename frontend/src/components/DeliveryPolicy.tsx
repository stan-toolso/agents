import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Form, Modal } from 'react-bootstrap';
import { DELIVERY_POLICY, SET_DELIVERY_POLICY, type DeliveryPolicy, type DeliveryPolicyMode } from '../graphql/deliveries';

const MODE_LABELS: Record<DeliveryPolicyMode, string> = {
  AUTO_MERGE: 'Fusion automatique',
  MANUAL: 'Manuelle',
};

/**
 * Politique de livraison par étiquette de tâche (onglet Livraisons) : quelles tâches Skipper fusionne lui-même, après
 * une relecture favorable par un agent et une CI verte. Le déploiement reste toujours soumis à une personne.
 */
export function DeliveryPolicyCard({ projectId, admin, myName }: { projectId: string; admin: boolean; myName?: string | null }) {
  const q = useQuery<{ deliveryPolicy: DeliveryPolicy | null }>(DELIVERY_POLICY, { variables: { projectId } });
  const [editing, setEditing] = useState(false);
  const policy = q.data?.deliveryPolicy ?? null;
  const rules = policy?.rules ?? [];
  return (
    <Card className="mb-3 deploy-card">
      <Card.Body className="d-flex flex-wrap gap-3 align-items-center">
        <div className="flex-grow-1" style={{ minWidth: 240 }}>
          <div className="fw-semibold">
            <i className="bi bi-signpost-split me-1" />
            Politique de livraison
          </div>
          {rules.length ? (
            <>
              <div className="d-flex flex-wrap gap-1 mt-1">
                {rules.map((r) => (
                  <Badge key={r.tag} bg={r.mode === 'AUTO_MERGE' ? 'success' : 'secondary'} className="fw-normal" title={MODE_LABELS[r.mode]}>
                    <i className={`bi ${r.mode === 'AUTO_MERGE' ? 'bi-lightning-charge' : 'bi-person'} me-1`} />
                    {r.tag} · {MODE_LABELS[r.mode].toLowerCase()}
                  </Badge>
                ))}
              </div>
              {rules.some((r) => r.mode === 'AUTO_MERGE') && (
                <div className="small text-secondary mt-1">
                  Pull requests fusionnées par Skipper après une relecture favorable par un agent et une CI verte, avec le compte de {policy?.mergeUser?.name ?? 'personne (compte supprimé)'}. Le déploiement reste manuel.
                </div>
              )}
            </>
          ) : (
            <div className="small text-secondary">Aucune règle : toutes les pull requests sont fusionnées par une personne.</div>
          )}
          {q.error && <div className="small text-danger">{q.error.message}</div>}
        </div>
        {admin && (
          <Button variant="outline-secondary" onClick={() => setEditing(true)}>
            <i className="bi bi-gear me-1" />
            {rules.length ? 'Modifier' : 'Configurer'}
          </Button>
        )}
      </Card.Body>
      {editing && <DeliveryPolicyModal projectId={projectId} policy={policy} myName={myName} onClose={() => setEditing(false)} />}
    </Card>
  );
}

type Row = { tag: string; mode: DeliveryPolicyMode };

function DeliveryPolicyModal({ projectId, policy, myName, onClose }: { projectId: string; policy: DeliveryPolicy | null; myName?: string | null; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(policy?.rules.length ? policy.rules.map((r) => ({ tag: r.tag, mode: r.mode })) : [{ tag: 'auto', mode: 'AUTO_MERGE' }]);
  const [save, { loading, error }] = useMutation(SET_DELIVERY_POLICY, { refetchQueries: ['DeliveryPolicy'] });
  const set = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cleaned = rows.filter((r) => r.tag.trim());
  const auto = cleaned.some((r) => r.mode === 'AUTO_MERGE');

  const submit = async () => {
    const res = await save({ variables: { projectId, rules: cleaned.map((r) => ({ tag: r.tag.trim(), mode: r.mode })) } }).catch(() => null);
    if (res?.data) onClose();
  };

  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title>Politique de livraison</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="small text-secondary">
          Selon les étiquettes de la tâche d’une pull request. <strong>Fusion automatique</strong> : Skipper fait relire le dernier commit de la branche par un agent ; si le rapport commence par
          « ✅ Rien de bloquant » et que la CI est verte, il lance « Livrer » (fusion seulement). <strong>Manuelle</strong> l’emporte : une tâche qui porte aussi une étiquette manuelle n’est jamais
          fusionnée d’office. Le déploiement n’est jamais automatique.
        </p>
        {rows.map((r, i) => (
          <div key={i} className="d-flex gap-2 mb-2 align-items-center">
            <Form.Control value={r.tag} onChange={(e) => set(i, { tag: e.target.value })} placeholder="Étiquette (ex. auto)" aria-label="Étiquette" style={{ flex: '1 1 8rem' }} />
            <Form.Select value={r.mode} onChange={(e) => set(i, { mode: e.target.value as DeliveryPolicyMode })} aria-label="Politique" style={{ flex: '1 1 10rem' }}>
              <option value="AUTO_MERGE">{MODE_LABELS.AUTO_MERGE}</option>
              <option value="MANUAL">{MODE_LABELS.MANUAL}</option>
            </Form.Select>
            <Button variant="outline-secondary" size="sm" onClick={() => setRows((list) => list.filter((_, j) => j !== i))} title="Retirer la règle" aria-label="Retirer la règle">
              <i className="bi bi-x-lg" />
            </Button>
          </div>
        ))}
        <Button variant="link" size="sm" className="px-0" onClick={() => setRows((list) => [...list, { tag: '', mode: 'MANUAL' }])}>
          <i className="bi bi-plus-lg me-1" />
          Ajouter une règle
        </Button>
        {auto && (
          <Alert variant="warning" className="small py-2 mt-2 mb-0">
            <i className="bi bi-person-check me-1" />
            Les fusions automatiques se feront avec <strong>votre compte</strong>{myName ? ` (${myName})` : ''} : en enregistrant, vous l’acceptez. Elles sont inscrites au journal du projet. Si vous n’êtes plus administrateur du projet, elles s’arrêtent.
          </Alert>
        )}
        {error && <Alert variant="danger" className="small py-2 mt-2 mb-0">{error.message}</Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onClose}>
          Annuler
        </Button>
        <Button onClick={() => void submit()} disabled={loading}>
          {cleaned.length ? 'Enregistrer' : 'Retirer la politique'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
