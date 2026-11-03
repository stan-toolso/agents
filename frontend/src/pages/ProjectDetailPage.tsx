import { useMemo, useState } from 'react';
import GoneNotice from '../components/GoneNotice';
import { isGoneError } from '../lib/gone';
import { Alert, Badge, Button, Col, Row, Spinner } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import AgentAvatar from '../components/AgentAvatar';
import ChannelThread from '../components/ChannelThread';
import { PullRequestRow, RequestRow, SessionRow, TaskRow, UsageTile, isRecent, plural, shorten, statusIcon } from '../components/DashboardRows';
import { ProjectPageLoading } from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import TaskModal from '../components/TaskModal';
import { agentKindLabels } from '../graphql/agents';
import { PROJECT_DASHBOARD, type ProjectDashboard, type ProjectTeamMember } from '../graphql/dashboard';
import type { Project, Task } from '../graphql/operations';
import { formatCost, timeAgo } from '../lib/humanize';
import { forecast, isOpen, leadTimes, percentile, weeklyBuckets } from '../lib/taskStats';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';
import { initialsOf } from '../workbench/WorkspaceTabs';
import './dashboard.css';
import './conversations.css';

const REFETCH = ['ProjectDashboard'];
/** Ordre du vocabulaire des étiquettes d'état des agents (templates.ts) ; les autres étiquettes suivent, par ordre alphabétique. */
const STAGE_ORDER = ['à cadrer', 'prête', 'en dev', 'à valider', 'à livrer', 'livrée'];
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

interface Data {
  project: (Pick<Project, 'id' | 'name' | 'description' | 'myRole' | 'isPersonal' | 'gitUrl'> & { git: { branch: string; commit: string } | null }) | null;
  projectDashboard: ProjectDashboard;
}

/**
 * Tableau de bord d'un projet (onglet par défaut) : ce qui attend une réponse, le canal général pour parler à l'équipe,
 * qui fait quoi, le flux des tâches par étiquette d'état, le débit, la consommation, les prochaines échéances et
 * l'activité récente. Une seule requête, rafraîchie toutes les 10 s ; le canal se rafraîchit de lui-même.
 */
