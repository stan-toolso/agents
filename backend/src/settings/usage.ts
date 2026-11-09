import { pool } from '../db/pool.js';
import type { UsageSummary } from './types.js';

/** Début du mois calendaire courant (heure du serveur). */
export function currentMonthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Relevé de consommation : le SDK rapporte un coût cumulé par session (`total_cost_usd`) ; on
 * enregistre à chaque tour le delta par rapport au dernier total connu, avec sa ventilation par
 * modèle, attribué au propriétaire de la session (plafond mensuel par personne).
 *
 * `billable` (billing/billable.ts) : le tour compte-t-il dans la consommation ? Un tour non compté (propre compte Claude
 * d'une personne dans une cellule facturée en crédits) est inscrit pour mémoire mais ignoré de toutes les lectures
 * (`WHERE billable`), et n'augmente pas le coût affiché de la session (`sessions.billed_cost_usd`).
 */
/**
 * Écriture commune des relevés : ligne de la session verrouillée (`FOR UPDATE`) le temps de comparer le nouveau total au
 * dernier connu et d'inscrire l'écart, pour que deux relevés concurrents (fin de tour, rapprochement avec le journal du
 * CLI, deux instances en bleu/vert) ne comptent jamais deux fois le même travail.
 */
async function applyTotal(
  sessionId: string,
  projectId: string,
  userId: string | null,
  total: number,
  billable: boolean,
  opts: { realign: boolean },
  ventilate: (delta: number) => Record<string, number>,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ cost_usd: string }>('SELECT cost_usd FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return 0;
    }
    const known = Number(rows[0].cost_usd ?? 0);
    if (!(total > known)) {
      // Total inférieur (ex. /clear, processus repris d'un total plus ancien) : on réaligne sans compter de delta négatif.
      if (total < known && opts.realign) await client.query('UPDATE sessions SET cost_usd = $2 WHERE id = $1', [sessionId, total]);
      await client.query('COMMIT');
      return 0;
    }
    const delta = total - known;
    const models = ventilate(delta);
    await client.query('UPDATE sessions SET cost_usd = $2, billed_cost_usd = billed_cost_usd + $3 WHERE id = $1', [sessionId, total, billable ? delta.toFixed(6) : 0]);
    await client.query('INSERT INTO usage_ledger (session_id, project_id, user_id, models, cost_usd, billable) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [sessionId, projectId, userId, JSON.stringify(models), delta.toFixed(6), billable]);
    await client.query('COMMIT');
    return delta;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const usageService = {
  /** Dernier total connu pour la session (survit aux redémarrages). */
  async knownTotal(sessionId: string): Promise<number> {
    const { rows } = await pool.query<{ cost_usd: string }>('SELECT cost_usd FROM sessions WHERE id = $1', [sessionId]);
    return Number(rows[0]?.cost_usd ?? 0);
  },

  /**
   * Enregistre le nouveau total cumulé d'une session. `modelTotals` = coût cumulé par modèle
   * (`modelUsage` du SDK), utilisé pour ventiler le delta ; à défaut le delta est attribué à `fallbackModel`.
   * Renvoie le delta enregistré (0 si rien à enregistrer).
   */
  async recordTotal(sessionId: string, projectId: string, userId: string | null, total: number, modelTotals: Record<string, number>, previousModelTotals: Record<string, number>, fallbackModel: string, billable = true): Promise<number> {
    return applyTotal(sessionId, projectId, userId, total, billable, { realign: true }, (delta) => {
      const models: Record<string, number> = {};
      for (const [model, cost] of Object.entries(modelTotals)) {
        const d = cost - (previousModelTotals[model] ?? 0);
        if (d > 0) models[model] = Number(d.toFixed(6));
      }
      if (!Object.keys(models).length) models[fallbackModel] = Number(delta.toFixed(6));
      // Session reprise : les cumuls par modèle repartent du transcript alors que le delta, lui, est
      // relatif au dernier total connu. On ramène la ventilation à l'échelle du delta.
      const attributed = Object.values(models).reduce((a, b) => a + b, 0);
      if (attributed > delta * 1.01 && attributed > 0) {
        for (const k of Object.keys(models)) models[k] = Number(((models[k] * delta) / attributed).toFixed(6));
      }
      return models;
    });
  },

  /**
   * Total cumulé relu dans le journal du CLI (`cost-state`, sessions/providers/cliJournal.ts), hors d'un tour :
   * - plus haut que le dernier total relevé : travail fait après le dernier tour reçu (processus arrêté pendant que
   *   des sous-agents tournaient, CLI orphelin qui a fini seul) ; l'écart est enregistré, ventilé au prorata de
   *   `modelCosts` (coûts cumulés par modèle du journal) ;
   * - plus bas, avec `realign` : le CLI repartira de ce total (processus précédent tué sans l'écrire) ; le dernier total
   *   connu y est ramené avant le premier tour, pour que ce tour soit compté en entier.
   * Renvoie l'écart enregistré (0 si aucun).
   */
  async reconcileTotal(sessionId: string, projectId: string, userId: string | null, total: number, modelCosts: Record<string, number>, fallbackModel: string, billable: boolean, opts: { realign: boolean }): Promise<number> {
    return applyTotal(sessionId, projectId, userId, total, billable, opts, (delta) => {
      const sum = Object.values(modelCosts).reduce((a, b) => a + (b > 0 ? b : 0), 0);
      if (!(sum > 0)) return { [fallbackModel]: Number(delta.toFixed(6)) };
      const models: Record<string, number> = {};
      for (const [model, cost] of Object.entries(modelCosts)) if (cost > 0) models[model] = Number(((cost / sum) * delta).toFixed(6));
      return models;
    });
  },

  /** Dépense du mois des sessions d'une personne (son plafond mensuel s'y compare). */
  async monthTotal(userId: string, now = new Date()): Promise<number> {
    const { rows } = await pool.query<{ total: string }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE user_id = $1 AND billable AND recorded_at >= $2', [userId, currentMonthStart(now)]);
    return Number(rows[0].total);
  },

  /** Consommation des sessions d'une personne : ce mois, en tout, par modèle et par session. */
  async summary(userId: string, now = new Date()): Promise<UsageSummary> {
    const monthStart = currentMonthStart(now);
    const [month, total, byModel, bySession] = await Promise.all([
      this.monthTotal(userId, now),
      pool.query<{ total: string }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE user_id = $1 AND billable', [userId]),
      pool.query<{ model: string; usd: string }>(
        `SELECT m.key AS model, SUM((m.value)::numeric) AS usd
           FROM usage_ledger l, jsonb_each_text(l.models) AS m
          WHERE l.user_id = $1 AND l.billable AND l.recorded_at >= $2
          GROUP BY m.key ORDER BY usd DESC`,
        [userId, monthStart],
      ),
      pool.query<{ session_id: string | null; session_name: string | null; project_name: string | null; usd: string }>(
        `SELECT l.session_id, s.name AS session_name, p.name AS project_name, SUM(l.cost_usd) AS usd
           FROM usage_ledger l
           LEFT JOIN sessions s ON s.id = l.session_id
           LEFT JOIN projects p ON p.id = COALESCE(l.project_id, s.project_id)
          WHERE l.user_id = $1 AND l.billable AND l.recorded_at >= $2
          GROUP BY l.session_id, s.name, p.name ORDER BY usd DESC LIMIT 10`,
        [userId, monthStart],
      ),
    ]);
    return {
      monthStart,
      monthUsd: month,
      totalUsd: Number(total.rows[0].total),
      byModel: byModel.rows.map((r) => ({ model: r.model, usd: Number(r.usd) })),
      bySession: bySession.rows.map((r) => ({ sessionId: r.session_id, sessionName: r.session_name, projectName: r.project_name, usd: Number(r.usd) })),
    };
  },
};
