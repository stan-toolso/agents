import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AgentActivityData } from '../graphql/agents';
import type { ProjectDashboard } from '../graphql/dashboard';
import type { Dashboard, Project, Task, User } from '../graphql/operations';
import type { DashboardStats } from '../lib/taskStats';
import type { LaunchTarget } from '../components/TaskLaunchModal';
import type { BlockParams, BuiltinBlock } from './types';
import { ChannelWidget, TasksStagesWidget, TasksWeeklyWidget } from './widgets/project';
import { ProjectsTableWidget, UsageCardWidget } from './widgets/home';
import { ListActivityWidget, ListAttentionTasksWidget, ListPullRequestsWidget, ListRunningSessionsWidget, ListTeamWidget, ListTodoWidget, ListUpcomingWidget, UsageTopSessionsWidget } from './widgets/lists';
import { TextWidget } from './widgets/text';
import { TileAgentsWidget, TilePullRequestsWidget, TileRequestsWidget, TileTasksWidget, TileUsageWidget } from './widgets/tiles';
import { AgentSessionsWidget, AgentTasksWidget, AgentTileActiveWidget, AgentTileCostWidget, AgentTileSessionsWidget, AgentTileTasksWidget } from './widgets/agent';
import { PilotAging, PilotBurnup, PilotByAssignee, PilotByPriority, PilotDone, PilotFlow, PilotInProgress, PilotNext, PilotThroughput, PilotTileCycleTime, PilotTileDoneWeek, PilotTileForecast, PilotTileInProgress, PilotTileLeadTime, PilotTileNetFlow, PilotTileOpen, PilotTileOverdue, PilotTileThroughput, PilotWatchlist } from './widgets/pilot';

/**
 * Registre des blocs natifs : la clé du catalogue (backend/src/cockpit/catalog.ts) → son composant. Le serveur décrit
 * chaque bloc (libellé, paramètres, régions) ; l'interface le rend. Une clé que cette version ne connaît pas affiche
 * un bloc « inconnu » (mise à jour bleu/vert, catalogue plus récent que le bundle).
 */

export type ProjectInfo = Pick<Project, 'id' | 'name' | 'description' | 'myRole' | 'isPersonal' | 'gitUrl'> & { git: { branch: string; commit: string } | null };

/** Ce que les blocs reçoivent : la portée, la personne, et les données de la page (accueil ou projet). */
/** Vue pilotage : les tâches du périmètre filtré et leurs statistiques (lib/taskStats.ts). */
export interface TasksContext {
  tasks: Task[];
  stats: DashboardStats;
  now: Date;
  weeks: number;
  showProject: boolean;
  onEdit: (t: Task) => void;
  onTag: (tag: string) => void;
  targets: Map<string, LaunchTarget>;
}

/** Fiche d'un agent : son profil (avec ses statistiques) et son activité. */
export interface AgentContext {
  agent: Agent;
  sessions: NonNullable<AgentActivityData['agent']>['sessions'];
  tasks: NonNullable<AgentActivityData['agent']>['tasks'];
  loading: boolean;
}

export interface CockpitContext {
  kind: 'home' | 'project' | 'tasks' | 'agent';
  viewer: User | null;
  /** Les coûts sont montrés (crédits, ou super administrateur). */
  showCostTile: boolean;
  home: Dashboard | null;
  project: { project: ProjectInfo; d: ProjectDashboard; canWrite: boolean } | null;
  tasks?: TasksContext | null;
  agent?: AgentContext | null;
  /** Requêtes à relire après une action dans un bloc (reprendre une session…). */
  refetch: string[];
}

export interface WidgetProps {
  block: BuiltinBlock;
  params: BlockParams;
  ctx: CockpitContext;
}

export interface WidgetEntry {
  component: ComponentType<WidgetProps>;
  /** Le bloc a quelque chose à montrer à cette personne ; sinon il est masqué (et signalé en mode édition). */
  available?: (ctx: CockpitContext) => boolean;
}

const project = (ctx: CockpitContext) => ctx.kind === 'project' && Boolean(ctx.project);
const cost = (ctx: CockpitContext) => ctx.showCostTile;
const pilot = (ctx: CockpitContext) => ctx.kind === 'tasks' && Boolean(ctx.tasks);
const agent = (ctx: CockpitContext) => ctx.kind === 'agent' && Boolean(ctx.agent);

