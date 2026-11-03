import { beforeEach, describe, expect, it, vi } from 'vitest';

// Budget mensuel d'un projet : paliers d'alerte (purs), blocage BUDGET_EXCEEDED et alerte émise une seule fois par palier.
const db = vi.hoisted(() => ({
  project: { name: 'Skipper', monthly_budget_usd: '100.00' as string | null, budget_alert_month: null as string | null, budget_alert_level: null as number | null },
  spent: '0',
  claims: 0,
}));
const query = vi.hoisted(() =>
  vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT COALESCE(SUM(cost_usd)')) return { rows: [{ total: db.spent }] };
    if (sql.includes('FROM projects WHERE id')) return { rows: [{ ...db.project }] };
    if (sql.startsWith('UPDATE projects')) {
      const [, month, level] = params as [string, string, number];
      const free = db.project.budget_alert_month !== month || (db.project.budget_alert_level ?? 0) < level;
      if (!free) return { rowCount: 0 };
      db.project.budget_alert_month = month;
      db.project.budget_alert_level = level;
      db.claims += 1;
      return { rowCount: 1 };
    }
    throw new Error(`requête inattendue : ${sql}`);
  }),
);
const notify = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../db/pool.js', () => ({ pool: { query } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify } }));
vi.mock('../billing/display.js', () => ({ describeCost: async (usd: number) => `${usd.toFixed(2)} $` }));

const { alertToSend, budgetLevel, monthKey, projectBudget } = await import('./budget.js');

beforeEach(() => {
  db.project = { name: 'Skipper', monthly_budget_usd: '100.00', budget_alert_month: null, budget_alert_level: null };
  db.spent = '0';
  db.claims = 0;
  notify.mockClear();
});

describe('paliers', () => {
  it('donne le plus haut palier atteint', () => {
    expect(budgetLevel(10, 100)).toBe(0);
    expect(budgetLevel(79.99, 100)).toBe(0);
    expect(budgetLevel(80, 100)).toBe(80);
    expect(budgetLevel(99, 100)).toBe(80);
    expect(budgetLevel(100, 100)).toBe(100);
    expect(budgetLevel(250, 100)).toBe(100);
    expect(budgetLevel(250, null)).toBe(0);
    expect(budgetLevel(250, 0)).toBe(0);
  });

  it("ne signale qu'un palier plus haut que celui déjà signalé ce mois-ci", () => {
    expect(alertToSend(80, { month: null, level: null }, '2026-11')).toBe(80);
    expect(alertToSend(80, { month: '2026-11', level: 80 }, '2026-11')).toBeNull();
    expect(alertToSend(100, { month: '2026-11', level: 80 }, '2026-11')).toBe(100);
    expect(alertToSend(80, { month: '2026-11', level: 100 }, '2026-11')).toBeNull();
    // Nouveau mois : on repart de zéro.
    expect(alertToSend(80, { month: '2026-10', level: 100 }, '2026-11')).toBe(80);
    expect(alertToSend(0, { month: null, level: null }, '2026-11')).toBeNull();
  });

  it('nomme le mois AAAA-MM', () => {
    expect(monthKey(new Date(2026, 0, 31))).toBe('2026-01');
    expect(monthKey(new Date(2026, 10, 3))).toBe('2026-11');
  });
});

describe('assertAvailable', () => {
  it('laisse passer sans budget ou sous le budget', async () => {
    db.project.monthly_budget_usd = null;
    db.spent = '500';
    await expect(projectBudget.assertAvailable('p1')).resolves.toBeUndefined();
    db.project.monthly_budget_usd = '100.00';
    db.spent = '99.99';
    await expect(projectBudget.assertAvailable('p1')).resolves.toBeUndefined();
  });

  it('bloque un projet au-delà de son budget (BUDGET_EXCEEDED)', async () => {
    db.spent = '100';
    await expect(projectBudget.assertAvailable('p1')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', message: expect.stringContaining('Skipper') });
  });
});

describe('checkAlert', () => {
  it('prévient à 80 % puis à 100 %, une fois par palier', async () => {
    db.spent = '50';
    await projectBudget.checkAlert('p1');
    expect(notify).not.toHaveBeenCalled();

    db.spent = '85';
    await projectBudget.checkAlert('p1');
    await projectBudget.checkAlert('p1');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'project.budget_warning', projectId: 'p1', link: '/projects/p1/usage' }));

    db.spent = '120';
    await projectBudget.checkAlert('p1');
    await projectBudget.checkAlert('p1');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'project.budget_exceeded' }));
  });

  it("n'expose pas de montant en USD dans la charge utile", async () => {
    db.spent = '85';
    await projectBudget.checkAlert('p1');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ payload: { level: 80 } }));
  });

  it("n'envoie rien si une autre instance a déjà réservé le palier", async () => {
    db.spent = '85';
    const month = monthKey();
    // Lecture : rien de signalé ; mais la réservation échoue (déjà faite ailleurs entre-temps).
    query.mockImplementationOnce(async () => ({ rows: [{ ...db.project }] }));
    db.project.budget_alert_month = month;
    db.project.budget_alert_level = 80;
    await projectBudget.checkAlert('p1');
    expect(notify).not.toHaveBeenCalled();
  });
});
