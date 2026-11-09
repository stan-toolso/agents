/**
 * Tâches de fond du CLI Claude Code qui gardent une session « au travail » après la fin d'un tour.
 *
 * Un agent peut lancer des sous-agents en arrière-plan (outil Agent, `run_in_background`), puis clore son tour sur
 * « j'attends les sous-agents » : le CLI le relance de lui-même quand chacun rend son compte rendu (notification de
 * tâche). Si Skipper tenait la session pour inactive à ce moment-là, il pourrait la garer pendant un drainage bleu/vert,
 * terminer l'exécution planifiée, l'archiver ou l'arrêter pour inactivité : les appels MCP des sous-agents seraient
 * annulés (le CLI les présente comme un refus de la personne), et leurs comptes rendus, comme leur coût, perdus.
 * Constaté le 09/11/2026 sur la session toolso 06fd9ea2 (tâche 4df8e69d).
 *
 * Le SDK publie la liste complète des tâches de fond vivantes à chaque changement (`system/background_tasks_changed`,
 * sémantique « remplacer »). Comptent les sous-agents et les workflows, qui rendent un compte rendu à l'agent ; pas les
 * tâches `ambient` (surveillances, tâches techniques) ni les commandes Bash de fond, qui peuvent tourner sans fin
 * (serveur de développement) et bloqueraient la session pour rien.
 */

export interface BackgroundTaskLike {
  task_id: string;
  task_type: string;
  description: string;
  ambient?: boolean;
}

/** Types de tâches qui rendent un compte rendu à l'agent : sous-agents (locaux ou distants) et workflows. */
const REPORTING_TASK = /agent|workflow|teammate/i;

/** Tâches de fond qui gardent la session au travail. */
export function reportingBackgroundTasks<T extends BackgroundTaskLike>(tasks: readonly T[] | null | undefined): T[] {
  return (tasks ?? []).filter((t) => !t.ambient && REPORTING_TASK.test(t.task_type ?? ''));
}

/** Délai laissé au CLI, une fois la dernière tâche finie, pour ouvrir le tour qui en traite le compte rendu. */
export const BACKGROUND_SETTLE_MS = 15_000;

/** Durée maximale pendant laquelle des tâches de fond gardent la session au travail après la fin d'un tour. */
export const BACKGROUND_HOLD_MAX_MS = 2 * 60 * 60 * 1000;

/** Libellé court des tâches en cours : « 2 sous-agents en arrière-plan (« elixis », « ancienne stack ») ». */
export function describeBackgroundTasks(tasks: readonly BackgroundTaskLike[]): string {
  const n = tasks.length;
  const names = tasks
    .map((t) => t.description?.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((d) => `« ${d!.length > 60 ? `${d!.slice(0, 59)}…` : d} »`);
  const more = n > names.length && names.length ? ', …' : '';
  return `${n} sous-agent${n > 1 ? 's' : ''} en arrière-plan${names.length ? ` (${names.join(', ')}${more})` : ''}`;
}

/**
 * Attente des sous-agents après la fin d'un tour, pour une exécution du CLI. Le provider signale les tâches de fond
 * (`setTasks`), l'ouverture d'un tour de l'agent principal (`turnStarted`) et sa fin (`turnEnded`, qui dit si la
 * session reste au travail) ; `release` est appelé quand l'attente prend fin d'elle-même : dernier sous-agent fini sans
 * que le CLI ouvre de tour dans le délai `settleMs`, ou attente plus longue que `maxMs` (avec une notice).
 */
export class BackgroundHold {
  private tasks: BackgroundTaskLike[] = [];
  private holding = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly release: (notice: string | null) => Promise<void>,
    private readonly opts: { settleMs?: number; maxMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  /** Sous-agents encore au travail (comptés par `reportingBackgroundTasks`). */
  get live(): readonly BackgroundTaskLike[] {
    return this.tasks;
  }

  /** La session est tenue au travail après la fin de son dernier tour. */
  get isHolding(): boolean {
    return this.holding;
  }

  /** Liste complète des tâches de fond vivantes (`system/background_tasks_changed`). */
  setTasks(tasks: readonly BackgroundTaskLike[] | null | undefined): void {
    this.tasks = reportingBackgroundTasks(tasks);
    if (this.tasks.length) {
      this.clear('settle');
      return;
    }
    if (this.holding && !this.settleTimer) this.settleTimer = setTimeout(() => this.fire(null), this.opts.settleMs ?? BACKGROUND_SETTLE_MS);
  }

  /** Tour de l'agent principal ouvert (instruction, ou tour lancé par le CLI sur un compte rendu) : fin de l'attente. */
  turnStarted(): void {
    this.holding = false;
    this.clear();
  }

  /** Fin d'un tour. `hold` : des sous-agents travaillent encore, la session reste au travail ; `first` : début de l'attente. */
  turnEnded(): { hold: boolean; first: boolean } {
    if (!this.tasks.length) {
      this.holding = false;
      this.clear();
      return { hold: false, first: false };
    }
    const first = !this.holding;
    this.holding = true;
    const maxMs = this.opts.maxMs ?? BACKGROUND_HOLD_MAX_MS;
    if (!this.maxTimer) this.maxTimer = setTimeout(() => this.fire(`Sous-agents toujours en arrière-plan après ${Math.round(maxMs / 60_000)} min : la session n'est plus tenue pour au travail.`), maxMs);
    return { hold: true, first };
  }

  /** Fin de l'exécution du CLI. */
  dispose(): void {
    this.holding = false;
    this.clear();
  }

  private fire(notice: string | null): void {
    if (!this.holding) return;
    this.holding = false;
    this.clear();
    this.release(notice).catch((err) => this.opts.onError?.(err));
  }

  private clear(which: 'settle' | 'all' = 'all'): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (which === 'settle') return;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }
}
