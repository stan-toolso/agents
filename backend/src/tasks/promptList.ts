import type { Task } from './types.js';

/**
 * Nombre maximal de tâches ouvertes listées dans le prompt système d'une session : ce texte est relu à chaque tour,
 * la liste complète d'un gros tableau (des dizaines de tâches) pèserait sur chaque appel au modèle. Le reste se
 * consulte avec `tasks.list`.
 */
export const PROMPT_TASKS_LIMIT = 15;

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Tâches ouvertes à montrer dans le prompt, les plus utiles d'abord : celles dont la session est en charge, puis les
 * tâches en cours, puis par priorité (ordre d'origine à égalité). Renvoie aussi celles qui restent hors de la liste.
 */
export function promptTasks<T extends Pick<Task, 'status' | 'priority' | 'sessionIds'>>(open: T[], sessionId?: string, limit = PROMPT_TASKS_LIMIT): { shown: T[]; hidden: T[] } {
  const rank = (t: T) => [sessionId && t.sessionIds.includes(sessionId) ? 0 : 1, t.status === 'in_progress' ? 0 : 1, PRIORITY_RANK[t.priority] ?? 4];
  const sorted = open
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.i - b.i)
    .map((x) => x.t);
  return { shown: sorted.slice(0, limit), hidden: sorted.slice(limit) };
}
