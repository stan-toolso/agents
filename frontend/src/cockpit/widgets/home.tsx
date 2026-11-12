import { Card, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { RateLimitGauges, plural } from '../../components/DashboardRows';
import type { DashboardProject, DashboardUsage } from '../../graphql/operations';
import { formatCost, getCostUnit, timeAgo } from '../../lib/humanize';
import { useElementWidth } from '../../lib/useElementWidth';
import { Section, type WidgetProps } from '../registry';

/** Blocs de l'accueil : la carte de consommation détaillée et la table des projets. */

export function UsageCardWidget({ block, ctx }: WidgetProps) {
  const usage = ctx.kind === 'project' ? ctx.project?.d.usage : ctx.home?.usage;
  if (!usage) return null;
  const monthLabel = new Date(usage.monthStart).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return (
    <Section title={block.title || 'Consommation'} aside={getCostUnit() === 'CREDIT' ? 'en crédits' : 'estimation au tarif API'}>
      <Card>
        <Card.Body className="pb-2">
          <div className="d-flex justify-content-between align-items-baseline">
            <span className="text-secondary small">{ctx.kind === 'project' ? 'Sur ce projet' : 'Sur vos projets'}, en {monthLabel}</span>
            <span className="fw-semibold">{formatCost(usage.monthUsd)}</span>
          </div>
          {usage.monthlyBudgetUsd != null && usage.globalMonthUsd !== usage.monthUsd && (
            <div className="d-flex justify-content-between align-items-baseline small text-secondary">
              <span>Tous projets confondus (plafond {formatCost(usage.monthlyBudgetUsd)})</span>
              <span>{formatCost(usage.globalMonthUsd)}</span>
            </div>
          )}
          <DailyChart days={usage.byDay} />
          <div className="mt-3">
            <div className="text-secondary small mb-1">Limites d'utilisation de l'abonnement Claude</div>
            <RateLimitGauges limits={usage.rateLimits} />
          </div>
          {usage.topSessions.length > 0 && (
            <Table size="sm" className="mt-3 mb-0">
              <thead>
                <tr>
                  <th>Sessions les plus coûteuses du mois</th>
                  <th className="text-end">Coût</th>
                </tr>
              </thead>
              <tbody>
                {usage.topSessions.map((r, i) => (
                  <tr key={r.sessionId ?? i}>
                    <td className="text-truncate" style={{ maxWidth: 260 }}>
                      {r.sessionId ? <Link to={`/sessions/${r.sessionId}`}>{r.sessionName ?? 'Session supprimée'}</Link> : <span className="text-secondary">Session supprimée</span>}
                      {r.projectName && <span className="text-secondary small ms-2">{r.projectName}</span>}
                    </td>
                    <td className="text-end text-nowrap">{formatCost(r.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {usage.monthUsd === 0 && <div className="text-secondary small mt-2">Aucune consommation enregistrée ce mois-ci.</div>}
        </Card.Body>
      </Card>
    </Section>
  );
}

/** Colonnes par jour sur 30 jours, une seule série : la couleur d'accent, le jour courant en plein. */
function DailyChart({ days }: { days: DashboardUsage['byDay'] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  if (!days.length) return null;
  const height = 96;
  const padTop = 14;
  const padBottom = 14;
  const plotH = height - padTop - padBottom;
  const max = Math.max(...days.map((d) => d.usd), 0.01);
  const slot = width / days.length;
  const barW = Math.min(16, Math.max(3, slot - 2));
  const today = days[days.length - 1];
  const peak = days.reduce((a, b) => (b.usd > a.usd ? b : a), days[0]);
  const label = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return (
    <div ref={ref} className="dash-chart-wrap">
      {width > 0 && (
        <svg className="dash-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Consommation par jour sur ${days.length} jours`}>
          <line x1={0} x2={width} y1={height - padBottom} y2={height - padBottom} />
          {days.map((d, i) => {
            const h = d.usd > 0 ? Math.max(2, (d.usd / max) * plotH) : 0;
            const x = i * slot + (slot - barW) / 2;
            const y = height - padBottom - h;
            return (
              <g key={d.day}>
                <rect x={x} y={y} width={barW} height={h} rx={Math.min(4, barW / 2)} className={d === today ? 'bar today' : 'bar'} />
                <rect x={i * slot} y={0} width={slot} height={height} className="hit">
                  <title>{`${label(d.day)} : ${formatCost(d.usd)}`}</title>
                </rect>
                {d === peak && d.usd > 0 && (
                  <text x={Math.min(width - 4, Math.max(4, x + barW / 2))} y={Math.max(10, y - 3)} textAnchor={i < days.length / 4 ? 'start' : i > (days.length * 3) / 4 ? 'end' : 'middle'}>
                    {formatCost(d.usd)}
                  </text>
                )}
              </g>
            );
          })}
          <text x={2} y={height - 3}>{label(days[0].day)}</text>
          <text x={width - 2} y={height - 3} textAnchor="end">aujourd’hui</text>
        </svg>
      )}
    </div>
  );
}

export function ProjectsTableWidget({ block, ctx }: WidgetProps) {
  const projects = ctx.home?.projects;
  if (!projects) return null;
  return (
    <Section title={block.title || 'Projets'} link={{ to: '/projects', label: 'Tous les projets' }}>
      <ProjectsTable projects={projects} />
    </Section>
  );
}

function ProjectsTable({ projects }: { projects: DashboardProject[] }) {
  const num = (v: number, warn = false) => <td className={`num${v === 0 ? ' zero' : warn ? ' text-warning' : ''}`}>{v}</td>;
  return (
    <>
      <ul className="dash-list dash-project-cards">
        {projects.map((p) => (
          <li key={p.project.id}>
            <div className="main">
              <Link to={`/projects/${p.project.id}`} className="title fw-semibold">{p.project.name}</Link>
              <div className="meta wrap">
                {p.busySessions > 0 && <span className="text-body"><i className="bi bi-cpu me-1" />{plural(p.busySessions, 'agent au travail', 'agents au travail')}</span>}
                {p.idleSessions > 0 && <span className="text-warning"><i className="bi bi-chat-left-dots me-1" />{plural(p.idleSessions, 'en attente', 'en attente')}</span>}
                {p.pendingRequests > 0 && <Link to="/requests" className="text-warning"><i className="bi bi-hand-index-thumb me-1" />{plural(p.pendingRequests, 'demande', 'demandes')}</Link>}
                <Link to={`/projects/${p.project.id}/tasks`} className="text-reset text-decoration-none"><i className="bi bi-check2-square me-1" />{p.todoTasks} à faire, {p.inProgressTasks} en cours</Link>
                {p.overdueTasks > 0 && <span className="text-warning">{plural(p.overdueTasks, 'en retard', 'en retard')}</span>}
                {p.busySessions + p.idleSessions + p.pendingRequests + p.todoTasks + p.inProgressTasks === 0 && <span>Rien en cours</span>}
              </div>
            </div>
            <div className="side">
              <div>{formatCost(p.monthUsd)}</div>
              <div>{p.lastActivityAt ? timeAgo(p.lastActivityAt) : '—'}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="table-responsive dash-project-table">
        <Table hover size="sm" className="align-middle dash-projects mb-0">
          <thead>
            <tr>
              <th>Projet</th>
              <th className="num" title="Agents qui travaillent">Au travail</th>
              <th className="num" title="Agents qui attendent vos instructions">En attente</th>
              <th className="num">Demandes</th>
              <th className="num">À faire</th>
              <th className="num">En cours</th>
              <th className="num">Ce mois</th>
              <th>Dernière activité</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.project.id}>
                <td className="name">
                  <Link to={`/projects/${p.project.id}`} className="fw-semibold text-decoration-none">{p.project.name}</Link>
                  <div className="small text-secondary">
                    {p.project.git?.branch && <span className="font-monospace me-2"><i className="bi bi-git me-1" />{p.project.git.branch}</span>}
                    {p.overdueTasks > 0 && <span className="text-warning">{plural(p.overdueTasks, 'tâche en retard', 'tâches en retard')}</span>}
                  </div>
                </td>
                {num(p.busySessions)}
                {num(p.idleSessions, true)}
                <td className={`num${p.pendingRequests ? ' text-warning fw-semibold' : ' zero'}`}>
                  {p.pendingRequests ? <Link to="/requests" className="text-warning">{p.pendingRequests}</Link> : 0}
                </td>
                <td className={`num${p.todoTasks === 0 ? ' zero' : ''}`}><Link to={`/projects/${p.project.id}/tasks`} className="text-reset text-decoration-none">{p.todoTasks}</Link></td>
                {num(p.inProgressTasks)}
                <td className={`num${p.monthUsd === 0 ? ' zero' : ''}`}>{formatCost(p.monthUsd)}</td>
                <td className="text-secondary small">{p.lastActivityAt ? timeAgo(p.lastActivityAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
