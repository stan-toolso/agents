import { Link } from 'react-router-dom';
import { UsageTile, plural } from '../../components/DashboardRows';
import type { WidgetProps } from '../registry';

/** Tuiles d'indicateurs (rangée du haut), communes à l'accueil et au tableau de bord d'un projet. */

const counts = (ctx: WidgetProps['ctx']) => (ctx.kind === 'project' ? ctx.project?.d.counts : ctx.home?.counts) ?? null;

export function TileRequestsWidget({ ctx }: WidgetProps) {
  const c = counts(ctx);
  if (!c) return null;
  return (
    <Link to="/requests" className={`dash-tile${c.pendingRequests ? ' alert' : ''}`}>
      <div className="dash-tile-label"><i className="bi bi-hand-index-thumb" /> Demandes en attente</div>
      <div className="dash-tile-value">{c.pendingRequests}</div>
      <div className="dash-tile-sub">{c.pendingRequests ? 'Des agents sont bloqués jusqu’à votre réponse' : 'Rien ne vous attend'}</div>
    </Link>
  );
}

export function TileAgentsWidget({ ctx }: WidgetProps) {
  const c = counts(ctx);
  if (!c) return null;
  return (
    <Link to="/sessions" className="dash-tile">
      <div className="dash-tile-label"><i className="bi bi-cpu" /> Agents au travail</div>
      <div className="dash-tile-value">
        {c.busySessions}
        {c.idleSessions > 0 && <small>+ {c.idleSessions} en attente</small>}
      </div>
      <div className="dash-tile-sub">
        {c.endedSessions24h ? `${plural(c.endedSessions24h, 'session terminée', 'sessions terminées')} depuis 24 h` : 'Aucune session terminée depuis 24 h'}
        {c.failedSessions24h > 0 && <span className="up">, {c.failedSessions24h} en erreur</span>}
      </div>
    </Link>
  );
}

export function TileTasksWidget({ ctx }: WidgetProps) {
  const c = counts(ctx);
  if (!c) return null;
  const stale = ctx.kind === 'project' ? ctx.project?.d.staleTasks.length ?? 0 : ctx.home?.staleTasks?.length ?? 0;
  const to = ctx.kind === 'project' && ctx.project ? `/projects/${ctx.project.project.id}/tasks` : '/tasks';
  return (
    <Link to={to} className={`dash-tile${c.overdueTasks || stale ? ' alert' : ''}`}>
      <div className="dash-tile-label"><i className="bi bi-check2-square" /> Tâches ouvertes</div>
      <div className="dash-tile-value">
        {c.todoTasks + c.inProgressTasks}
        <small>{c.inProgressTasks} en cours</small>
      </div>
      <div className="dash-tile-sub">
        {c.overdueTasks > 0 && <span className="up">{plural(c.overdueTasks, 'en retard', 'en retard')} · </span>}
        {stale > 0 && <span className="up">{plural(stale, 'agent arrêté', 'agents arrêtés')} · </span>}
        {plural(c.doneTasks7d, 'terminée', 'terminées')} sur 7 jours
      </div>
    </Link>
  );
}

export function TileUsageWidget({ ctx }: WidgetProps) {
  const usage = ctx.kind === 'project' ? ctx.project?.d.usage : ctx.home?.usage;
  return usage ? <UsageTile usage={usage} /> : null;
}

export function TilePullRequestsWidget({ ctx }: WidgetProps) {
  if (!ctx.project) return null;
  const { project, d } = ctx.project;
  const c = d.counts;
  return (
    <Link to={`/projects/${project.id}/pull-requests`} className="dash-tile">
      <div className="dash-tile-label"><i className="bi bi-git" /> Pull requests</div>
      <div className="dash-tile-value">
        {c.openPullRequests}
        <small>à fusionner</small>
      </div>
      <div className="dash-tile-sub">{c.pendingPullRequests ? `${plural(c.pendingPullRequests, 'branche en préparation', 'branches en préparation')}` : project.git ? `${project.git.branch} @ ${project.git.commit}` : 'Aucune branche en préparation'}</div>
    </Link>
  );
}
