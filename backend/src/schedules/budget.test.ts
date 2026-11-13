import { describe, expect, it } from 'vitest';
import { capReached, launchRefusal, normalizeBudgetAmount, providerCap, runCap } from './budget.js';

const usd = (v: number) => `${v.toFixed(2)} $`;

describe('budget des planifications', () => {
  it('normalise les montants saisis', () => {
    expect(normalizeBudgetAmount(undefined, 'x')).toBeUndefined();
    expect(normalizeBudgetAmount(null, 'x')).toBeNull();
    expect(normalizeBudgetAmount(0, 'x')).toBeNull();
    expect(normalizeBudgetAmount(2.5, 'x')).toBe(2.5);
    expect(() => normalizeBudgetAmount(-1, 'Budget')).toThrow(/Budget/);
    expect(() => normalizeBudgetAmount(Number.NaN, 'x')).toThrow();
  });

  it('refuse le lancement quand le budget mensuel est atteint', () => {
    expect(launchRefusal({ maxRunUsd: 1, monthlyBudgetUsd: null }, 100, usd)).toBeNull();
    expect(launchRefusal({ maxRunUsd: null, monthlyBudgetUsd: 10 }, 9.99, usd)).toBeNull();
    expect(launchRefusal({ maxRunUsd: null, monthlyBudgetUsd: 10 }, 10, usd)).toMatch(/budget mensuel de la planification atteint \(10.00 \$ consommés sur 10.00 \$\)/);
  });

  it("plafond effectif d'une exécution : le plus petit du plafond par exécution et du reste du mois", () => {
    expect(runCap({ maxRunUsd: null, monthlyBudgetUsd: null }, 0)).toBeNull();
    expect(runCap({ maxRunUsd: 2, monthlyBudgetUsd: null }, 50)).toBe(2);
    expect(runCap({ maxRunUsd: null, monthlyBudgetUsd: 10 }, 7)).toBe(3);
    expect(runCap({ maxRunUsd: 2, monthlyBudgetUsd: 10 }, 9)).toBe(1);
    expect(runCap({ maxRunUsd: 2, monthlyBudgetUsd: 10 }, 1)).toBe(2);
  });

  it('plafond transmis au provider : le plus petit avec celui de la configuration', () => {
    expect(providerCap(undefined, null)).toBeUndefined();
    expect(providerCap(undefined, 2)).toBe(2);
    expect(providerCap(5, 2)).toBe(2);
    expect(providerCap('1.5', 2)).toBe(1.5);
    expect(providerCap(3, null)).toBe(3);
  });

  it('plafond atteint', () => {
    expect(capReached(1.9, 2)).toBe(false);
    expect(capReached(1.9995, 2)).toBe(true);
    expect(capReached(3, 2)).toBe(true);
    expect(capReached(100, null)).toBe(false);
  });
});
