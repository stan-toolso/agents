import { useMemo } from 'react';
import { Badge } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import ChannelThread from '../../components/ChannelThread';
import type { Task } from '../../graphql/operations';
import { forecast, isOpen, leadTimes, percentile, weeklyBuckets } from '../../lib/taskStats';
import { Section, fold, intParam, tagsParam, withTags, type WidgetProps } from '../registry';

/** Blocs propres au tableau de bord d'un projet : canal général, flux des tâches par étiquette d'état, débit hebdomadaire. */

/** Ordre du vocabulaire des étiquettes d'état des agents (templates.ts) ; les autres étiquettes suivent, par ordre alphabétique. */
const STAGE_ORDER = ['à cadrer', 'prête', 'en dev', 'à valider', 'à livrer', 'livrée'];

/** Flux par étiquette d'état, débit, délai médian et prévision, à partir des tâches du projet. */
export function computeStats(tasks: Task[], weeksCount = 8) {
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
  const weeks = weeklyBuckets(tasks, now, weeksCount);
  const done7d = tasks.filter((t) => t.status === 'DONE' && t.completedAt && now.getTime() - new Date(t.completedAt).getTime() < 7 * 86_400_000).length;
  const leads = leadTimes(tasks, now, weeksCount).sort((a, b) => a - b);
  const leadP50 = leads.length ? Math.round(percentile(leads, 0.5) * 10) / 10 : null;
  const fc = forecast(open.length, weeks.slice(0, -1).map((w) => w.done));
  return { stages, maxStage: Math.max(0, ...stages.map((s) => s.count)), weeks, done7d, leadP50, forecastWeeks: fc ? fc.p50 : null };
}

export function ChannelWidget({ ctx, params }: WidgetProps) {
  if (!ctx.project?.d.general) return null;
  const { project, d, canWrite } = ctx.project;
  const general = d.general!;
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">
        <span className="dash-channel-name"><span className="hash">#</span>{general.slug}</span>
        <Link to={`/projects/${project.id}/conversations`}>Toutes les conversations{general.unreadCount > 0 && <Badge bg="primary" pill className="ms-1">{general.unreadCount}</Badge>}</Link>
      </h2>
      <p className="dash-section-hint">Parlez à l’équipe : <b>@Nom</b> prévient une personne, <b>@Agent</b> le fait répondre.</p>
      <div className="dash-embedded-channel">
        <div className="ch-embedded ch-scroll">
          <ChannelThread conversationId={general.id} canWrite={canWrite} compact limit={intParam(params, 'limit', 6)} placeholder="Écrire à l’équipe… (@ pour mentionner une personne ou un agent)" />
        </div>
      </div>
    </section>
  );
}

export function TasksStagesWidget({ block, ctx, params }: WidgetProps) {
  const tags = tagsParam(params);
  const tasks = ctx.project?.d.tasks ?? [];
  const stats = useMemo(() => computeStats(withTags(tasks, tags)), [tasks, tags]);
  if (!ctx.project) return null;
  const { project } = ctx.project;
  return (
    <Section title={block.title || 'Flux des tâches'} link={{ to: `/projects/${project.id}/tasks?view=dashboard`, label: 'Pilotage' }}>
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
          <div className="hint">{tags.length ? `Aucune tâche ouverte ${tags.join(', ')}.` : 'Aucune tâche ouverte.'}</div>
        )}
        <div className="dash-kpis">
          <div><b>{stats.done7d}</b>terminées / 7 j</div>
          <div><b>{stats.leadP50 != null ? `${stats.leadP50} j` : '—'}</b>délai médian</div>
          <div><b>{stats.forecastWeeks != null ? (stats.forecastWeeks === 0 ? 'rien' : `~${stats.forecastWeeks} sem.`) : '—'}</b>pour finir le reste</div>
        </div>
      </div>
    </Section>
  );
}

export function TasksWeeklyWidget({ block, ctx, params }: WidgetProps) {
  const weeksCount = intParam(params, 'weeks', 8);
  const tags = tagsParam(params);
  const tasks = ctx.project?.d.tasks ?? [];
  const weeks = useMemo(() => weeklyBuckets(withTags(tasks, tags), new Date(), weeksCount), [tasks, tags, weeksCount]);
  if (!ctx.project) return null;
  return (
    <Section title={block.title || 'Débit hebdomadaire'}>
      <p className="dash-section-hint">Tâches créées et terminées, sur {weeksCount} semaines{tags.length ? ` · ${tags.join(', ')}` : ''}.</p>
      <div className="task-dash-card">
        <WeeklyChart weeks={weeks} />
      </div>
    </Section>
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
