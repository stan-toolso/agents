import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Form, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { apiBaseUrl } from '../../apollo';
import { useDialogs } from '../Dialogs';
import { curlExamples } from '../../lib/apiKeys';
import {
  API_KEY_SCOPES,
  CREATE_PROJECT_API_KEY,
  DELETE_PROJECT_API_KEY,
  PROJECT_API_KEYS,
  SET_PROJECT_API_KEY_SIGNING,
  UPDATE_PROJECT_API_KEY,
  type InboundEventRow,
  type ProjectApiKey,
} from '../../graphql/tasks';

interface AgentRef {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

function ScopeChecks({ value, onChange, idPrefix }: { value: string[]; onChange: (v: string[]) => void; idPrefix: string }) {
  return (
    <>
      {API_KEY_SCOPES.map((s) => (
        <Form.Check
          key={s.value}
          id={`${idPrefix}-${s.value}`}
          type="checkbox"
          checked={value.includes(s.value)}
          onChange={(e) => onChange(e.target.checked ? [...value, s.value] : value.filter((v) => v !== s.value))}
          label={
            <>
              {s.label} <code className="text-secondary small">{s.hint}</code>
            </>
          }
        />
      ))}
    </>
  );
}

function TriageSelect({ agents, value, onChange, id }: { agents: AgentRef[]; value: string; onChange: (v: string) => void; id: string }) {
  return (
    <Form.Group className="mt-2" controlId={id}>
      <Form.Label className="mb-1">Agent de triage par défaut</Form.Label>
      <Form.Select size="sm" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 320 }}>
        <option value="">Le Product Manager du projet</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.enabled ? '' : ' (en pause)'}
          </option>
        ))}
      </Form.Select>
      <Form.Text>L'appel peut aussi désigner l'agent (« triage »: {'{'} "agent": "Nom" {'}'}).</Form.Text>
    </Form.Group>
  );
}

