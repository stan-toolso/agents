import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectDashboard } from '../graphql/dashboard';
import type { Dashboard, Project, User } from '../graphql/operations';
import type { BlockParams, BuiltinBlock } from './types';
import { ChannelWidget, TasksStagesWidget, TasksWeeklyWidget } from './widgets/project';
import { ProjectsTableWidget, UsageCardWidget } from './widgets/home';
import { ListActivityWidget, ListAttentionTasksWidget, ListPullRequestsWidget, ListRunningSessionsWidget, ListTeamWidget, ListTodoWidget, ListUpcomingWidget, UsageTopSessionsWidget } from './widgets/lists';
import { TextWidget } from './widgets/text';
import { TileAgentsWidget, TilePullRequestsWidget, TileRequestsWidget, TileTasksWidget, TileUsageWidget } from './widgets/tiles';

/**
 * Registre des blocs natifs : la clé du catalogue (backend/src/cockpit/catalog.ts) → son composant. Le serveur décrit
 * chaque bloc (libellé, paramètres, régions) ; l'interface le rend. Une clé que cette version ne connaît pas affiche
 * un bloc « inconnu » (mise à jour bleu/vert, catalogue plus récent que le bundle).
 */

export type ProjectInfo = Pick<Project, 'id' | 'name' | 'description' | 'myRole' | 'isPersonal' | 'gitUrl'> & { git: { branch: string; commit: string } | null };

/** Ce que les blocs reçoivent : la portée, la personne, et les données de la page (accueil ou projet). */
export interface CockpitContext {
  kind: 'home' | 'project';
  viewer: User | null;
  /** Les coûts sont montrés (crédits, ou super administrateur). */
  showCostTile: boolean;
  home: Dashboard | null;
  project: { project: ProjectInfo; d: ProjectDashboard; canWrite: boolean } | null;
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
