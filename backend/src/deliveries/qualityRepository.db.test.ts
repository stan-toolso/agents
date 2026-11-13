import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Tâches qualité rattachées aux livraisons, requêtes du dépôt sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme
 * db/migrate.test.ts) : livraisons de référence (déploiements, sinon fusions), rattachements automatiques et manuels,
 * auteurs des PR emportées.
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

describe.skipIf(!adminUrl)('tâches qualité des livraisons (PostgreSQL)', () => {
  const name = `skipper_test_quality_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./qualityRepository.js').deliveryQualityRepository;
  let project: string;
  let other: string;
  let stan: string;
  let ben: string;

  const id = async (sql: string, args: unknown[]) => (await pool.query<{ id: string }>(sql, args)).rows[0].id;
  const delivery = (projectId: string, kind: string, status: string, finishedAt: string, prNumber: number | null = null) =>
    id(`INSERT INTO deliveries (project_id, kind, status, created_at, finished_at, pr_number) VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`, [projectId, kind, status, finishedAt, prNumber]);
  const task = (tags: string[], createdAt: string, projectId = project) =>
    id(`INSERT INTO tasks (project_id, title, status, created_by_type, tags, created_at) VALUES ($1, 'T', 'todo', 'human', $2, $3) RETURNING id`, [projectId, tags, createdAt]);
  const pr = (number: number, by: { userId?: string; sessionId?: string }) =>
    id(
      `INSERT INTO pull_requests (project_id, number, url, title, head_branch, status, created_by_type, created_by_user_id, created_by_session_id)
       VALUES ($1, $2, 'u', 'PR', 'b', 'merged', $3, $4, $5) RETURNING id`,
      [project, number, by.sessionId ? 'agent' : 'human', by.userId ?? null, by.sessionId ?? null],
    );

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    repo = (await import('./qualityRepository.js')).deliveryQualityRepository;
    project = await id(`INSERT INTO projects (name, slug) VALUES ('Qualité', 'qualite') RETURNING id`, []);
    other = await id(`INSERT INTO projects (name, slug) VALUES ('Autre', 'autre') RETURNING id`, []);
    stan = await id(`INSERT INTO users (email, name) VALUES ('stan@example.com', 'Stan') RETURNING id`, []);
    ben = await id(`INSERT INTO users (email, name, kind) VALUES ('ben@agents.local', 'Ben', 'agent') RETURNING id`, []);
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('livraisons de référence : les fusions tant que le projet n’a jamais déployé, puis ses déploiements seulement', async () => {
    const merge = await delivery(project, 'merge', 'succeeded', '2026-11-01T10:00:00Z', 12);
    await delivery(project, 'merge', 'failed', '2026-11-01T11:00:00Z');
    await delivery(other, 'deploy', 'succeeded', '2026-11-01T12:00:00Z');
    expect((await repo.references(project)).map((r) => r.id)).toEqual([merge]);
    const deploy = await delivery(project, 'deploy', 'succeeded', '2026-11-02T10:00:00Z');
    await delivery(project, 'deploy', 'failed', '2026-11-02T11:00:00Z');
    expect((await repo.references(project)).map((r) => r.id)).toEqual([deploy]);
    expect(await repo.references(project, { from: new Date('2026-11-03T00:00:00Z') })).toEqual([]);
    expect((await repo.projectsWithDeliveries()).sort()).toEqual([project, other].sort());
  });

  it('rattachements : l’automatique ne remplace jamais le manuel ; comptes par livraison', async () => {
    const [d] = await repo.references(project);
    const t1 = await task(['bug'], '2026-11-02T12:00:00Z');
    const t2 = await task(['Qualité'], '2026-11-02T13:00:00Z');
    await task([], '2026-11-02T14:00:00Z');
    expect((await repo.taggedTasksSince(project, d.at)).map((t) => t.id).sort()).toEqual([t1, t2].sort());
    await repo.setAuto(t1, d.id);
    await repo.setAuto(t2, d.id);
    expect((await repo.qualityCounts([d.id])).get(d.id)).toBe(2);
    await repo.setManual(t2, null, stan);
    await repo.setAuto(t2, d.id);
    expect(await repo.linkOf(t2)).toMatchObject({ deliveryId: null, source: 'manual', linkedById: stan });
    await repo.removeAuto([t1, t2]);
    expect(await repo.linkOf(t1)).toBeNull();
    expect(await repo.linkOf(t2)).not.toBeNull();
    expect((await repo.linksOfProject(project)).get(t2)).toEqual({ deliveryId: null, source: 'manual' });
    await repo.setAuto(t1, d.id);
    expect((await repo.linksOfDeliveries([d.id])).get(d.id)?.map((l) => l.taskId)).toEqual([t1]);
    expect((await repo.linksOfTasks([t1, t2])).size).toBe(2);
  });

  it('auteurs : propriétaire de la session (agent) ou personne, PR liées au déploiement ou PR de la fusion', async () => {
    const session = await id(`INSERT INTO sessions (project_id, name, provider, owner_id, status) VALUES ($1, 'S', 'claude', $2, 'stopped') RETURNING id`, [project, ben]);
    const byAgent = await pr(12, { sessionId: session });
    const byHuman = await pr(13, { userId: stan });
    const deploy = await delivery(project, 'deploy', 'succeeded', '2026-11-04T10:00:00Z');
    await pool.query(`INSERT INTO delivery_pull_requests (delivery_id, pull_request_id) VALUES ($1, $2), ($1, $3)`, [deploy, byAgent, byHuman]);
    const merge = (await pool.query<{ id: string }>(`SELECT id FROM deliveries WHERE project_id = $1 AND kind = 'merge' AND pr_number = 12`, [project])).rows[0].id;
    const rows = await repo.authors([deploy, merge]);
    const key = (r: { deliveryId: string; pullRequestId: string; authorId: string | null }) => `${r.deliveryId === deploy ? 'deploy' : 'merge'}:${r.pullRequestId === byAgent ? 'agent' : 'human'}:${r.authorId === ben ? 'ben' : r.authorId === stan ? 'stan' : r.authorId}`;
    expect(rows.map(key).sort()).toEqual(['deploy:agent:ben', 'deploy:human:stan', 'merge:agent:ben']);
  });

  it('réglages du projet', async () => {
    expect(await repo.settings(project)).toBeNull();
    await repo.setSettings(project, { tags: ['incident'], windowHours: 72 }, stan);
    expect(await repo.settings(project)).toMatchObject({ tags: ['incident'], windowHours: 72, updatedById: stan });
    await repo.setSettings(project, null, stan);
    expect(await repo.settings(project)).toBeNull();
  });
});
