import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Dropdown, Form, Modal } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AgentAvatar from '../components/AgentAvatar';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import { AGENT_TEMPLATES, CREATE_AGENT, PROJECT_AGENTS, RUN_AGENT_ACTION, SUMMON_AGENT, agentKindLabels, type Agent, type AgentRef, type AgentTemplate } from '../graphql/agents';
import { formatCost, timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

interface ProjectAgentsData {
  project: { id: string; name: string; description: string | null; myRole?: 'ADMIN' | 'MEMBER' | 'VIEWER'; isPersonal: boolean; agents: Agent[] } | null;
}

/**
 * « Parler à un agent » : un message, et une session de l'agent s'ouvre (il en est le propriétaire, la personne le
 * demandeur). Sans tâche : conversation libre dans son propre dossier ; avec `taskId`, sur la tâche.
 */
export function SummonAgentModal({ agent, taskId, onClose }: { agent: AgentRef; taskId?: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [summon, { loading, error }] = useMutation<{ summonAgent: { id: string } }>(SUMMON_AGENT, { refetchQueries: ['Sidebar', 'Sessions', 'ProjectAgents'] });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      const res = await summon({ variables: { id: agent.id, text: text.trim(), taskId: taskId ?? null } });
      onClose();
      if (res.data) navigate(`/sessions/${res.data.summonAgent.id}`);
    } catch {
      /* affichée sous la zone */
    }
  };
  return (
    <Modal show onHide={() => !loading && onClose()} centered size="lg" backdrop={loading ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton={!loading}>
          <Modal.Title className="h6 d-flex align-items-center gap-2">
            <AgentAvatar agent={agent} size={26} /> Parler à {agent.name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Control as="textarea" rows={6} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={taskId ? `Que voulez-vous dire à ${agent.name} au sujet de cette tâche ?` : `Décrivez votre besoin à ${agent.name}, comme à un collègue.`} />
          <Form.Text>{taskId ? `${agent.name} reçoit le message dans sa session sur la tâche (ou en ouvre une).` : `Une session de ${agent.name} s'ouvre avec ce message ; vous y suivez la conversation.`}</Form.Text>
          {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !text.trim()}>
            {loading ? 'Envoi…' : 'Envoyer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Menu « Actions » d'un agent : ses actions nommées, jouées à la demande (la session s'ouvre). */
export function AgentActionsMenu({ agent, size = 'sm', taskId }: { agent: Pick<Agent, 'id' | 'name' | 'actions' | 'enabled'>; size?: 'sm' | undefined; taskId?: string | null }) {
  const navigate = useNavigate();
  const { showError } = useDialogs();
  const [run, { loading }] = useMutation<{ runAgentAction: { id: string } }>(RUN_AGENT_ACTION, { refetchQueries: ['Sidebar', 'Sessions'] });
  if (!agent.actions.length) return null;
  return (
    <Dropdown>
      <Dropdown.Toggle size={size} variant="outline-secondary" disabled={loading || !agent.enabled} title={agent.enabled ? `Actions de ${agent.name}` : `${agent.name} est en pause`}>
        <i className="bi bi-play-circle me-1" /> Actions
      </Dropdown.Toggle>
      <Dropdown.Menu>
        {agent.actions.map((a) => (
          <Dropdown.Item
            key={a.key}
            title={a.instruction}
            onClick={() =>
              void run({ variables: { id: agent.id, key: a.key, taskId: taskId ?? null } })
                .then((res) => res.data && navigate(`/sessions/${res.data.runAgentAction.id}`))
                .catch(showError)
            }
          >
            {a.label}
            {a.cron && <i className="bi bi-alarm ms-2 text-secondary" title="Aussi planifiée" />}
          </Dropdown.Item>
        ))}
      </Dropdown.Menu>
    </Dropdown>
  );
}

function CreateAgentModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { data } = useQuery<{ agentTemplates: AgentTemplate[] }>(AGENT_TEMPLATES);
  const templates = data?.agentTemplates ?? [];
  const [kind, setKind] = useState<AgentTemplate['kind'] | ''>('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const template = templates.find((t) => t.kind === (kind || templates[0]?.kind));
  const effectiveName = touched ? name : (template?.suggestedName ?? '');
  const [create, { loading, error }] = useMutation<{ createAgent: Agent }>(CREATE_AGENT, { refetchQueries: ['ProjectAgents', 'ProjectMembers', 'MyAgents'] });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!template || !effectiveName.trim()) return;
    try {
      const res = await create({ variables: { projectId, input: { kind: template.kind, name: effectiveName.trim() } } });
      onClose();
      if (res.data) navigate(`/projects/${projectId}/agents/${res.data.createAgent.id}`);
    } catch {
      /* affichée */
    }
  };
  return (
    <Modal show onHide={() => !loading && onClose()} centered size="lg" backdrop={loading ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton={!loading}>
          <Modal.Title className="h6">Ajouter un agent</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Un agent est un membre du projet qui n'est pas une personne : il a ses propres comptes (Claude, GitHub…), ses instructions et ses déclencheurs. Choisissez un rôle de départ, vous pourrez tout adapter ensuite sur sa fiche.
          </p>
          <div className="d-grid gap-2 mb-3">
            {templates.map((t) => (
              <div key={t.kind} role="button" tabIndex={0} className={`agent-template${template?.kind === t.kind ? ' active' : ''}`} onClick={() => setKind(t.kind)} onKeyDown={(e) => e.key === 'Enter' && setKind(t.kind)}>
                <AgentAvatar agent={{ name: t.suggestedName || t.label, avatar: t.avatar }} size={34} />
                <div>
                  <div className="agent-template-label">{t.label}</div>
                  <div className="agent-template-desc">{t.description || 'Instructions, déclencheurs et actions à écrire.'}</div>
                </div>
              </div>
            ))}
          </div>
          <Form.Group>
            <Form.Label>Nom</Form.Label>
            <Form.Control
              value={effectiveName}
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
              }}
              placeholder="Léa, Max…"
              autoFocus
            />
            <Form.Text>C'est ainsi qu'on le mentionne dans les fils de tâches (@{effectiveName.trim() || 'Nom'}). Unique dans le projet.</Form.Text>
          </Form.Group>
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !template || !effectiveName.trim()}>
            {loading ? 'Création…' : "Créer l'agent"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const [talking, setTalking] = useState(false);
  const owner = agent.managers.find((m) => m.role === 'OWNER')?.user;
  const canWrite = agent.project.myRole === 'ADMIN' || agent.project.myRole === 'MEMBER';
  return (
    <div className={`agent-card${agent.enabled ? '' : ' paused'}`}>
      <div className="agent-card-head">
        <AgentAvatar agent={agent} size={44} />
        <div className="agent-card-title">
          <div className="agent-card-name">
            <Link to={`/projects/${agent.project.id}/agents/${agent.id}`} className="text-reset text-decoration-none">
              {agent.name}
            </Link>
            {!agent.enabled && <span className="badge text-bg-secondary">en pause</span>}
            {agent.stats.activeSessions > 0 && <span className="badge text-bg-success">{agent.stats.activeSessions > 1 ? `${agent.stats.activeSessions} sessions en cours` : 'au travail'}</span>}
          </div>
          <div className="agent-card-role">
            {agentKindLabels[agent.kind]}
            {owner && <> · propriétaire : {owner.name}</>}
          </div>
        </div>
      </div>
      <div className="agent-card-desc">{agent.description || <span className="fst-italic">Pas de description</span>}</div>
      <div className="agent-card-stats">
        <span>
          <b>{agent.stats.tasks}</b> tâche{agent.stats.tasks > 1 ? 's' : ''}
        </span>
        <span>
          <b>{agent.stats.sessions}</b> session{agent.stats.sessions > 1 ? 's' : ''}
        </span>
        <span>
          <b>{formatCost(agent.stats.monthCostUsd)}</b> ce mois
        </span>
        {agent.stats.lastActivityAt && <span title={new Date(agent.stats.lastActivityAt).toLocaleString('fr-FR')}>actif {timeAgo(agent.stats.lastActivityAt)}</span>}
      </div>
      <div className="agent-card-actions">
        {canWrite && (
          <Button size="sm" onClick={() => setTalking(true)} disabled={!agent.enabled}>
            <i className="bi bi-chat-left-text me-1" /> Parler à {agent.name}
          </Button>
        )}
        {canWrite && <AgentActionsMenu agent={agent} />}
        <Button as={Link as any} to={`/projects/${agent.project.id}/agents/${agent.id}`} size="sm" variant="outline-secondary">
          Fiche
        </Button>
      </div>
      {talking && <SummonAgentModal agent={agent} onClose={() => setTalking(false)} />}
    </div>
  );
}

/** Onglet « Agents » d'un projet : ses agents en cartes, création d'un agent d'après un modèle. */
export default function ProjectAgentsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = usePollingQuery<ProjectAgentsData>(PROJECT_AGENTS, { variables: { id }, pollInterval: 10_000 });
  const [creating, setCreating] = useState(false);
  const project = data?.project ?? null;
  useTabTitle(project ? `Agents · ${project.name}` : 'Agents');
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const agents = project.agents;
  return (
    <>
      <ProjectHeader
        project={project}
        active="agents"
        actions={
          canWrite &&
          !project.isPersonal && (
            <Button size="sm" variant="outline-primary" onClick={() => setCreating(true)}>
              <i className="bi bi-robot me-1" /> Ajouter un agent
            </Button>
          )
        }
      />
      {agents.length === 0 ? (
        <Alert variant="light" className="border">
          <div className="fw-semibold mb-1">Aucun agent dans ce projet.</div>
          <div className="small text-secondary">
            Un agent est un membre du projet qui n'est pas une personne. Le <b>Product Manager</b> cadre les demandes (chat, fil des tâches) et prépare les releases ; le <b>Developer</b> réalise les tâches qu'on lui confie et ouvre les pull requests. On le convoque en le mentionnant dans le fil d'une tâche (@Nom), en lui confiant une tâche ou en lui parlant.
          </div>
          {canWrite && !project.isPersonal && (
            <Button size="sm" className="mt-2" onClick={() => setCreating(true)}>
              <i className="bi bi-robot me-1" /> Ajouter un agent
            </Button>
          )}
        </Alert>
      ) : (
        <div className="agent-cards">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
      {creating && <CreateAgentModal projectId={project.id} onClose={() => setCreating(false)} />}
    </>
  );
}
