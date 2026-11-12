import { Link } from 'react-router-dom';
import { AgingBars, Bars, BurnupChart, FlowChart, Item, PRIORITY_RANK, ThroughputChart, Tile, WATCH_ICONS, fmt1, sessionRank, sessionState } from '../../components/TaskDashboard';
import { PersonChip, TaskPriorityBadge, TaskStatusBadge, TaskTags } from '../../components/TaskBadges';
import TaskActions from '../../components/TaskActions';
import type { Task } from '../../graphql/operations';
import { timeAgo } from '../../lib/humanize';
import { DAY, WATCH_LABELS, agingWip, byAssignee, byPriority, formatDays, isOpen, nextTasks, shortDate, watchlist } from '../../lib/taskStats';
import { Section, intParam, type WidgetProps } from '../registry';
import type { Layout } from '../types';

/**
 * Blocs de la vue pilotage des tâches (portée project:<id>:tasks) : les tuiles, graphiques, répartitions et listes de
 * l'ancienne page, rendus depuis `ctx.tasks` (tâches du périmètre filtré, statistiques de lib/taskStats.ts, instant de
 * référence, période). Les composants de dessin restent dans components/TaskDashboard.tsx.
 */

/** Agencement par défaut, copie de backend/src/cockpit/defaults.ts : sert à la vue pilotage sans projet (tous les projets), non modifiable. */
export const DEFAULT_TASKS_LAYOUT: Layout = {
  v: 1,
  blocks: [
    ...['open', 'in_progress', 'done_week', 'overdue', 'throughput', 'lead_time', 'cycle_time', 'forecast', 'net_flow'].map((k) => ({ id: `d-pilot-tile-${k}`, kind: 'builtin' as const, widget: `pilot.tile.${k}`, region: 'tiles' as const })),
    ...['burnup', 'flow', 'by_priority', 'watchlist', 'next'].map((k) => ({ id: `d-pilot-${k.replace(/_/g, '-')}`, kind: 'builtin' as const, widget: `pilot.${k}`, region: 'main' as const })),
    ...['throughput', 'aging', 'by_assignee', 'in_progress', 'done'].map((k) => ({ id: `d-pilot-${k.replace(/_/g, '-')}`, kind: 'builtin' as const, widget: `pilot.${k}`, region: 'side' as const })),
  ],
};

const t = (p: WidgetProps) => p.ctx.tasks;

// ---- Tuiles --------------------------------------------------------------------------------------------------------