export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = usePollingQuery<Data>(PROJECT_DASHBOARD, { variables: { id }, pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const [newTask, setNewTask] = useState(false);
  const { user, costUnit } = useAuth();
  const showCostTile = costUnit === 'CREDIT' || Boolean(user?.isSuperAdmin);
  const project = data?.project ?? null;
  const d = data?.projectDashboard ?? null;
  useTabTitle(project?.name);
  useGitTarget(project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);
  const stats = useMemo(() => (d ? computeStats(d.tasks) : null), [d]);

  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (isGoneError(error) || (!error && !project)) return <GoneNotice what="Ce projet" />;
  if (error && !data) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project || !d || !stats) return <Alert variant="warning">Projet introuvable.</Alert>;
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const { counts } = d;
  const idle = d.runningSessions.filter((s) => s.activity !== 'BUSY' && s.pendingRequestCount === 0);
  const failed = d.recentSessions.filter((s) => s.status === 'FAILED' && isRecent(s.endedAt ?? s.updatedAt, 24));
  const interrupted = d.recentSessions.filter((s) => s.status === 'INTERRUPTED' && s.activity === 'BUSY' && isRecent(s.endedAt ?? s.updatedAt, 24));
  const toValidate = d.tasks.filter((t) => isOpen(t) && t.statusTag && fold(t.statusTag) === 'a valider');
  const todo = d.pendingRequests.length + idle.length + failed.length + interrupted.length + d.staleTasks.length + d.pullRequests.length + toValidate.length;
  const upcomingTasks = d.tasks.filter((t) => isOpen(t) && t.dueDate).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')).slice(0, 5);
  const activity = recentActivity(d);

  return (
    <>
      <ProjectHeader
        project={project}
        active="overview"
        actions={
          canWrite ? (
            <Button size="sm" variant="outline-primary" onClick={() => setNewTask(true)}>
              <i className="bi bi-plus-lg me-1" /> Nouvelle tâche
            </Button>
          ) : undefined
        }
      />
      {newTask && <TaskModal task={null} projectId={project.id} onClose={() => setNewTask(false)} />}
      {error && <Alert variant="warning" className="py-2 small">Dernier rafraîchissement en échec : {error.message}</Alert>}

      <div className="dash-tiles mb-4">
        <Link to="/requests" className={`dash-tile${counts.pendingRequests ? ' alert' : ''}`}>
          <div className="dash-tile-label"><i className="bi bi-hand-index-thumb" /> Demandes en attente</div>
          <div className="dash-tile-value">{counts.pendingRequests}</div>
          <div className="dash-tile-sub">{counts.pendingRequests ? 'Des agents sont bloqués jusqu’à votre réponse' : counts.idleSessions ? `${plural(counts.idleSessions, 'agent attend', 'agents attendent')} vos instructions` : 'Rien ne vous attend'}</div>
        </Link>
        <Link to="/sessions" className="dash-tile">
          <div className="dash-tile-label"><i className="bi bi-cpu" /> Agents au travail</div>
          <div className="dash-tile-value">
            {counts.busySessions}
            {counts.idleSessions > 0 && <small>+ {counts.idleSessions} en attente</small>}
          </div>
          <div className="dash-tile-sub">
            {counts.endedSessions24h ? `${plural(counts.endedSessions24h, 'session terminée', 'sessions terminées')} depuis 24 h` : 'Aucune session terminée depuis 24 h'}
            {counts.failedSessions24h > 0 && <span className="up">, {counts.failedSessions24h} en erreur</span>}
          </div>
        </Link>
        <Link to={`/projects/${project.id}/tasks`} className={`dash-tile${counts.overdueTasks || d.staleTasks.length ? ' alert' : ''}`}>
          <div className="dash-tile-label"><i className="bi bi-check2-square" /> Tâches ouvertes</div>
          <div className="dash-tile-value">
            {counts.todoTasks + counts.inProgressTasks}
            <small>{counts.inProgressTasks} en cours</small>
          </div>
          <div className="dash-tile-sub">
            {counts.overdueTasks > 0 && <span className="up">{plural(counts.overdueTasks, 'en retard', 'en retard')} · </span>}
            {d.staleTasks.length > 0 && <span className="up">{plural(d.staleTasks.length, 'abandonnée', 'abandonnées')} · </span>}
            {plural(counts.doneTasks7d, 'terminée', 'terminées')} sur 7 jours
          </div>
        </Link>
        {showCostTile ? (
          <UsageTile usage={d.usage} />
        ) : (
          <Link to={`/projects/${project.id}/pull-requests`} className="dash-tile">
            <div className="dash-tile-label"><i className="bi bi-git" /> Pull requests</div>
            <div className="dash-tile-value">
              {counts.openPullRequests}
              <small>à fusionner</small>
            </div>
            <div className="dash-tile-sub">{counts.pendingPullRequests ? `${plural(counts.pendingPullRequests, 'branche en préparation', 'branches en préparation')}` : project.git ? `${project.git.branch} @ ${project.git.commit}` : 'Aucune branche en préparation'}</div>
          </Link>
        )}
      </div>

      <Row className="g-4">
        <Col lg={7}>
          {d.general && (
            <section className="dash-section">
              <h2 className="dash-section-title">
                <span>
                  <i className="bi bi-chat-left-text me-1" /><span style={{ textTransform: 'none', letterSpacing: 0 }}>#{d.general.slug}</span>
                  <span className="text-secondary ms-2" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>parlez à l’équipe : @Nom prévient une personne, @Agent le fait répondre</span>
                </span>
                <Link to={`/projects/${project.id}/conversations`}>Toutes les conversations{d.general.unreadCount > 0 && <Badge bg="primary" pill className="ms-1">{d.general.unreadCount}</Badge>}</Link>
              </h2>
              <div className="dash-embedded-channel">
                <div className="ch-embedded ch-scroll">
                  <ChannelThread conversationId={d.general.id} canWrite={canWrite} compact limit={6} placeholder="Écrire à l’équipe… (@ pour mentionner une personne ou un agent)" />
                </div>
              </div>
            </section>
          )}

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>À traiter{todo > 0 && <Badge bg="warning" text="dark" className="ms-2">{todo}</Badge>}</span>
              <Link to="/inbox">Toute la file</Link>
            </h2>
            <ul className="dash-list">
              {d.pendingRequests.map((r) => <RequestRow key={r.id} request={r} showProject={false} />)}
              {idle.map((s) => <SessionRow key={s.id} session={s} hint="attend vos instructions" icon="bi-chat-left-dots warn" showProject={false} refetch={REFETCH} />)}
              {failed.map((s) => <SessionRow key={s.id} session={s} hint={s.error ? shorten(s.error, 80) : 'en erreur'} icon="bi-x-octagon bad" showProject={false} refetch={REFETCH} />)}
              {interrupted.map((s) => <SessionRow key={s.id} session={s} hint="interrompue en plein travail par un redémarrage" icon="bi-pause-circle warn" showProject={false} refetch={REFETCH} />)}
              {d.staleTasks.map((t) => <TaskRow key={t.id} task={t} showProject={false} hint="en cours, mais plus aucun agent dessus" icon="bi-person-x" />)}
              {toValidate.map((t) => <TaskRow key={t.id} task={t} showProject={false} hint="à valider : quelque chose à essayer" icon="bi-eye" />)}
              {d.pullRequests.map((pr) => <PullRequestRow key={pr.id} pr={pr} showProject={false} />)}
              {todo === 0 && <li className="empty">Rien à traiter : les agents n’ont besoin de rien pour l’instant.</li>}
            </ul>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>L’équipe en ce moment</span>
              <Link to={`/projects/${project.id}/agents`}>Agents</Link>
            </h2>
            <ul className="dash-list">
              {d.team.map((m) => <TeamRow key={m.user.id} member={m} projectId={project.id} />)}
              {d.team.length === 0 && <li className="empty">Aucun membre.</li>}
            </ul>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Tâches à surveiller</span>
              <Link to={`/projects/${project.id}/tasks`}>Toutes les tâches</Link>
            </h2>
            <ul className="dash-list">
              {d.attentionTasks.map((t) => <TaskRow key={t.id} task={t} showProject={false} />)}
              {d.attentionTasks.length === 0 && <li className="empty">Aucune tâche urgente, haute ou en retard.</li>}
            </ul>
          </section>
        </Col>

        <Col lg={5}>
          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Flux des tâches</span>
              <Link to={`/projects/${project.id}/tasks?view=dashboard`}>Pilotage</Link>
            </h2>
            <div className="task-dash-card">
              {stats.stages.length > 0 ? (
                <div className="dash-flow">
                  {stats.stages.map((s) => (
                    <Link key={s.key} to={`/projects/${project.id}/tasks`} className={`dash-flow-stage${s.count === stats.maxStage && stats.stages.length > 1 && s.count > 0 ? ' hot' : ''}`} title={`${s.count} tâche${s.count > 1 ? 's' : ''} ${s.label}`}>
                      <b>{s.count}</b>
                      <small>{s.label}</small>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="hint">Aucune tâche ouverte.</div>
              )}
              <div className="dash-kpis">
                <div><b>{stats.done7d}</b>terminées / 7 j</div>
                <div><b>{stats.leadP50 != null ? `${stats.leadP50} j` : '—'}</b>délai médian</div>
                <div><b>{stats.forecastWeeks != null ? (stats.forecastWeeks === 0 ? 'rien' : `~${stats.forecastWeeks} sem.`) : '—'}</b>pour finir le reste</div>
              </div>
            </div>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Débit hebdomadaire</span>
              <span className="text-secondary" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 12 }}>créées · terminées, 8 semaines</span>
            </h2>
            <div className="task-dash-card">
              <WeeklyChart weeks={stats.weeks} />
            </div>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Prochainement</span>
              <Link to={`/projects/${project.id}/schedules`}>Planifications</Link>
            </h2>
            <ul className="dash-list">
              {d.schedules.filter((s) => s.enabled && s.nextRunAt).slice(0, 4).map((s) => (
                <li key={s.sessionId}>
                  <i className="bi bi-alarm icon" />
                  <div className="main">
                    <Link to={`/sessions/${s.session.id}`} className="title">{s.name}</Link>
                    <div className="meta">{s.session.owner?.name ?? 'planification'}{s.lastResult && ` · dernière exécution : ${s.lastResult}`}</div>
                  </div>
                  <div className="side">{s.nextRunAt && new Date(s.nextRunAt).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                </li>
              ))}
              {upcomingTasks.map((t) => <TaskRow key={t.id} task={t} showProject={false} hint="échéance" icon="bi-calendar-event" />)}
              {d.schedules.filter((s) => s.enabled && s.nextRunAt).length === 0 && upcomingTasks.length === 0 && <li className="empty">Aucune échéance ni planification.</li>}
            </ul>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Activité récente</span>
              <Link to={`/projects/${project.id}/history`}>Historique</Link>
            </h2>
            <ul className="dash-list">
              {activity.map((a) => (
                <li key={a.key}>
                  <i className={`bi ${a.icon} icon`} />
                  <div className="main">
                    {a.href ? (
                      <a href={a.href} target="_blank" rel="noreferrer" className="title">{a.title}</a>
                    ) : (
                      <Link to={a.to ?? '#'} className="title">{a.title}</Link>
                    )}
                    <div className="meta">{a.meta}</div>
                  </div>
                  <div className="side">{timeAgo(a.at)}</div>
                </li>
              ))}
              {activity.length === 0 && <li className="empty">Rien de récent.</li>}
            </ul>
          </section>

          {showCostTile && d.usage.topSessions.length > 0 && (
            <section className="dash-section">
              <h2 className="dash-section-title">
                <span>Sessions les plus coûteuses du mois</span>
              </h2>
              <ul className="dash-list">
                {d.usage.topSessions.slice(0, 5).map((r, i) => (
                  <li key={r.sessionId ?? i}>
                    <i className="bi bi-cash-coin icon" />
                    <div className="main">
                      {r.sessionId ? <Link to={`/sessions/${r.sessionId}`} className="title">{r.sessionName ?? 'Session supprimée'}</Link> : <span className="title text-secondary">Session supprimée</span>}
                    </div>
                    <div className="side">{formatCost(r.usd)}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Col>
      </Row>
    </>
  );
}

/** Un membre de l'équipe : avatar, ce qu'il fait (tâches en charge de ses sessions), état. */
function TeamRow({ member: m, projectId }: { member: ProjectTeamMember; projectId: string }) {
  const busy = m.sessions.some((s) => s.activity === 'BUSY');
  const waiting = m.sessions.some((s) => s.pendingRequestCount > 0 || s.activity !== 'BUSY');
  const doing = m.tasks.length ? m.tasks.map((t) => t.title).slice(0, 2).join(', ') + (m.tasks.length > 2 ? ` et ${m.tasks.length - 2} autre${m.tasks.length > 3 ? 's' : ''}` : '') : m.sessions.length ? m.sessions.map((s) => s.name).slice(0, 2).join(', ') : null;
  return (
    <li>
      {m.agent ? <AgentAvatar agent={m.agent} size={26} className="icon" /> : <span className="dash-initials">{initialsOf(m.user.name || m.user.email)}</span>}
      <div className="main">
        <span className="title">
          {m.agent ? <Link to={`/projects/${projectId}/agents/${m.agent.id}`}>{m.user.name}</Link> : m.user.name || m.user.email}
          {m.agent && <span className="text-secondary small ms-2">{agentKindLabels[m.agent.kind]}</span>}
        </span>
        <div className="meta">
          {doing ? (
            <>
              {m.tasks.length ? 'sur ' : ''}
              {m.tasks.length ? m.tasks.slice(0, 2).map((t, i) => <span key={t.id}>{i > 0 && ', '}<Link to={`/tasks/${t.id}`}>{t.title}</Link>{t.statusTag && ` (${t.statusTag})`}</span>) : doing}
            </>
          ) : (
            <span>{m.agent ? 'disponible' : 'aucune session en cours'}</span>
          )}
        </div>
      </div>
      <div className="side">
        {busy ? (
          <span className="text-success"><i className="bi bi-circle-fill me-1" style={{ fontSize: 8 }} />au travail</span>
        ) : waiting && m.sessions.length ? (
          <span className="text-warning"><i className="bi bi-circle-fill me-1" style={{ fontSize: 8 }} />en attente</span>
        ) : m.lastActivityAt ? (
          `actif ${timeAgo(m.lastActivityAt)}`
        ) : (
          '—'
        )}
      </div>
    </li>
  );
}

/** Créées et terminées par semaine : deux colonnes fines par semaine (créées en gris, terminées en accent). */
function WeeklyChart({ weeks }: { weeks: { label: string; created: number; done: number }[] }) {
  const w = 300;
  const h = 90;
  const padB = 16;
  const max = Math.max(1, ...weeks.map((b) => Math.max(b.created, b.done)));
  const slot = w / weeks.length;
  const bar = Math.min(14, (slot - 8) / 2);
  return (
    <svg className="task-dash-chart" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Tâches créées et terminées par semaine">
      <line className="grid" x1={0} x2={w} y1={h - padB} y2={h - padB} />
      {weeks.map((b, i) => {
        const x = i * slot + (slot - 2 * bar - 2) / 2;
        const hc = (b.created / max) * (h - padB - 12);
        const hd = (b.done / max) * (h - padB - 12);
        const last = i === weeks.length - 1;
        return (
          <g key={b.label} className="slot">
            <path className={`created${last ? ' current' : ''}`} d={`M${x},${h - padB - hc}h${bar}v${hc}h${-bar}z`} />
            <path className={`finished${last ? ' current' : ''}`} d={`M${x + bar + 2},${h - padB - hd}h${bar}v${hd}h${-bar}z`} />
            <rect className="hit" x={i * slot} y={0} width={slot} height={h}>
              <title>{`Semaine du ${b.label} : ${b.created} créée${b.created > 1 ? 's' : ''}, ${b.done} terminée${b.done > 1 ? 's' : ''}`}</title>
            </rect>
            {(i === 0 || last) && (
              <text x={i * slot + slot / 2} y={h - 3} textAnchor="middle">{last ? 'cette sem.' : b.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---- Calculs ------------------------------------------------------------------------------------

/** Flux par étiquette d'état, débit, délai médian et prévision, à partir des tâches du projet. */
function computeStats(tasks: Task[]) {
  const now = new Date();
  const open = tasks.filter(isOpen);
  const byStage = new Map<string, { key: string; label: string; count: number }>();
  for (const t of open) {
    const label = t.statusTag?.trim() || (t.status === 'IN_PROGRESS' ? 'en cours' : 'à faire');
    const key = fold(label);
    const cur = byStage.get(key) ?? { key, label, count: 0 };
    cur.count += 1;
    byStage.set(key, cur);
  }
  const rank = (key: string) => {
    const i = STAGE_ORDER.findIndex((s) => fold(s) === key);
    return i >= 0 ? i : STAGE_ORDER.length + (key === 'a faire' ? 0 : key === 'en cours' ? 1 : 2);
  };
  const stages = [...byStage.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label)).slice(0, 7);
  const weeks = weeklyBuckets(tasks, now, 8);
  const done7d = tasks.filter((t) => t.status === 'DONE' && t.completedAt && now.getTime() - new Date(t.completedAt).getTime() < 7 * 86_400_000).length;
  const leads = leadTimes(tasks, now, 8).sort((a, b) => a - b);
  const leadP50 = leads.length ? Math.round(percentile(leads, 50) * 10) / 10 : null;
  const fc = forecast(open.length, weeks.slice(0, -1).map((w) => w.done));
  return { stages, maxStage: Math.max(0, ...stages.map((s) => s.count)), weeks, done7d, leadP50, forecastWeeks: fc ? fc.p50 : null };
}

interface ActivityItem {
  key: string;
  icon: string;
  title: string;
  meta: string;
  at: string;
  to?: string;
  href?: string;
}

/** Sessions terminées, PR fusionnées et tâches terminées, mêlées par date. */
function recentActivity(d: ProjectDashboard): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const s of d.recentSessions.slice(0, 6)) items.push({ key: `s-${s.id}`, icon: statusIcon(s), title: s.name, meta: `session ${s.status === 'COMPLETED' ? 'terminée' : s.status === 'FAILED' ? 'en erreur' : s.status === 'INTERRUPTED' ? 'interrompue' : 'arrêtée'}${s.owner ? ` · ${s.owner.name}` : ''}${s.costUsd > 0 ? ` · ${formatCost(s.costUsd)}` : ''}`, at: s.endedAt ?? s.updatedAt, to: `/sessions/${s.id}` });
  for (const pr of d.mergedPullRequests.slice(0, 5)) items.push({ key: `pr-${pr.id}`, icon: 'bi-git', title: `${pr.title}`, meta: `pull request fusionnée${pr.task ? ` · ${pr.task.title}` : ''}`, at: pr.mergedAt ?? pr.updatedAt, href: pr.url });
  for (const t of d.tasks.filter((x) => x.status === 'DONE' && x.completedAt).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).slice(0, 5)) items.push({ key: `t-${t.id}`, icon: 'bi-check2-square', title: t.title, meta: `tâche terminée${t.assignee?.name ? ` · ${t.assignee.name}` : ''}`, at: t.completedAt ?? t.updatedAt, to: `/tasks/${t.id}` });
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}
