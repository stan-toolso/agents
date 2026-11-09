import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Relevé de consommation sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : totaux du CLI
 * en fin de tour, rapprochement avec le journal du CLI (cost-state) au lancement et après la fin d'une exécution, et
 * jamais de double comptage quand ces relevés se croisent (tâche 4df8e69d).
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe.skipIf(!adminUrl)('relevé de consommation (PostgreSQL)', () => {
  const name = `skipper_test_usage_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let usage: typeof import('./usage.js').usageService;
  let projectId: string;
  let sessionId: string;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    ({ pool } = await import('../db/pool.js'));
    ({ usageService: usage } = await import('./usage.js'));
    projectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Démo', 'demo') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  beforeEach(async () => {
    sessionId = (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider) VALUES ($1, 'S', 'claude') RETURNING id`, [projectId])).rows[0].id;
  });

  const ledger = async () => (await pool.query<{ cost_usd: string; models: Record<string, number> }>('SELECT cost_usd, models FROM usage_ledger WHERE session_id = $1 ORDER BY recorded_at', [sessionId])).rows.map((r) => Number(r.cost_usd));
  const billed = async () => Number((await pool.query<{ billed_cost_usd: string }>('SELECT billed_cost_usd FROM sessions WHERE id = $1', [sessionId])).rows[0].billed_cost_usd);
  const opus = (total: number) => ({ 'claude-opus-5-5': total });
  const result = (total: number, previous = 0) => usage.recordTotal(sessionId, projectId, null, total, opus(total), opus(previous), 'opus', true);
  const reconcile = (total: number, realign: boolean) => usage.reconcileTotal(sessionId, projectId, null, total, opus(total), 'opus', true, { realign });

  // Session toolso 06fd9ea2 : 3,744 $ relevés au dernier tour, le CLI orphelin a fini à 4,349 $.
  it('enregistre le travail fait après le dernier tour, une seule fois', async () => {
    await result(3.744);
    expect(await reconcile(4.349, false)).toBeCloseTo(0.605, 6);
    expect(await reconcile(4.349, true)).toBe(0); // la reprise suivante relit le même cost-state
    await result(5.491, 4.349); // le processus repris repart de 4,349
    expect(await ledger()).toEqual([3.744, 0.605, 1.142]);
    expect(await billed()).toBeCloseTo(5.491, 6);
  });

  // Processus tué sans écrire son cost-state : le suivant repart d'un total plus ancien. Avant, le premier tour était perdu.
  it('compte le premier tour d’un processus repris d’un total plus ancien', async () => {
    await result(18.58);
    expect(await reconcile(8.31, true)).toBe(0); // réalignement au lancement
    await result(9.71, 8.31);
    expect(await ledger()).toEqual([18.58, 1.4]);
  });

  it('conversation neuve : le relevé repart de 0', async () => {
    await result(2);
    await reconcile(0, true);
    await result(0.5);
    expect(await ledger()).toEqual([2, 0.5]);
  });

  it('ne compte jamais deux fois un même total relevé en parallèle', async () => {
    await result(1);
    const deltas = await Promise.all([reconcile(3, false), reconcile(3, false), result(3, 1), reconcile(3, true)]);
    expect(deltas.filter((d) => d > 0)).toHaveLength(1);
    expect((await ledger()).sort()).toEqual([1, 2]);
    expect(await billed()).toBeCloseTo(3, 6);
  });
});