export function PilotTileOpen(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return <Tile icon="bi-check2-square" label={p.block.title || 'Ouvertes'} value={stats.open} sub={`${stats.todo} à faire · ${stats.inProgress} en cours${stats.important ? ` · ${stats.important} urgente${stats.important > 1 ? 's' : ''} ou haute${stats.important > 1 ? 's' : ''}` : ''}`} />;
}
export function PilotTileInProgress(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return (
    <Tile
      icon="bi-cpu"
      label={p.block.title || 'En cours'}
      value={stats.inProgress}
      alert={stats.blocked > 0}
      sub={
        stats.inProgress === 0
          ? 'Aucune tâche en cours'
          : [stats.working ? `${stats.working} agent${stats.working > 1 ? 's' : ''} au travail` : null, stats.waiting ? `${stats.waiting} en attente d’instructions` : null, stats.unattended ? `${stats.unattended} sans agent actif` : null, stats.blocked ? `${stats.blocked} bloquée${stats.blocked > 1 ? 's' : ''}` : null]
              .filter(Boolean)
              .join(' · ')
      }
    />
  );
}
export function PilotTileDoneWeek(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  const doneDelta = stats.doneWeek - stats.donePrevWeek;
  return (
    <Tile
      icon="bi-check2-circle"
      label={p.block.title || 'Terminées sur 7 jours'}
      value={stats.doneWeek}
      sub={
        <>
          <span className={doneDelta > 0 ? 'task-dash-good' : doneDelta < 0 ? 'task-dash-bad' : ''}>
            {doneDelta > 0 ? '+' : ''}
            {doneDelta}
          </span>{' '}
          par rapport aux 7 jours précédents ({stats.donePrevWeek})
        </>
      }
    />
  );
}
export function PilotTileOverdue(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return <Tile icon="bi-exclamation-triangle" label={p.block.title || 'En retard'} value={stats.overdue} alert={stats.overdue > 0} sub={stats.dueSoon ? `${stats.dueSoon} échéance${stats.dueSoon > 1 ? 's' : ''} dans les 7 jours` : 'Aucune échéance dans les 7 jours'} />;
}
export function PilotTileThroughput(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return <Tile icon="bi-speedometer2" label={p.block.title || 'Débit'} value={fmt1(stats.throughput.mean)} unit="/ sem." sub={`${stats.throughput.min} à ${stats.throughput.max} terminées par semaine sur ${stats.throughput.weeks} semaine${stats.throughput.weeks > 1 ? 's' : ''} révolue${stats.throughput.weeks > 1 ? 's' : ''}`} />;
}
export function PilotTileLeadTime(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return (
    <Tile
      icon="bi-stopwatch"
      label={p.block.title || 'Délai de traitement'}
      value={stats.leadTime.count ? formatDays(stats.leadTime.median) : '—'}
      sub={stats.leadTime.count ? `Médiane · 85 % des tâches en moins de ${formatDays(stats.leadTime.p85)} (${stats.leadTime.count} terminée${stats.leadTime.count > 1 ? 's' : ''} sur la période)` : 'Aucune tâche terminée sur la période'}
      title="Temps entre la création d’une tâche et sa fin, pour les tâches terminées sur la période"
    />
  );
}
export function PilotTileCycleTime(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return (
    <Tile
      icon="bi-arrow-repeat"
      label={p.block.title || 'Cycle time'}
      value={stats.cycleTime.count ? formatDays(stats.cycleTime.median) : '—'}
      alert={stats.agingOverP85 > 0}
      sub={stats.cycleTime.count ? `Médiane · 85 % en moins de ${formatDays(stats.cycleTime.p85)}${stats.agingOverP85 ? ` · ${stats.agingOverP85} en cours depuis plus longtemps` : ''}` : 'Aucune tâche terminée sur la période'}
      title="Temps entre le passage en cours d’une tâche et sa fin, pour les tâches terminées sur la période"
    />
  );
}
export function PilotTileForecast(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  return (
    <Tile
      icon="bi-calendar-check"
      label={p.block.title || 'Fin estimée du reste à faire'}
      date
      value={stats.open === 0 ? 'Rien à faire' : stats.forecastDates ? shortDate(stats.forecastDates.p50) : '—'}
      alert={stats.open > 0 && !stats.forecast}
      sub={stats.open === 0 ? 'Toutes les tâches sont terminées' : stats.forecastDates ? `Une chance sur deux · 85 % de chances avant le ${shortDate(stats.forecastDates.p85)} · à périmètre constant` : 'Pas de base de prévision : aucune tâche terminée sur la période'}
      title="Simulation de Monte-Carlo sur le débit hebdomadaire observé : dates auxquelles 50 % puis 85 % des scénarios ont écoulé les tâches ouvertes"
    />
  );
}
export function PilotTileNetFlow(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const { stats } = d;
  const net = stats.createdPeriod - stats.donePeriod - stats.cancelledPeriod;
  return (
    <Tile
      icon="bi-arrow-left-right"
      label={p.block.title || 'Flux net sur la période'}
      value={
        <span className={net > 0 ? 'task-dash-bad' : net < 0 ? 'task-dash-good' : ''}>
          {net > 0 ? '+' : ''}
          {net}
        </span>
      }
      sub={`${stats.createdPeriod} créée${stats.createdPeriod > 1 ? 's' : ''}, ${stats.donePeriod} terminée${stats.donePeriod > 1 ? 's' : ''}, ${stats.cancelledPeriod} annulée${stats.cancelledPeriod > 1 ? 's' : ''} : le reste à faire ${net > 0 ? 'grandit' : net < 0 ? 'diminue' : 'est stable'}`}
    />
  );
}