export const WIDGETS: Record<string, WidgetEntry> = {
  'tile.requests': { component: TileRequestsWidget },
  'tile.agents': { component: TileAgentsWidget },
  'tile.tasks': { component: TileTasksWidget },
  'tile.usage': { component: TileUsageWidget, available: cost },
  'tile.pull_requests': { component: TilePullRequestsWidget, available: project },
  'list.todo': { component: ListTodoWidget },
  'list.running_sessions': { component: ListRunningSessionsWidget },
  'list.team': { component: ListTeamWidget, available: (ctx) => project(ctx) && !ctx.project?.project.isPersonal },
  'list.attention_tasks': { component: ListAttentionTasksWidget },
  'list.pull_requests': { component: ListPullRequestsWidget },
  'list.upcoming': { component: ListUpcomingWidget, available: project },
  'list.activity': { component: ListActivityWidget },
  'usage.top_sessions': { component: UsageTopSessionsWidget, available: cost },
  'tasks.stages': { component: TasksStagesWidget, available: project },
  'tasks.weekly': { component: TasksWeeklyWidget, available: project },
  'usage.card': { component: UsageCardWidget },
  'projects.table': { component: ProjectsTableWidget, available: (ctx) => ctx.kind === 'home' },
  channel: { component: ChannelWidget, available: (ctx) => project(ctx) && Boolean(ctx.project?.d.general) },
  text: { component: TextWidget },
  // Pilotage des tâches (portée project:<id>:tasks).
  'pilot.tile.open': { component: PilotTileOpen, available: pilot },
  'pilot.tile.in_progress': { component: PilotTileInProgress, available: pilot },
  'pilot.tile.done_week': { component: PilotTileDoneWeek, available: pilot },
  'pilot.tile.overdue': { component: PilotTileOverdue, available: pilot },
  'pilot.tile.throughput': { component: PilotTileThroughput, available: pilot },
  'pilot.tile.lead_time': { component: PilotTileLeadTime, available: pilot },
  'pilot.tile.cycle_time': { component: PilotTileCycleTime, available: pilot },
  'pilot.tile.forecast': { component: PilotTileForecast, available: pilot },
  'pilot.tile.net_flow': { component: PilotTileNetFlow, available: pilot },
  'pilot.burnup': { component: PilotBurnup, available: pilot },
  'pilot.throughput': { component: PilotThroughput, available: pilot },
  'pilot.flow': { component: PilotFlow, available: pilot },
  'pilot.aging': { component: PilotAging, available: pilot },
  'pilot.by_priority': { component: PilotByPriority, available: pilot },
  'pilot.by_assignee': { component: PilotByAssignee, available: pilot },
  'pilot.watchlist': { component: PilotWatchlist, available: pilot },
  'pilot.in_progress': { component: PilotInProgress, available: pilot },
  'pilot.next': { component: PilotNext, available: pilot },
  'pilot.done': { component: PilotDone, available: pilot },
  // Fiche d'un agent (portée agent:<id>).
  'agent.tile.active': { component: AgentTileActiveWidget, available: agent },
  'agent.tile.sessions': { component: AgentTileSessionsWidget, available: agent },
  'agent.tile.tasks': { component: AgentTileTasksWidget, available: agent },
  'agent.tile.cost': { component: AgentTileCostWidget, available: agent },
  'agent.sessions': { component: AgentSessionsWidget, available: agent },
  'agent.tasks': { component: AgentTasksWidget, available: agent },
};

// ---- Aides partagées par les blocs ----------------------------------------------------------------------------------

/** Section à la façon du tableau de bord : titre, lien à droite, contenu. */
export function Section({ title, link, aside, children }: { title: ReactNode; link?: { to: string; label: ReactNode } | null; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">
        <span>{title}</span>
        {link ? <Link to={link.to}>{link.label}</Link> : aside ? <span className="text-secondary" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 12 }}>{aside}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export const intParam = (params: BlockParams, key: string, def: number): number => {
  const v = Number(params[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
export const boolParam = (params: BlockParams, key: string, def = false): boolean => (typeof params[key] === 'boolean' ? (params[key] as boolean) : def);
export const tagsParam = (params: BlockParams): string[] => (Array.isArray(params.tags) ? (params.tags as unknown[]).map(String) : []);
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** Filtre par étiquettes (insensible à la casse et aux accents) ; sans étiquette, tout passe. */
export function withTags<T extends { tags: string[] }>(items: T[], tags: string[]): T[] {
  if (!tags.length) return items;
  const wanted = tags.map(fold);
  return items.filter((t) => t.tags.some((x) => wanted.includes(fold(x))));
}
