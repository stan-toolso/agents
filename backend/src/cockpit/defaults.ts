import type { Block, Layout, Region, Scope } from './types.js';

/**
 * Agencements par défaut : ceux du cockpit tel qu'il était avant d'être composable. Tant que personne n'enregistre
 * rien, chaque page est identique à avant ; « Réinitialiser » y revient. Les identifiants sont stables (`d-<clé>`)
 * pour que l'historique et les opérations d'un agent puissent les désigner.
 */

const b = (widget: string, region: Region, params?: Record<string, unknown>): Block => ({ id: `d-${widget.replace(/[._]/g, '-')}`, kind: 'builtin', widget, region, ...(params ? { params } : {}) });

const HOME: Layout = {
  v: 1,
  blocks: [
    b('tile.requests', 'tiles'),
    b('tile.agents', 'tiles'),
    b('tile.tasks', 'tiles'),
    b('tile.usage', 'tiles'),
    b('list.todo', 'main'),
    b('list.running_sessions', 'main'),
    b('list.attention_tasks', 'main'),
    b('list.pull_requests', 'main'),
    b('usage.card', 'side'),
    b('list.activity', 'side'),
    b('projects.table', 'full'),
  ],
};

const PROJECT: Layout = {
  v: 1,
  blocks: [
    b('tile.requests', 'tiles'),
    b('tile.agents', 'tiles'),
    b('tile.tasks', 'tiles'),
    b('tile.usage', 'tiles'),
    b('tile.pull_requests', 'tiles'),
    b('channel', 'main'),
    b('list.todo', 'main'),
    b('list.team', 'main'),
    b('list.attention_tasks', 'main'),
    b('tasks.stages', 'side'),
    b('tasks.weekly', 'side'),
    b('list.upcoming', 'side'),
    b('list.activity', 'side'),
    b('usage.top_sessions', 'side'),
  ],
};

/** Espace personnel : sans canal ni équipe. */
const PERSONAL: Layout = {
  v: 1,
  blocks: [
    b('tile.requests', 'tiles'),
    b('tile.agents', 'tiles'),
    b('tile.tasks', 'tiles'),
    b('tile.usage', 'tiles'),
    b('list.todo', 'main'),
    b('list.attention_tasks', 'main'),
    b('tasks.stages', 'side'),
    b('list.upcoming', 'side'),
    b('list.activity', 'side'),
    b('usage.top_sessions', 'side'),
  ],
};

/** Vue pilotage des tâches : tuiles d'indicateurs, graphiques deux par deux (colonnes 6/6), puis listes. */
const TASKS: Layout = {
  v: 1,
  blocks: [
    b('pilot.tile.open', 'tiles'),
    b('pilot.tile.in_progress', 'tiles'),
    b('pilot.tile.done_week', 'tiles'),
    b('pilot.tile.overdue', 'tiles'),
    b('pilot.tile.throughput', 'tiles'),
    b('pilot.tile.lead_time', 'tiles'),
    b('pilot.tile.cycle_time', 'tiles'),
    b('pilot.tile.forecast', 'tiles'),
    b('pilot.tile.net_flow', 'tiles'),
    b('pilot.burnup', 'main'),
    b('pilot.flow', 'main'),
    b('pilot.by_priority', 'main'),
    b('pilot.watchlist', 'main'),
    b('pilot.next', 'main'),
    b('pilot.throughput', 'side'),
    b('pilot.aging', 'side'),
    b('pilot.by_assignee', 'side'),
    b('pilot.in_progress', 'side'),
    b('pilot.done', 'side'),
  ],
};

/** Fiche d'un agent, onglet Activité : quatre tuiles, ses sessions, ses tâches. */
const AGENT: Layout = {
  v: 1,
  blocks: [
    b('agent.tile.active', 'tiles'),
    b('agent.tile.sessions', 'tiles'),
    b('agent.tile.tasks', 'tiles'),
    b('agent.tile.cost', 'tiles'),
    b('agent.sessions', 'main'),
    b('agent.tasks', 'side'),
  ],
};

export interface DefaultOptions {
  /** Projet = espace personnel d'une personne. */
  personal?: boolean;
}

const clone = (l: Layout): Layout => JSON.parse(JSON.stringify(l)) as Layout;

export function defaultLayout(scope: Pick<Scope, 'kind'>, opts: DefaultOptions = {}): Layout {
  switch (scope.kind) {
    case 'home':
      return clone(HOME);
    case 'project':
      return clone(opts.personal ? PERSONAL : PROJECT);
    case 'tasks':
      return clone(TASKS);
    case 'agent':
      return clone(AGENT);
    default:
      return { v: 1, blocks: [] };
  }
}