// ---- Cartes --------------------------------------------------------------------------------------------------------

function CardBlock({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="task-dash-card mb-3">
      <h3>{title}</h3>
      {hint && <div className="hint">{hint}</div>}
      {children}
    </div>
  );
}

export function PilotBurnup(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  return (
    <CardBlock title={p.block.title || 'Avancement cumulé'} hint="Périmètre (tâches créées, non annulées) et tâches terminées, jour par jour ; en pointillé, la projection au débit moyen.">
      <BurnupChart stats={d.stats} now={d.now} />
    </CardBlock>
  );
}
export function PilotThroughput(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  return (
    <CardBlock title={p.block.title || 'Flux par semaine'} hint="Tâches créées et terminées chaque semaine ; la semaine en cours est incomplète.">
      <ThroughputChart buckets={d.stats.buckets} />
    </CardBlock>
  );
}
export function PilotFlow(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  return (
    <CardBlock title={p.block.title || 'Flux cumulé'} hint="Tâches à faire, en cours et terminées à la fin de chaque jour (hors annulées) : une bande « en cours » qui s’élargit signale un encours qui s’accumule.">
      <FlowChart points={d.stats.flow} />
    </CardBlock>
  );
}
export function PilotAging(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const aging = agingWip(d.tasks, d.now);
  return (
    <CardBlock title={p.block.title || 'Vieillissement des tâches en cours'} hint="Temps depuis le passage en cours, comparé au cycle time des tâches terminées sur la période.">
      <AgingBars items={aging} median={d.stats.cycleTime.count ? d.stats.cycleTime.median : null} p85={d.stats.cycleTime.count ? d.stats.cycleTime.p85 : null} />
    </CardBlock>
  );
}
export function PilotByPriority(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  return (
    <CardBlock title={p.block.title || 'Ouvertes par priorité'}>
      <Bars rows={byPriority(d.tasks.filter(isOpen))} />
    </CardBlock>
  );
}
export function PilotByAssignee(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  return (
    <CardBlock title={p.block.title || 'Charge par responsable'}>
      <Bars rows={byAssignee(d.tasks.filter(isOpen))} empty="Aucune tâche ouverte." />
    </CardBlock>
  );
}

// ---- Listes --------------------------------------------------------------------------------------------------------

export function PilotWatchlist(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const watch = watchlist(d.tasks, d.now);
  const n = intParam(p.params, 'limit', 10);
  const projectOf = (x: Task) => (d.showProject ? `${x.project.name} · ` : '');
  return (
    <Section title={`${p.block.title || 'À surveiller'} (${watch.length})`}>
      <ul className="dash-list">
        {watch.slice(0, n).map(({ task: x, reason, detail }) => (
          <Item key={x.id} task={x} icon={WATCH_ICONS[reason].icon} iconClass={WATCH_ICONS[reason].cls} meta={`${projectOf(x)}${WATCH_LABELS[reason]} · ${detail}`} side={<TaskPriorityBadge priority={x.priority} short />} />
        ))}
        {watch.length > n && <li className="empty">… et {watch.length - n} autre{watch.length - n > 1 ? 's' : ''}.</li>}
        {watch.length === 0 && <li className="empty">Rien à signaler : pas de retard, de blocage ni de tâche en cours laissée sans suite.</li>}
      </ul>
    </Section>
  );
}

