import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Notification } from './types.js';

/**
 * Canaux de notification sur une base PostgreSQL jetable (TEST_DATABASE_URL) : quels canaux relaient quelle
 * notification (projet, personne, membres, réservées aux administrateurs, familles).
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

const base: Notification = { id: 'n1', type: 'request.created', title: 't', message: null, link: '/sessions/s1', projectId: null, sessionId: null, payload: {}, adminsOnly: false, userId: null, readAt: null, createdAt: new Date() };

describe.skipIf(!adminUrl)('canaux de notification (PostgreSQL)', () => {
  const name = `skipper_test_channels_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let svc: typeof import('./channels.js');
  let project: string;
  let other: string;
  let alice: string;
  let bob: string;
  let root: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.SKIPPER_SECRET_KEY = 'cd'.repeat(32);
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    svc = await import('./channels.js');
    const one = async (sql: string, params: unknown[] = []) => (await pool.query<{ id: string }>(sql, params)).rows[0].id;
    project = await one(`INSERT INTO projects (name, slug) VALUES ('Alpha', 'alpha') RETURNING id`);
    other = await one(`INSERT INTO projects (name, slug) VALUES ('Beta', 'beta') RETURNING id`);
    alice = await one(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`);
    bob = await one(`INSERT INTO users (email, name) VALUES ('bob@example.com', 'Bob') RETURNING id`);
    root = await one(`INSERT INTO users (email, name, is_admin) VALUES ('root@example.com', 'Root', true) RETURNING id`);
    await pool.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member'), ($3, $4, 'member')`, [project, alice, other, bob]);
    const slack = (n: string) => `https://hooks.slack.com/services/T0/B0/${n}`;
    ids.projectChan = (await svc.notificationChannelService.create({ projectId: project, userId: null, admin: false }, { kind: 'slack', target: slack('p1') }, alice)).id;
    ids.alice = (await svc.notificationChannelService.create({ projectId: null, userId: alice, admin: false }, { kind: 'email', target: 'alice@example.com', categories: ['requests', 'mentions'] }, alice)).id;
    ids.bob = (await svc.notificationChannelService.create({ projectId: null, userId: bob, admin: false }, { kind: 'discord', target: 'https://discord.com/api/webhooks/1/x' }, bob)).id;
    ids.root = (await svc.notificationChannelService.create({ projectId: null, userId: root, admin: true }, { kind: 'slack', target: slack('r'), categories: ['server', 'requests'] }, root)).id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  const match = (n: Partial<Notification>, category: string) => svc.notificationChannelRepository.matching({ ...base, ...n }, category).then((r) => r.sort());

  it('une notification de projet va au canal du projet et aux membres qui ont choisi la famille', async () => {
    expect(await match({ projectId: project }, 'requests')).toEqual([ids.projectChan, ids.alice].sort());
    // Alice n'a pas choisi « tâches » ; Bob n'est pas membre.
    expect(await match({ projectId: project, type: 'task.completed' }, 'tasks')).toEqual([ids.projectChan]);
    expect(await match({ projectId: other, type: 'task.completed' }, 'tasks')).toEqual([ids.bob]);
  });

  it('une notification adressée à une personne ne va qu’à ses canaux, jamais au canal du projet', async () => {
    expect(await match({ projectId: project, userId: alice, type: 'task.mentioned' }, 'mentions')).toEqual([ids.alice]);
  });

  it('les notifications réservées vont aux seuls administrateurs', async () => {
    expect(await match({ adminsOnly: true, type: 'claude.rate_limit' }, 'server')).toEqual([ids.root]);
    expect(svc.allowedCategories({ projectId: project, admin: true })).not.toContain('server');
    await expect(svc.notificationChannelService.create({ projectId: null, userId: alice, admin: false }, { kind: 'email', target: 'a@b.fr', categories: ['server'] }, alice)).rejects.toThrow();
  });

  it('un canal en pause ne reçoit rien ; la cible n’est jamais renvoyée', async () => {
    const paused = await svc.notificationChannelService.update(ids.projectChan, false, { enabled: false });
    expect(paused).toMatchObject({ enabled: false, targetHint: 'hooks.slack.com/…0/p1' });
    expect(JSON.stringify(paused)).not.toContain('hooks.slack.com/services');
    expect(await match({ projectId: project }, 'requests')).toEqual([ids.alice]);
  });
});
