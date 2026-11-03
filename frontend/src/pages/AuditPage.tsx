import { useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Button, Form, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import { AUDIT_LOG, AUDIT_PROJECT, type AuditEntry, type AuditFacets, type AuditFilterInput } from '../graphql/audit';
import { actorFilter, auditCsvUrl, auditDetailSummary, auditTargetLink, periodFilter } from '../lib/audit';
import { timeAgo } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';

const PAGE = 100;

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' });

const ACTOR_ICONS = { HUMAN: 'bi-person', AGENT: 'bi-robot', SYSTEM: 'bi-gear' } as const;

/** Jour local au format AAAA-MM-JJ, `daysAgo` jours avant aujourd'hui. */
const dayInput = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function Actor({ e }: { e: AuditEntry }) {
  const person = e.actor ? e.actor.name || e.actor.email : null;
  const name = e.actorKind === 'AGENT' ? (person ?? 'Agent') : (e.actorLabel ?? person ?? 'Skipper');
  return (
    <span>
      <i className={`bi ${ACTOR_ICONS[e.actorKind]} me-1 text-secondary`} title={e.actorKind === 'HUMAN' ? 'Personne' : e.actorKind === 'AGENT' ? "Session d'agent" : 'Skipper (automatisme, clé d’API)'} />
      {name}
      {e.actorKind === 'AGENT' && e.sessionId && (
        <div className="small text-secondary text-truncate" style={{ maxWidth: 260 }}>
          <Link to={`/sessions/${e.sessionId}`} title="Session qui a agi">
            {e.actorLabel ?? 'session'}
          </Link>
        </div>
      )}
    </span>
  );
}

/**
 * Journal d'audit du projet : qui a fait quoi, personnes et agents (sessions, demandes, tâches, contexte, membres,
 * coffre, git…). Filtres par acteur, type et période ; export CSV avec les mêmes filtres. Ouvert aux lecteurs du projet.
 */
export default function AuditPage() {
  const { id = '' } = useParams();
  const [actor, setActor] = useState('');
  const [targetType, setTargetType] = useState('');
  const [action, setAction] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const filter: AuditFilterInput = useMemo(() => ({ ...actorFilter(actor), targetType: targetType || null, action: action || null, ...periodFilter(fromDay, toDay) }), [actor, targetType, action, fromDay, toDay]);

  const projectQ = useQuery<{ project: (ProjectHeaderProject & { id: string }) | null; auditFacets: AuditFacets }>(AUDIT_PROJECT, { variables: { id }, fetchPolicy: 'cache-and-network' });
  const logQ = useQuery<{ auditLog: AuditEntry[] }>(AUDIT_LOG, {
    variables: { projectId: id, filter, limit: PAGE },
    fetchPolicy: 'cache-and-network',
    onCompleted: (d) => {
      setOlder([]);
      setExhausted(d.auditLog.length < PAGE);
    },
  });
  const project = projectQ.data?.project;
  useTabTitle(project ? `Journal · ${project.name}` : null);

  const facets = projectQ.data?.auditFacets;
  const actions = useMemo(() => (facets?.actions ?? []).filter((a) => !targetType || a.value.startsWith(`${targetType}.`)), [facets, targetType]);
  const rows = [...(logQ.data?.auditLog ?? []), ...older];
  const filtered = Boolean(actor || targetType || action || fromDay || toDay);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const { data } = await logQ.fetchMore<{ auditLog: AuditEntry[] }>({ variables: { before: last.id }, updateQuery: (prev) => prev });
      setOlder((o) => [...o, ...data.auditLog]);
      if (data.auditLog.length < PAGE) setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const reset = () => {
    setActor('');
    setTargetType('');
    setAction('');
    setFromDay('');
    setToDay('');
  };

  if (projectQ.loading && !project) return <PageLoading />;
  if (projectQ.error) return <Alert variant="danger">Erreur : {projectQ.error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;

  return (
    <>
      <ProjectHeader project={project} active="audit" />
      <div className="audit-filters d-flex align-items-end flex-wrap gap-2 mb-3">
        <Form.Group>
          <Form.Label className="small text-secondary mb-0">Acteur</Form.Label>
          <Form.Select size="sm" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Acteur">
            <option value="">Tout le monde</option>
            <option value="kind:HUMAN">Personnes</option>
            <option value="kind:AGENT">Sessions d'agent</option>
            <option value="kind:SYSTEM">Skipper (automatismes, clés d'API)</option>
            {facets?.actors.length ? (
              <optgroup label="Une personne ou un agent">
                {[...facets.actors]
                  .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'fr'))
                  .map((u) => (
                    <option key={u.id} value={`user:${u.id}`}>
                      {u.name || u.email}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </Form.Select>
        </Form.Group>
        <Form.Group>
          <Form.Label className="small text-secondary mb-0">Type</Form.Label>
          <Form.Select
            size="sm"
            value={targetType}
            onChange={(e) => {
              setTargetType(e.target.value);
              setAction('');
            }}
            aria-label="Type"
          >
            <option value="">Tous les types</option>
            {facets?.targetTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group>
          <Form.Label className="small text-secondary mb-0">Action</Form.Label>
          <Form.Select size="sm" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
            <option value="">Toutes les actions</option>
            {actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group>
          <Form.Label className="small text-secondary mb-0">Du</Form.Label>
          <Form.Control type="date" size="sm" value={fromDay} max={toDay || undefined} onChange={(e) => setFromDay(e.target.value)} aria-label="Du" />
        </Form.Group>
        <Form.Group>
          <Form.Label className="small text-secondary mb-0">Au</Form.Label>
          <Form.Control type="date" size="sm" value={toDay} min={fromDay || undefined} onChange={(e) => setToDay(e.target.value)} aria-label="Au" />
        </Form.Group>
        <div className="d-flex gap-1">
          <Button size="sm" variant="outline-secondary" onClick={() => { setFromDay(dayInput(0)); setToDay(''); }} title="Aujourd'hui">
            Jour
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={() => { setFromDay(dayInput(6)); setToDay(''); }} title="7 derniers jours">
            7 j
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={() => { setFromDay(dayInput(29)); setToDay(''); }} title="30 derniers jours">
            30 j
          </Button>
          {filtered && (
            <Button size="sm" variant="link" onClick={reset}>
              Effacer les filtres
            </Button>
          )}
        </div>
        <Button as="a" size="sm" variant="outline-primary" className="ms-auto" href={auditCsvUrl(id, filter)} download title="Télécharge le journal filtré (10 000 lignes au plus)">
          <i className="bi bi-download me-1" />
          Export CSV
        </Button>
      </div>

      {logQ.error && <Alert variant="danger">{logQ.error.message}</Alert>}
      <Table size="sm" hover className="audit-table">
        <thead>
          <tr>
            <th className="d-none d-md-table-cell">Quand</th>
            <th>Acteur</th>
            <th>Action</th>
            <th className="d-none d-md-table-cell">Détails</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const link = auditTargetLink(e, id);
            const summary = auditDetailSummary(e);
            return (
              <tr key={e.id}>
                <td className="d-none d-md-table-cell text-nowrap" title={fmt(e.createdAt)}>
                  {timeAgo(e.createdAt)}
                </td>
                <td>
                  <Actor e={e} />
                  <div className="small text-secondary d-md-none" title={fmt(e.createdAt)}>
                    {timeAgo(e.createdAt)}
                  </div>
                </td>
                <td>
                  <span className="text-secondary small me-1">{e.targetTypeLabel}</span>
                  {e.actionLabel}
                  {e.targetLabel && <> {link ? <Link to={link}>{e.targetLabel}</Link> : <strong className="fw-semibold">{e.targetLabel}</strong>}</>}
                  {summary && <div className="small text-secondary d-md-none text-break">{summary}</div>}
                </td>
                <td className="d-none d-md-table-cell small text-secondary text-break" title={Object.keys(e.details).length ? JSON.stringify(e.details, null, 2) : undefined}>
                  {summary}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {!logQ.loading && !rows.length && <p className="text-secondary">{filtered ? 'Aucune action ne correspond à ces filtres.' : 'Aucune action inscrite pour l’instant.'}</p>}
      {rows.length > 0 && !exhausted && (
        <div className="text-center">
          <Button size="sm" variant="outline-secondary" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Chargement…' : 'Plus ancien'}
          </Button>
        </div>
      )}
      <p className="small text-secondary mt-3">
        Le journal garde les actions des personnes et des agents depuis sa mise en place : sessions lancées, arrêtées ou interrompues, réponses aux demandes, tâches, contexte, membres, autorisations, coffre, commits et push du panneau git, pull requests. Les messages et commentaires restent dans leurs fils ; les accès aux secrets ont aussi le journal de chaque élément du coffre.
      </p>
    </>
  );
}