export function PilotInProgress(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const n = intParam(p.params, 'limit', 10);
  const inProgress = d.tasks.filter((x) => x.status === 'IN_PROGRESS').sort((a, b) => sessionRank(a) - sessionRank(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.updatedAt.localeCompare(b.updatedAt));
  const ageOf = new Map(agingWip(d.tasks, d.now).map((a) => [a.task.id, a.age]));
  const projectOf = (x: Task) => (d.showProject ? `${x.project.name} · ` : '');
  return (
    <Section title={`${p.block.title || 'En cours'} (${inProgress.length})`}>
      <ul className="dash-list">
        {inProgress.slice(0, n).map((x) => {
          const state = sessionState(x);
          return (
            <Item
              key={x.id}
              task={x}
              icon={state.icon}
              iconClass={state.cls}
              meta={
                <>
                  {projectOf(x)}
                  {x.statusTag && (
                    <>
                      <TaskStatusBadge status={x.status} statusTag={x.statusTag} />{' '}
                    </>
                  )}
                  {state.label}
                  {x.session && (
                    <>
                      {' '}
                      <Link to={`/sessions/${x.session.id}`}>{x.session.name}</Link>
                    </>
                  )}
                  {x.assignee && (
                    <>
                      {' · '}
                      <PersonChip person={x.assignee} />
                    </>
                  )}
                  {' · mise à jour '}
                  {timeAgo(x.updatedAt)}
                </>
              }
              side={
                <>
                  <span className="age" title={`En cours depuis le ${new Date(d.now.getTime() - (ageOf.get(x.id) ?? 0) * DAY).toLocaleDateString()} · créée le ${new Date(x.createdAt).toLocaleDateString()}`}>
                    depuis {formatDays(ageOf.get(x.id) ?? 0)}
                  </span>
                  <TaskPriorityBadge priority={x.priority} short />
                </>
              }
            />
          );
        })}
        {inProgress.length > n && <li className="empty">… et {inProgress.length - n} autre{inProgress.length - n > 1 ? 's' : ''}.</li>}
        {inProgress.length === 0 && <li className="empty">Aucune tâche en cours.</li>}
      </ul>
    </Section>
  );
}

export function PilotNext(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const next = nextTasks(d.tasks, intParam(p.params, 'limit', 8));
  const projectOf = (x: Task) => (d.showProject ? `${x.project.name} · ` : '');
  return (
    <Section title={p.block.title || 'Prochaines à lancer'} aside="par priorité puis échéance">
      <ul className="dash-list">
        {next.map((x) => (
          <Item
            key={x.id}
            task={x}
            icon="bi-play-circle"
            meta={
              <>
                {projectOf(x)}
                {x.dueDate && <>pour le {new Date(`${x.dueDate}T00:00:00`).toLocaleDateString()} · </>}
                créée {timeAgo(x.createdAt)}
                {x.assignee && (
                  <>
                    {' · '}
                    <PersonChip person={x.assignee} />
                  </>
                )}
                {x.tags.length > 0 && (
                  <>
                    {' '}
                    <TaskTags tags={x.tags} onSelect={d.onTag} />
                  </>
                )}
              </>
            }
            side={
              <>
                <TaskPriorityBadge priority={x.priority} short />
                <TaskActions task={x} target={d.targets.get(x.project.id)} onEdit={() => d.onEdit(x)} compact />
              </>
            }
          />
        ))}
        {next.length === 0 && <li className="empty">Rien à lancer : aucune tâche à faire.</li>}
      </ul>
    </Section>
  );
}

export function PilotDone(p: WidgetProps) {
  const d = t(p);
  if (!d) return null;
  const n = intParam(p.params, 'limit', 8);
  const recentDone = d.tasks
    .filter((x) => x.status === 'DONE' && x.completedAt)
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
    .slice(0, n);
  const projectOf = (x: Task) => (d.showProject ? `${x.project.name} · ` : '');
  return (
    <Section title={p.block.title || 'Terminées récemment'}>
      <ul className="dash-list">
        {recentDone.map((x) => (
          <Item
            key={x.id}
            task={x}
            icon="bi-check2"
            iconClass="good"
            meta={`${projectOf(x)}terminée ${timeAgo(x.completedAt!)} · délai ${formatDays((new Date(x.completedAt!).getTime() - new Date(x.createdAt).getTime()) / DAY)}${x.startedAt ? ` · cycle ${formatDays(Math.max(0, new Date(x.completedAt!).getTime() - new Date(x.startedAt).getTime()) / DAY)}` : ''}`}
            side={<TaskPriorityBadge priority={x.priority} short />}
          />
        ))}
        {recentDone.length === 0 && <li className="empty">Aucune tâche terminée.</li>}
      </ul>
    </Section>
  );
}