/** Formulaire de création ou de modification d'une clé. */
function KeyForm({ agents, initial, submitLabel, withSigning, onSubmit, onCancel }: { agents: AgentRef[]; initial: { name: string; scopes: string[]; triageAgentId: string }; submitLabel: string; withSigning: boolean; onSubmit: (v: { name: string; scopes: string[]; triageAgentId: string; signed: boolean }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial.name);
  const [scopes, setScopes] = useState<string[]>(initial.scopes);
  const [triageAgentId, setTriage] = useState(initial.triageAgentId);
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = initial.name ? `edit-${initial.name}` : 'new-key';
  return (
    <Form
      className="border rounded p-2 mb-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({ name, scopes, triageAgentId, signed });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form.Group controlId={`${id}-name`} className="mb-2">
        <Form.Label className="mb-1">Nom</Form.Label>
        <Form.Control size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Curso, formulaire du site…" style={{ maxWidth: 320 }} required />
      </Form.Group>
      <div className="mb-1">Portées</div>
      <ScopeChecks value={scopes} onChange={setScopes} idPrefix={id} />
      {scopes.includes('inbound:triage') && <TriageSelect agents={agents} value={triageAgentId} onChange={setTriage} id={`${id}-triage`} />}
      {withSigning && scopes.some((s) => s.startsWith('inbound:')) && (
        <Form.Check className="mt-2" id={`${id}-signed`} type="switch" checked={signed} onChange={(e) => setSigned(e.target.checked)} label="Exiger une signature HMAC des événements entrants (secret de signature généré)" />
      )}
      <div className="mt-2 d-flex gap-2">
        <Button size="sm" type="submit" disabled={busy || !name.trim() || !scopes.length}>
          {submitLabel}
        </Button>
        <Button size="sm" variant="link" onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </Form>
  );
}

const STATUS_VARIANT: Record<string, string> = { done: 'success', failed: 'danger', processing: 'secondary' };
const STATUS_LABEL: Record<string, string> = { done: 'traité', failed: 'échec', processing: 'en cours' };

/**
 * Clés d'API du projet : API REST des tâches (`/api/v1/tasks`) et point d'entrée entrant (`/api/v1/inbound`) pour les
 * outils externes, avec portées, signature HMAC facultative et agent de triage ; derniers événements reçus.
 */
export default function ApiKeysCard({ projectId }: { projectId: string }) {
  const { data } = useQuery<{ project: { id: string; apiKeys: ProjectApiKey[]; agents: AgentRef[]; inboundEvents: InboundEventRow[] } | null }>(PROJECT_API_KEYS, { variables: { id: projectId } });
  const { confirm, showError } = useDialogs();
  const [created, setCreated] = useState<{ name: string; secret: string; signingSecret: string | null; scopes: string[] } | null>(null);
  const [newSigning, setNewSigning] = useState<{ name: string; signingSecret: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const opts = { refetchQueries: ['ProjectApiKeys'], onError: (e: Error) => void showError(e) };
  const [create] = useMutation<{ createProjectApiKey: { secret: string; signingSecret: string | null; key: ProjectApiKey } }>(CREATE_PROJECT_API_KEY, opts);
  const [update] = useMutation(UPDATE_PROJECT_API_KEY, opts);
  const [setSigning] = useMutation<{ setProjectApiKeySigning: { signingSecret: string | null; key: ProjectApiKey } }>(SET_PROJECT_API_KEY_SIGNING, opts);
  const [remove] = useMutation(DELETE_PROJECT_API_KEY, opts);
  const keys = data?.project?.apiKeys ?? [];
  const agents = data?.project?.agents ?? [];
  const events = data?.project?.inboundEvents ?? [];
  const base = apiBaseUrl || window.location.origin;
  return (
    <Card className="mt-3">
      <Card.Header>Clés d'API et événements entrants</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Une clé d'API permet à un outil externe (Curso, formulaire, CRM, script) de lire et créer les tâches de ce projet par REST, ou de lui envoyer des événements (<code>POST /api/v1/inbound</code>) qui créent une tâche et peuvent convoquer un agent pour le triage. Chaque clé n'a que les portées cochées. Les secrets ne sont montrés qu'une fois.
        </p>
        {created && (
          <Alert variant="success" className="py-2" onClose={() => setCreated(null)} dismissible>
            <div>Clé « {created.name} » créée. Copiez le secret maintenant, il ne sera plus affiché :</div>
            <code className="user-select-all d-block my-1">{created.secret}</code>
            {created.signingSecret && (
              <>
                <div>Secret de signature (HMAC) :</div>
                <code className="user-select-all d-block my-1">{created.signingSecret}</code>
              </>
            )}
            <pre className="mb-0 mt-2 pre-dark p-2" style={{ whiteSpace: 'pre-wrap' }}>
              {curlExamples(base, created.secret, created.scopes, created.signingSecret)}
            </pre>
          </Alert>
        )}
        {newSigning && (
          <Alert variant="success" className="py-2" onClose={() => setNewSigning(null)} dismissible>
            <div>Nouveau secret de signature de « {newSigning.name} » (l'ancien ne vaut plus) :</div>
            <code className="user-select-all d-block my-1">{newSigning.signingSecret}</code>
          </Alert>
        )}
        {keys.length > 0 && (
          <Table size="sm" className="mb-2 table-stack">
            <tbody>
              {keys.map((k) =>
                editing === k.id ? (
                  <tr key={k.id}>
                    <td colSpan={2}>
                      <KeyForm
                        agents={agents}
                        initial={{ name: k.name, scopes: k.scopes, triageAgentId: k.triageAgent?.id ?? '' }}
                        submitLabel="Enregistrer"
                        withSigning={false}
                        onCancel={() => setEditing(null)}
                        onSubmit={async (v) => {
                          const res = await update({ variables: { id: k.id, name: v.name, scopes: v.scopes, triageAgentId: v.triageAgentId } });
                          if (res.data) setEditing(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={k.id}>
                    <td>
                      <strong>{k.name}</strong> <code className="text-secondary">{k.prefix}…</code>
                      <div className="d-flex flex-wrap gap-1 mt-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} bg="secondary" className="fw-normal font-monospace">
                            {s}
                          </Badge>
                        ))}
                        {k.signed && (
                          <Badge bg="info" className="fw-normal">
                            signée
                          </Badge>
                        )}
                      </div>
                      {k.scopes.includes('inbound:triage') && <div className="text-secondary mt-1">Triage : {k.triageAgent?.name ?? 'Product Manager du projet'}</div>}
                      <div className="text-secondary mt-1">
                        créée {new Date(k.createdAt).toLocaleDateString()}
                        {k.createdBy && ` par ${k.createdBy.name}`} · {k.lastUsedAt ? `utilisée le ${new Date(k.lastUsedAt).toLocaleString()}` : 'jamais utilisée'}
                      </div>
                    </td>
                    <td className="text-end">
                      <Button size="sm" variant="link" className="p-0 me-2" onClick={() => setEditing(k.id)}>
                        Modifier
                      </Button>
                      {k.scopes.some((s) => s.startsWith('inbound:')) && (
                        <Button
                          size="sm"
                          variant="link"
                          className="p-0 me-2"
                          onClick={async () => {
                            if (k.signed && !(await confirm({ title: 'Nouveau secret de signature', message: `Générer un nouveau secret de signature pour « ${k.name} » ? L'ancien cessera aussitôt de valoir.`, confirmLabel: 'Générer' }))) return;
                            const res = await setSigning({ variables: { id: k.id, enabled: true } });
                            const secret = res.data?.setProjectApiKeySigning.signingSecret;
                            if (secret) setNewSigning({ name: k.name, signingSecret: secret });
                          }}
                        >
                          {k.signed ? 'Nouveau secret' : 'Exiger une signature'}
                        </Button>
                      )}
                      {k.signed && (
                        <Button
                          size="sm"
                          variant="link"
                          className="p-0 me-2"
                          onClick={async () => {
                            if (await confirm({ title: 'Retirer la signature', message: `Ne plus exiger de signature sur les événements de « ${k.name} » ?`, confirmLabel: 'Retirer', danger: true })) await setSigning({ variables: { id: k.id, enabled: false } });
                          }}
                        >
                          Retirer la signature
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="link"
                        className="p-0 text-danger"
                        onClick={async () => {
                          if (await confirm({ title: 'Révoquer la clé', message: `Révoquer la clé « ${k.name} » ? Les outils qui l'utilisent n'auront plus accès.`, confirmLabel: 'Révoquer', danger: true })) remove({ variables: { id: k.id } });
                        }}
                      >
                        Révoquer
                      </Button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </Table>
        )}
        {adding ? (
          <KeyForm
            agents={agents}
            initial={{ name: '', scopes: ['tasks:read', 'tasks:write'], triageAgentId: '' }}
            submitLabel="Créer la clé"
            withSigning
            onCancel={() => setAdding(false)}
            onSubmit={async (v) => {
              const res = await create({ variables: { projectId, name: v.name, scopes: v.scopes, triageAgentId: v.triageAgentId || null, signed: v.signed } });
              if (res.data) {
                setCreated({ name: v.name, secret: res.data.createProjectApiKey.secret, signingSecret: res.data.createProjectApiKey.signingSecret, scopes: res.data.createProjectApiKey.key.scopes });
                setAdding(false);
              }
            }}
          />
        ) : (
          <Button size="sm" variant="outline-secondary" onClick={() => setAdding(true)}>
            <i className="bi bi-key me-1" /> Nouvelle clé
          </Button>
        )}
        {events.length > 0 && (
          <>
            <div className="mt-3 mb-1 fw-semibold">Derniers événements entrants</div>
            <Table size="sm" className="mb-0 table-stack">
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="text-secondary text-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
                    <td>
                      {e.source ?? e.keyName}
                      {e.externalId && <code className="text-secondary ms-1">{e.externalId}</code>}
                    </td>
                    <td>
                      {e.task && <Link to={`/tasks/${e.task.id}`}>{e.task.title}</Link>}
                      {e.triage && (
                        <span className="text-secondary">
                          {e.task ? ' · ' : ''}triage {e.agent ? `par ${e.agent.name}` : ''}
                          {e.session && (
                            <>
                              {' '}
                              (<Link to={`/sessions/${e.session.id}`}>session</Link>)
                            </>
                          )}
                        </span>
                      )}
                      {e.error && <div className="text-danger">{e.error}</div>}
                    </td>
                    <td className="text-end">
                      <Badge bg={STATUS_VARIANT[e.status] ?? 'secondary'} className="fw-normal">
                        {STATUS_LABEL[e.status] ?? e.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card.Body>
    </Card>
  );
}
