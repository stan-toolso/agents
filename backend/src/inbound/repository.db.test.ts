import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Point d'entrée entrant sur une base PostgreSQL jetable (TEST_DATABASE_URL) : portées et secret de signature des clés,
 * événements (idempotence par index partiel, reprise d'un échec, comptage du débit).
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

describe.skipIf(!adminUrl)('événements entrants (PostgreSQL)', () => {
  const name = `skipper_test_inbound_${process.pid}_${Date.now()}`;
  let m: {
    pool: pg.Pool;
    inboundRepository: typeof import('./repository.js').inboundRepository;
    apiKeyService: typeof import('../apiKeys/service.js').apiKeyService;
  };
  let project: string;
  let alice: string;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    process.env.SKIPPER_SECRET_KEY = 'a'.repeat(64);
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    const [{ pool }, { inboundRepository }, { apiKeyService }] = await Promise.all([import('../db/pool.js'), import('./repository.js'), import('../apiKeys/service.js')]);
    m = { pool, inboundRepository, apiKeyService };
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Inbound', 'inbound') RETURNING id`)).rows[0].id;
    alice = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('clé : portées, signature chiffrée, mise à jour', async () => {
    const { key, secret, signingSecret } = await m.apiKeyService.create(project, { name: 'Curso', scopes: ['inbound:triage', 'inbound:task'], signed: true }, alice);
    expect(key).toMatchObject({ scopes: ['inbound:task', 'inbound:triage'], signed: true, triageAgentId: null });
    expect(signingSecret).toMatch(/^whs_/);
    expect(await m.apiKeyService.signingSecret(key.id)).toBe(signingSecret);
    const stored = (await m.pool.query('SELECT signing_secret FROM project_api_keys WHERE id = $1', [key.id])).rows[0].signing_secret;
    expect(stored).not.toContain(signingSecret!);
    expect((await m.apiKeyService.authenticate(secret))?.scopes).toEqual(['inbound:task', 'inbound:triage']);
    const updated = await m.apiKeyService.update(key.id, { scopes: ['tasks:read'] });
    expect(updated.scopes).toEqual(['tasks:read']);
    const unsigned = await m.apiKeyService.setSigning(key.id, false);
    expect(unsigned.key.signed).toBe(false);
    expect(await m.apiKeyService.signingSecret(key.id)).toBeNull();
    // Clé créée à l'ancienne (sans portées) : l'API des tâches, comme avant.
    const legacy = await m.apiKeyService.create(project, 'Ancienne', alice);
    expect(legacy.key.scopes).toEqual(['tasks:read', 'tasks:write']);
  });

  it('événements : idempotence, reprise, débit, liste', async () => {
    const key = (await m.apiKeyService.create(project, { name: 'Débit', scopes: ['inbound:task'] }, alice)).key;
    const base = { projectId: project, apiKeyId: key.id, keyName: key.name, requestHash: 'h', source: 'curso', triage: false };
    const first = await m.inboundRepository.insert({ ...base, idempotencyKey: 'evt-1' });
    expect(first?.status).toBe('processing');
    expect(await m.inboundRepository.insert({ ...base, idempotencyKey: 'evt-1' })).toBeNull();
    expect(await m.inboundRepository.insert({ ...base, idempotencyKey: null })).not.toBeNull();
    expect(await m.inboundRepository.insert({ ...base, idempotencyKey: null, triage: true })).not.toBeNull();
    expect((await m.inboundRepository.findByIdempotencyKey(project, 'evt-1'))?.id).toBe(first!.id);

    const task = (await m.pool.query<{ id: string }>(`INSERT INTO tasks (project_id, title, created_by_type) VALUES ($1, 'T', 'human') RETURNING id`, [project])).rows[0].id;
    await m.inboundRepository.attachTask(first!.id, task);
    const failed = await m.inboundRepository.finish(first!.id, { status: 'failed', error: 'oups' });
    expect(failed).toMatchObject({ status: 'failed', taskId: task, error: 'oups' });
    expect((await m.inboundRepository.retry(first!.id))?.status).toBe('processing');
    expect(await m.inboundRepository.retry(first!.id)).toBeNull();
    const done = await m.inboundRepository.finish(first!.id, { status: 'done' });
    expect(done).toMatchObject({ status: 'done', taskId: task, error: null });

    expect(await m.inboundRepository.countRecent(key.id, 60)).toBe(3);
    expect(await m.inboundRepository.countRecent(key.id, 3600, true)).toBe(1);
    expect(await m.inboundRepository.listByProject(project)).toHaveLength(3);
  });
});
