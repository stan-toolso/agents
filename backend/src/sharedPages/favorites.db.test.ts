import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Artefacts d'un projet (`listForProject`, onglet Artefacts) et favoris (`setFavorite`, `listFavorites`, section
 * « Favoris » de la sidebar) sur une base PostgreSQL jetable (TEST_DATABASE_URL) : seulement ce que la personne voit
 * (propriétaire, membre, lien ouvert sauf pour un invité), et un favori disparaît de la liste quand l'accès est perdu.
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

describe.skipIf(!adminUrl)('artefacts du projet et favoris (PostgreSQL)', () => {
  const name = `skipper_test_page_favorites_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./repository.js').sharedPageRepository;
  let project: string;
  let other: string;
  let alice: string;
  let bob: string;

  const user = async (email: string) => (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $1) RETURNING id`, [email])).rows[0].id;
  const publish = (title: string, projectId: string, linkAccess = false) =>
    repo.create({ ownerId: alice, title, description: null, linkAccess, projectId, sessionId: null, sourcePath: null, html: Buffer.from('<p>x</p>') });
  const titles = (pages: { title: string }[]) => pages.map((p) => p.title).sort();

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
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('A', 'a') RETURNING id`)).rows[0].id;
    other = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('B', 'b') RETURNING id`)).rows[0].id;
    alice = await user('alice@example.com');
    bob = await user('bob@example.com');
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('liste les artefacts du projet que la personne voit, et ses favoris tant qu’elle les voit', async () => {
    const priv = await publish('Privée', project);
    const open = await publish('Lien ouvert', project, true);
    const shared = await publish('Partagée', project);
    await publish('Autre projet', other, true);
    await repo.addMember(shared.id, bob, alice);

    expect(titles(await repo.listForProject(project, alice, true))).toEqual(['Lien ouvert', 'Partagée', 'Privée']);
    expect(titles(await repo.listForProject(project, bob, true))).toEqual(['Lien ouvert', 'Partagée']);
    expect(titles(await repo.listForProject(project, bob, false))).toEqual(['Partagée']);

    await repo.setFavorite(bob, open.id, true);
    await repo.setFavorite(bob, shared.id, true);
    await repo.setFavorite(bob, shared.id, true); // sans effet
    await repo.setFavorite(bob, priv.id, true); // posé directement en base : la liste le filtre quand même
    expect((await repo.listFavorites(bob, true)).map((p) => p.title)).toEqual(['Lien ouvert', 'Partagée']);
    expect([...(await repo.favoriteIds(bob, [open.id, priv.id, shared.id]))].sort()).toEqual([open.id, priv.id, shared.id].sort());

    await repo.removeMember(shared.id, bob);
    await repo.setFavorite(bob, open.id, false);
    expect(await repo.listFavorites(bob, true)).toEqual([]);
  });
});
