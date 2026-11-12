import { Card, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { formatCost, sessionStatusLabels, taskStatusLabels, timeAgo } from '../../lib/humanize';
import { intParam, type WidgetProps } from '../registry';

/** Blocs de l'onglet Activité d'un agent (portée agent:<id>) : quatre tuiles, ses sessions, ses tâches. */

function AgentTile({ value, label }: { value: React.ReactNode; label: React.ReactNode }) {
  return (
    <div className="dash-tile">
      <div className="dash-tile-value">{value}</div>
      <div className="dash-tile-sub">{label}</div>
    </div>
  );
}

export function AgentTileActiveWidget({ ctx }: WidgetProps) {
  const s = ctx.agent?.agent.stats;
  return s ? <AgentTile value={s.activeSessions} label={`session${s.activeSessions > 1 ? 's' : ''} en cours`} /> : null;
}
export function AgentTileSessionsWidget({ ctx }: WidgetProps) {
  const s = ctx.agent?.agent.stats;
  return s ? <AgentTile value={s.sessions} label="sessions au total" /> : null;
}
export function AgentTileTasksWidget({ ctx }: WidgetProps) {
  const s = ctx.agent?.agent.stats;
  return s ? <AgentTile value={s.tasks} label="tâches touchées" /> : null;
}
export function AgentTileCostWidget({ ctx }: WidgetProps) {
  const s = ctx.agent?.agent.stats;
  return s ? <AgentTile value={formatCost(s.monthCostUsd)} label={`ce mois · ${formatCost(s.totalCostUsd)} au total`} /> : null;
}

export function AgentSessionsWidget({ block, ctx, params }: WidgetProps) {
  if (!ctx.agent) return null;
  const { sessions, loading } = ctx.agent;
  const rows = sessions.slice(0, intParam(params, 'limit', 20));
  return (
    <Card className="mb-3">
      <Card.Header>{block.title || 'Sessions'}</Card.Header>
      <Card.Body className="p-0">
        {loading && !sessions.length ? (
          <div className="p-3 small text-secondary">Chargement…</div>
        ) : rows.length === 0 ? (
          <div className="p-3 small text-secondary">Aucune session pour le moment.</div>
        ) : (
          <Table size="sm" hover className="mb-0 align-middle table-stack">
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link to={`/sessions/${x.id}`}>{x.name}</Link>
                    {x.requestedBy && <div className="small text-secondary">demandée par {x.requestedBy.name}</div>}
                    {x.tasks.length > 0 && <div className="small text-secondary">{x.tasks.map((t) => t.title).join(' · ')}</div>}
                  </td>
                  <td className="small text-nowrap">{sessionStatusLabels[x.status] ?? x.status}</td>
                  <td className="small text-end text-nowrap">{x.costUsd > 0 ? formatCost(x.costUsd) : null}</td>
                  <td className="small text-secondary text-nowrap" title={new Date(x.updatedAt).toLocaleString('fr-FR')}>
                    {timeAgo(x.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  );
}

export function AgentTasksWidget({ block, ctx, params }: WidgetProps) {
  if (!ctx.agent) return null;
  const rows = ctx.agent.tasks.slice(0, intParam(params, 'limit', 20));
  return (
    <Card className="mb-3">
      <Card.Header>{block.title || 'Tâches'}</Card.Header>
      <Card.Body className="p-0">
        {rows.length === 0 ? (
          <div className="p-3 small text-secondary">Aucune tâche touchée pour le moment.</div>
        ) : (
          <Table size="sm" hover className="mb-0 align-middle">
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  </td>
                  <td className="small text-nowrap">
                    {taskStatusLabels[t.status] ?? t.status}
                    {t.statusTag && <span className="text-secondary"> · {t.statusTag}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  );
}
