import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Journal d'audit sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : écriture (acteur
 * d'une session complété par son propriétaire et son nom), filtres, curseur, et cibles lues par lookups.ts.
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

describe.skipIf(!adminUrl)('journal d’audit (PostgreSQL)', () => {
  const name = `skipper_test_audit_${process.pid}_${Date.now()}`;
  let m: {
    pool: pg.Pool;
    auditRepository: typeof import('./repository.js').auditRepository;
    lookupTarget: typeof import('./lookups.js').lookupTarget;
  };
  let project: string;
  let alice: string;
  let session: string;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    const [{ pool }, { auditRepository }, { lookupTarget }] = await Promise.all([import('../db/pool.js'), import('./repository.js'), import('./lookups.js')]);
    m = { pool, auditRepository, lookupTarget };
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Audit', 'audit') RETURNING id`)).rows[0].id;
    alice = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`)).rows[0].id;
    session = (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider, owner_id) VALUES ($1, 'Refonte', 'claude', $2) RETURNING id`, [project, alice])).rows[0].id;
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('écrit, complète l’acteur d’une session et filtre', async () => {
    await m.auditRepository.insert({ projectId: project, actor: { userId: alice, label: 'Alice' }, action: 'session.stop', targetType: 'session', targetId: session, targetLabel: 'Refonte' });
    await m.auditRepository.insert({ projectId: project, actor: { sessionId: session }, action: 'task.status', targetType: 'task', targetId: 't1', details: { from: 'todo', to: 'done' } });
    await m.auditRepository.insert({ projectId: project, actor: null, action: 'task.status', targetType: 'task', targetId: 't2' });
    await m.auditRepository.insert({ projectId: null, actor: { userId: alice }, action: 'user.invite', targetType: 'user' });

    const all = await m.auditRepository.list({ projectId: project });
    expect(all.map((e) => e.actorKind)).toEqual(['system', 'agent', 'human']);
    expect(all[1]).toMatchObject({ actorUserId: alice, sessionId: session, actorLabel: 'Refonte', details: { from: 'todo', to: 'done' } });

    expect((await m.auditRepository.list({ projectId: project, actorUserId: alice })).map((e) => e.action)).toEqual(['task.status', 'session.stop']);
    expect(await m.auditRepository.list({ projectId: project, actorKind: 'human' })).toHaveLength(1);
    expect(await m.auditRepository.list({ projectId: project, targetType: 'task', before: all[0].id })).toHaveLength(1);
    expect(await m.auditRepository.list({ projectId: project, from: new Date(Date.now() + 60_000) })).toHaveLength(0);

    const facets = await m.auditRepository.facets(project);
    expect(facets).toEqual({ actorUserIds: [alice], targetTypes: ['session', 'task'], actions: ['session.stop', 'task.status'] });
  });

  it('lit le projet et le libellé des cibles', async () => {
    expect(await m.lookupTarget('session', session)).toEqual({ projectId: project, label: 'Refonte' });
    expect(await m.lookupTarget('project', project)).toEqual({ projectId: project, label: 'Audit' });
    expect(await m.lookupTarget('user', alice)).toEqual({ projectId: null, label: 'Alice' });
    expect(await m.lookupTarget('task', '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await m.lookupTarget('task', 'pas-un-uuid')).toBeNull();
    // Chaque requête de lookups.ts est valide sur le schéma réel.
    const kinds = ['project', 'session', 'task', 'request', 'worksession', 'vault_item', 'vault_link', 'permission_rule', 'api_key', 'pull_request', 'notification_channel', 'agent', 'env_file', 'context_folder', 'context_instruction', 'workflow', 'workflow_run', 'conversation', 'shared_page', 'user'] as const;
    for (const kind of kinds) await expect(m.lookupTarget(kind, '00000000-0000-0000-0000-000000000000'), kind).resolves.toBeNull();
  });
});
