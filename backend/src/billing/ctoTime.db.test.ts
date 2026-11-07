import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Suivi du temps CTO sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : une tranche de
 * 10 minutes par personne, seulement pour un CTO, consolidée en fin de journée en saisies « auto » comptées au relevé.
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

describe.skipIf(!adminUrl)('temps CTO suivi (PostgreSQL)', () => {
  const name = `skipper_test_cto_time_${process.pid}_${Date.now()}`;
  let m: {
    pool: pg.Pool;
    cto: typeof import('./ctoTime.js').ctoTimeService;
    billing: typeof import('./service.js').billingService;
  };
  let projectId: string;
  let sessionId: string;
  const cto = { id: '', kind: 'person', isCto: true };
  const other = { id: '', kind: 'person', isCto: false };

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    const [{ pool }, { ctoTimeService }, { billingService }] = await Promise.all([import('../db/pool.js'), import('./ctoTime.js'), import('./service.js')]);
    m = { pool, cto: ctoTimeService, billing: billingService };
    projectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Client', 'client') RETURNING id`)).rows[0].id;
    cto.id = (await pool.query<{ id: string }>(`INSERT INTO users (email, name, is_cto) VALUES ('cto@toolso.io', 'Céline', true) RETURNING id`)).rows[0].id;
    other.id = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('dev@client.fr', 'Dev') RETURNING id`)).rows[0].id;
    sessionId = (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider) VALUES ($1, 'Session', 'claude') RETURNING id`, [projectId])).rows[0].id;
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it("inscrit une tranche par personne et par 10 minutes, pour un CTO seulement, puis la consolide le lendemain", async () => {
    const day = new Date(2026, 10, 5, 9, 1);
    const at = (minutes: number) => new Date(day.getTime() + minutes * 60_000);
    const send = { action: 'sendSessionMessage', targetType: 'session' as const, targetId: sessionId };
    expect(await m.cto.record(cto, send, at(0))).toBe(true);
    expect(await m.cto.record(cto, send, at(5))).toBe(false); // même tranche (9 h 00 – 9 h 10)
    expect(await m.cto.record(cto, { action: 'postMessage', targetType: 'conversation', targetId: null }, at(12))).toBe(true);
    expect(await m.cto.record(cto, send, at(31))).toBe(true);
    expect(await m.cto.record(other, send, at(0))).toBe(false);

    const slots = await m.pool.query<{ project_id: string | null }>('SELECT project_id FROM cto_activity_slots ORDER BY slot_start');
    expect(slots.rows.map((r) => r.project_id)).toEqual([projectId, null, projectId]);

    // Le jour même : provisoire au relevé, rien de consolidé.
    expect(await m.cto.consolidate(at(120))).toBe(0);
    const live = await m.billing.statement('2026-11', false, at(120));
    expect(live.cto.entries.map((e) => [e.source, e.hours, e.slots])).toEqual(expect.arrayContaining([['pending', 0.33, 2], ['pending', 0.17, 1]]));
    expect(live.cto.hours).toBe(0.5);

    // Le lendemain : deux saisies « auto » (avec et sans projet), comptées une seule fois.
    const tomorrow = new Date(2026, 10, 6, 0, 30);
    expect(await m.cto.consolidate(tomorrow)).toBe(2);
    expect(await m.cto.consolidate(tomorrow)).toBe(0);
    const next = await m.billing.statement('2026-11', false, tomorrow);
    expect(next.cto.entries.every((e) => e.source === 'auto' && e.day === '2026-11-05' && e.userName === 'Céline')).toBe(true);
    expect(next.cto.hours).toBe(0.5);
    await expect(m.billing.deleteCtoTime('pending:2026-11-05:x:none')).rejects.toThrow('consolidé');
  });
});
