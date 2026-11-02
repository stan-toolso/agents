import { pool } from '../db/pool.js';

/**
 * Coût attribué à une tâche.
 *
 * Règle : chaque ligne de `usage_ledger` (un tour facturé d'une session, à une date) est répartie **à parts
 * égales** entre les tâches auxquelles la session était reliée à cette date (`task_sessions.linked_at <= date` :
 * l'historique garde les sessions passées par une tâche, la fin de la prise en charge n'est pas datée). Un tour
 * antérieur à toute liaison n'est attribué à aucune tâche. La somme des parts d'un tour est donc toujours égale
 * à son coût : le total des tâches ne dépasse jamais celui des sessions. Même source que le tableau de bord
 * (`usage_ledger`), donc mêmes totaux.
 */
export interface LedgerEntry {
  sessionId: string;
  recordedAt: Date;
  costUsd: number;
}
export interface TaskLink {
  taskId: string;
  sessionId: string;
  linkedAt: Date;
}
export interface TaskCost {
  totalUsd: number;
  /** Part de chaque session (clé : identifiant de session). */
  bySession: Map<string, number>;
}

/** Coût par tâche (clé : identifiant de tâche) ; les tâches sans coût attribué n'y figurent pas. */
export function attributeCosts(entries: LedgerEntry[], links: TaskLink[]): Map<string, TaskCost> {
  const linksBySession = new Map<string, TaskLink[]>();
  for (const l of links) linksBySession.set(l.sessionId, [...(linksBySession.get(l.sessionId) ?? []), l]);
  const out = new Map<string, TaskCost>();
  for (const e of entries) {
    const targets = (linksBySession.get(e.sessionId) ?? []).filter((l) => l.linkedAt.getTime() <= e.recordedAt.getTime());
    if (!targets.length) continue;
    const share = e.costUsd / targets.length;
    for (const l of targets) {
      const c = out.get(l.taskId) ?? { totalUsd: 0, bySession: new Map() };
      c.totalUsd += share;
      c.bySession.set(e.sessionId, (c.bySession.get(e.sessionId) ?? 0) + share);
      out.set(l.taskId, c);
    }
  }
  return out;
}

/** Coût des tâches demandées. Charge les tours des sessions concernées, les liaisons de ces sessions et répartit. */
export async function taskCosts(taskIds: string[]): Promise<Map<string, TaskCost>> {
  if (!taskIds.length) return new Map();
  const { rows: sessions } = await pool.query<{ session_id: string }>('SELECT DISTINCT session_id FROM task_sessions WHERE task_id = ANY($1::uuid[])', [taskIds]);
  const sessionIds = sessions.map((r) => r.session_id);
  if (!sessionIds.length) return new Map();
  // Les liaisons de toutes ces sessions (y compris à d'autres tâches) : elles partagent le coût de chaque tour.
  const [{ rows: ledger }, { rows: links }] = await Promise.all([
    pool.query<{ session_id: string; recorded_at: Date; cost_usd: string }>('SELECT session_id, recorded_at, cost_usd FROM usage_ledger WHERE session_id = ANY($1::uuid[])', [sessionIds]),
    pool.query<{ task_id: string; session_id: string; linked_at: Date }>('SELECT task_id, session_id, linked_at FROM task_sessions WHERE session_id = ANY($1::uuid[])', [sessionIds]),
  ]);
  const all = attributeCosts(
    ledger.map((r) => ({ sessionId: r.session_id, recordedAt: r.recorded_at, costUsd: Number(r.cost_usd) })),
    links.map((r) => ({ taskId: r.task_id, sessionId: r.session_id, linkedAt: r.linked_at })),
  );
  return new Map(taskIds.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
}
