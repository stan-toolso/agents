import { pool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { describeCost } from '../billing/display.js';
import { notificationService } from '../notifications/service.js';
import { currentMonthStart } from '../settings/usage.js';
import { log } from '../log.js';

/**
 * Budget mensuel d'un projet (`projects.monthly_budget_usd`), en plus du plafond mensuel de chaque personne
 * (`ClaudeSettings.monthlyBudgetUsd`) : la consommation du mois de toutes les sessions du projet (`usage_ledger`)
 * s'y compare. Atteint, le projet ne lance plus de session ni de tour (`BUDGET_EXCEEDED`, comme le plafond par
 * personne). Les membres sont prévenus par notification à 80 % puis à 100 %, une fois par palier et par mois.
 */

/** Paliers d'alerte, en pourcentage du budget. */
export const BUDGET_ALERT_LEVELS = [80, 100] as const;

/** Mois de référence « AAAA-MM » (heure du serveur, comme `currentMonthStart`). */
export const monthKey = (now = new Date()): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

/** Plus haut palier atteint par la consommation (0 : aucun). */
export function budgetLevel(spentUsd: number, budgetUsd: number | null): number {
  if (!budgetUsd || budgetUsd <= 0) return 0;
  const pct = (spentUsd / budgetUsd) * 100;
  return [...BUDGET_ALERT_LEVELS].reverse().find((l) => pct >= l) ?? 0;
}

/**
 * Palier à signaler maintenant, ou null : seulement un palier plus haut que celui déjà signalé ce mois-ci (un
 * nouveau mois repart de zéro ; un budget relevé en cours de mois ne fait pas réémettre un palier déjà signalé).
 */
export function alertToSend(level: number, alerted: { month: string | null; level: number | null }, month: string): number | null {
  if (!level) return null;
  const already = alerted.month === month ? alerted.level ?? 0 : 0;
  return level > already ? level : null;
}

export const projectBudget = {
  /** Consommation du mois d'un projet, en USD. */
  async monthSpent(projectId: string, now = new Date()): Promise<number> {
    const { rows } = await pool.query<{ total: string }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE project_id = $1 AND recorded_at >= $2', [projectId, currentMonthStart(now)]);
    return Number(rows[0].total);
  },

  /** Consommation du mois de plusieurs projets (clé : identifiant ; absent = 0). */
  async monthSpentOf(projectIds: string[], now = new Date()): Promise<Map<string, number>> {
    if (!projectIds.length) return new Map();
    const { rows } = await pool.query<{ project_id: string; total: string }>(
      'SELECT project_id, SUM(cost_usd) AS total FROM usage_ledger WHERE project_id = ANY($1::uuid[]) AND recorded_at >= $2 GROUP BY project_id',
      [projectIds, currentMonthStart(now)],
    );
    return new Map(rows.map((r) => [r.project_id, Number(r.total)]));
  },

  /** Lève BUDGET_EXCEEDED si le budget mensuel du projet est atteint. */
  async assertAvailable(projectId: string): Promise<void> {
    const { rows } = await pool.query<{ name: string; monthly_budget_usd: string | null }>('SELECT name, monthly_budget_usd FROM projects WHERE id = $1', [projectId]);
    const budget = rows[0]?.monthly_budget_usd == null ? null : Number(rows[0].monthly_budget_usd);
    if (!budget) return;
    const spent = await this.monthSpent(projectId);
    if (spent >= budget) {
      throw new AppError(`Budget mensuel du projet « ${rows[0].name} » atteint (${await describeCost(spent)} sur ${await describeCost(budget)}) : un administrateur du projet peut le relever dans son onglet Consommation`, 'BUDGET_EXCEEDED');
    }
  },

  /**
   * Après un relevé de consommation : prévient les membres du projet quand un palier est franchi. Le palier est
   * réservé en base avant l'envoi (UPDATE conditionnel), pour qu'un seul tour l'émette même entre instances.
   * Ne lève jamais.
   */
  async checkAlert(projectId: string, now = new Date()): Promise<void> {
    try {
      const { rows } = await pool.query<{ name: string; monthly_budget_usd: string | null; budget_alert_month: string | null; budget_alert_level: number | null }>(
        'SELECT name, monthly_budget_usd, budget_alert_month, budget_alert_level FROM projects WHERE id = $1',
        [projectId],
      );
      const p = rows[0];
      const budget = p?.monthly_budget_usd == null ? null : Number(p.monthly_budget_usd);
      if (!p || !budget) return;
      const spent = await this.monthSpent(projectId, now);
      const month = monthKey(now);
      const level = alertToSend(budgetLevel(spent, budget), { month: p.budget_alert_month, level: p.budget_alert_level }, month);
      if (level === null) return;
      const claimed = await pool.query(
        `UPDATE projects SET budget_alert_month = $2, budget_alert_level = $3
          WHERE id = $1 AND (budget_alert_month IS DISTINCT FROM $2 OR COALESCE(budget_alert_level, 0) < $3)`,
        [projectId, month, level],
      );
      if (!claimed.rowCount) return;
      const amounts = `${await describeCost(spent)} sur ${await describeCost(budget)}`;
      await notificationService.notify(
        level >= 100
          ? { type: 'project.budget_exceeded', title: `Budget mensuel atteint : ${p.name}`, message: `${amounts}. Le projet ne lance plus de session ni de tour jusqu'au mois prochain, sauf si un administrateur relève le budget.`, link: `/projects/${projectId}/usage`, projectId, payload: { level } }
          : { type: 'project.budget_warning', title: `${level} % du budget mensuel : ${p.name}`, message: `${amounts} consommés ce mois-ci.`, link: `/projects/${projectId}/usage`, projectId, payload: { level } },
      );
    } catch (err) {
      log.error('[budget] alerte de budget impossible', err);
    }
  },
};
