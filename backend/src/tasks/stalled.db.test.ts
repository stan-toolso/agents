import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * « Agent arrêté » (`Task.stalledSince`, STALLED_SINCE_SQL) sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme
 * db/migrate.test.ts) : tâche en cours dont aucune session en charge ne tourne, sans pull request ouverte.
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

describe.skipIf(!adminUrl)('tâches « agent arrêté » (PostgreSQL)', () => {
  const name = `skipper_test_stalled_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./repository.js').taskRepository;
  let project: string;
  let alice: string;

  const session = async (status: string, endedAt: string | null = null) =>
    (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider, owner_id, status, ended_at) VALUES ($1, 'S', 'claude', $2, $3, $4) RETURNING id`, [project, alice, status, endedAt])).rows[0].id;
  const task = async (status: string, sessions: string[]) => {
    const id = (await pool.query<{ id: string }>(`INSERT INTO tasks (project_id, title, status, created_by_type) VALUES ($1, 'T', $2, 'human') RETURNING id`, [project, status])).rows[0].id;
    for (const s of sessions) await pool.query(`INSERT INTO task_sessions (task_id, session_id, in_charge_since) VALUES ($1, $2, now())`, [id, s]);
    return id;
  };
  const stalled = async (id: string) => (await repo.findById(id))?.stalledSince ?? null;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    repo = (await import('./repository.js')).taskRepository;
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Stalled', 'stalled') RETURNING id`)).rows[0].id;
    alice = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('signale une tâche en cours dont les sessions en charge sont toutes arrêtées, avec la fin la plus récente', async () => {
    const a = await session('stopped', '2026-11-01T10:00:00Z');
    const b = await session('failed', '2026-11-02T10:00:00Z');
    const t = await task('in_progress', [a, b]);
    expect((await stalled(t))?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    const listed = await repo.list({ projectId: project, stalled: true });
    expect(listed.map((x) => x.id)).toContain(t);
  });

  it('rien tant qu’une session en charge tourne, sans session, hors « en cours », ou avec une PR ouverte', async () => {
    const running = await task('in_progress', [await session('stopped', '2026-11-01T10:00:00Z'), await session('running')]);
    const none = await task('in_progress', []);
    const todo = await task('todo', [await session('completed', '2026-11-01T10:00:00Z')]);
    const withPr = await task('in_progress', [await session('completed', '2026-11-01T10:00:00Z')]);
    await pool.query(`INSERT INTO pull_requests (project_id, task_id, number, url, title, head_branch, status, created_by_type) VALUES ($1, $2, 1, 'https://example.com/pr/1', 'PR', 'b', 'open', 'human')`, [project, withPr]);
    for (const id of [running, none, todo, withPr]) expect(await stalled(id)).toBeNull();
    const listed = (await repo.list({ projectId: project, stalled: true })).map((x) => x.id);
    for (const id of [running, none, todo, withPr]) expect(listed).not.toContain(id);
    // La PR fusionnée, l'agent n'a plus de raison d'attendre : la tâche restée en cours redevient « agent arrêté ».
    await pool.query(`UPDATE pull_requests SET status = 'merged' WHERE task_id = $1`, [withPr]);
    expect(await stalled(withPr)).not.toBeNull();
  });
});
