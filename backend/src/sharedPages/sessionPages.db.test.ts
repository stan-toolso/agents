import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Pages publiées depuis une session (`sharedPageRepository.listForSessions`, champ GraphQL `Session.pages`) sur une base
 * PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : toute session qui a publié une version, et
 * seulement les pages que la personne voit (propriétaire, membre, lien ouvert) — les autres gardent /shared/<id>.
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

describe.skipIf(!adminUrl)('pages publiées par une session (PostgreSQL)', () => {
  const name = `skipper_test_session_pages_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./repository.js').sharedPageRepository;
  let comments: typeof import('./commentRepository.js').sharedPageCommentRepository;
  let project: string;
  let alice: string;
  let bob: string;

  const user = async (email: string) => (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $1) RETURNING id`, [email])).rows[0].id;
  const session = async () => (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider, owner_id, status) VALUES ($1, 'S', 'claude', $2, 'running') RETURNING id`, [project, alice])).rows[0].id;
  const publish = (title: string, sessionId: string, linkAccess = false) =>
    repo.create({ ownerId: alice, title, description: null, linkAccess, projectId: project, sessionId, sourcePath: 'page.html', html: Buffer.from('<p>x</p>') });
  const titles = async (sessionId: string, viewer: string) => ((await repo.listForSessions([sessionId], viewer)).get(sessionId) ?? []).map((p) => p.title).sort();

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    repo = (await import('./repository.js')).sharedPageRepository;
    comments = (await import('./commentRepository.js')).sharedPageCommentRepository;
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Pages', 'pages') RETURNING id`)).rows[0].id;
    alice = await user('alice@example.com');
    bob = await user('bob@example.com');
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it("garde une page à chaque session qui en a publié une version, et ne montre que ce que la personne voit", async () => {
    const s1 = await session();
    const s2 = await session();
    const privee = await publish('Privée', s1);
    await publish('Ouverte', s1, true);
    const partagee = await publish('Partagée', s1);
    await repo.addMember(partagee.id, bob, alice);
    // Republiée depuis s2 : la page reste aussi celle de s1.
    await repo.addVersion(privee.id, { title: 'Privée', description: null, linkAccess: null, projectId: project, sessionId: s2, sourcePath: 'page.html', html: Buffer.from('<p>y</p>'), createdBy: alice });

    expect(await titles(s1, alice)).toEqual(['Ouverte', 'Partagée', 'Privée']);
    expect(await titles(s2, alice)).toEqual(['Privée']);
    expect(await titles(s1, bob)).toEqual(['Ouverte', 'Partagée']);
    expect(await titles(s2, bob)).toEqual([]);
    expect((await repo.listForSessions([], alice)).size).toBe(0);
  });

  it('compte les commentaires non traités de plusieurs pages en une requête', async () => {
    const s = await session();
    const a = await publish('A', s);
    const b = await publish('B', s);
    await comments.create({ pageId: a.id, parentId: null, authorId: bob, sessionId: null, body: 'un', anchor: null, version: 1 });
    await comments.create({ pageId: a.id, parentId: null, authorId: bob, sessionId: null, body: 'deux', anchor: null, version: 1 });
    const counts = await comments.countOpenByPages([a.id, b.id]);
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBeUndefined();
  });
});
