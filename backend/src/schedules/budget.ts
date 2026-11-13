/**
 * Budget d'une planification (pur, testé) : plafond de coût d'une exécution (`maxRunUsd`) et budget mensuel
 * (`monthlyBudgetUsd`), en plus du budget du projet et du plafond du propriétaire. Montants en USD.
 * - au lancement : budget mensuel atteint → échéance ignorée (notification `schedule.budget_exceeded`) ;
 * - pendant l'exécution : plafond effectif = le plus petit du plafond par exécution et de ce qui reste du mois ;
 *   transmis au CLI Claude (`maxBudgetUsd`, arrêt en cours de tour) et vérifié par le suivi entre deux pas
 *   (tout provider) : atteint, la session est arrêtée.
 */

export interface ScheduleBudget {
  maxRunUsd: number | null;
  monthlyBudgetUsd: number | null;
}

/** Montant saisi → valeur enregistrée : undefined inchangé ; null, 0 ou négatif retiré ; sinon un nombre fini. */
export function normalizeBudgetAmount(v: number | null | undefined, label: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === 0) return null;
  if (!Number.isFinite(v) || v < 0) throw new Error(`${label} : montant invalide`);
  return v;
}

/** Raison de refuser le lancement (budget mensuel atteint), ou null. */
export function launchRefusal(budget: ScheduleBudget, monthSpent: number, describe: (usd: number) => string): string | null {
  const monthly = budget.monthlyBudgetUsd;
  if (!monthly || monthly <= 0) return null;
  if (monthSpent >= monthly) return `budget mensuel de la planification atteint (${describe(monthSpent)} consommés sur ${describe(monthly)})`;
  return null;
}

/** Plafond effectif d'une exécution (USD), ou null s'il n'y en a pas. */
export function runCap(budget: ScheduleBudget, monthSpent: number): number | null {
  const caps: number[] = [];
  if (budget.maxRunUsd && budget.maxRunUsd > 0) caps.push(budget.maxRunUsd);
  if (budget.monthlyBudgetUsd && budget.monthlyBudgetUsd > 0) caps.push(Math.max(budget.monthlyBudgetUsd - monthSpent, 0));
  return caps.length ? Math.min(...caps) : null;
}

/** Plafond à passer au provider : le plus petit de celui déjà réglé (`maxBudgetUsd` de la config) et du plafond effectif. */
export function providerCap(configured: unknown, cap: number | null): number | undefined {
  const own = Number(configured);
  const values = [Number.isFinite(own) && own > 0 ? own : null, cap !== null && cap > 0 ? cap : null].filter((v): v is number => v !== null);
  return values.length ? Math.min(...values) : undefined;
}

/** Le coût de l'exécution atteint-il le plafond ? (marge d'un millième pour les arrondis) */
export function capReached(spent: number, cap: number | null): boolean {
  return cap !== null && spent >= cap - 0.001;
}
