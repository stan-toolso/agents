import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Portée du coffre d'une session sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) :
 * dans son espace personnel, une personne a d'office tout son coffre personnel (hors jetons réservés à Skipper),
 * sans lien à créer ; ailleurs, et pour quelqu'un d'autre, rien ne change.
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

describe.skipIf(!adminUrl)('portée du coffre (PostgreSQL)', () => {
  const name = `skipper_test_vault_scope_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let service: typeof import('./service.js').vaultService;
  let camille: string;
  let dominique: string;
  let personal: string;
  let team: string;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    service = (await import('./service.js')).vaultService;
    const id = async (sql: string, params: unknown[] = []) => (await pool.query<{ id: string }>(sql, params)).rows[0].id;
    camille = await id(`INSERT INTO users (email, name) VALUES ('camille@example.com', 'Camille') RETURNING id`);
    dominique = await id(`INSERT INTO users (email, name) VALUES ('dominique@example.com', 'Dominique') RETURNING id`);
    personal = await id(`INSERT INTO projects (name, slug, personal_owner_id) VALUES ('Espace personnel', 'perso-camille', $1) RETURNING id`, [camille]);
    team = await id(`INSERT INTO projects (name, slug) VALUES ('Équipe', 'equipe') RETURNING id`);
    for (const [p, user] of [[personal, camille], [team, camille], [team, dominique]]) {
      await pool.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')`, [p, user]);
    }
    const item = (owner: string, itemName: string, kind: string) => id(`INSERT INTO vault_items (id, owner_user_id, name, kind) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [owner, itemName, kind]);
    const gmail = await item(camille, 'gmail', 'google');
    await item(camille, 'prod', 'ssh');
    await item(camille, 'abonnement', 'token');
    await item(dominique, 'autre', 'ssh');
    // Un élément déjà relié à l'espace n'y apparaît qu'une fois, par son lien.
    await pool.query(`INSERT INTO vault_item_links (item_id, project_id, scope, user_id, linked_by) VALUES ($1, $2, 'personal', $3, $3)`, [gmail, personal, camille]);
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('donne au propriétaire de l’espace personnel tout son coffre, sans les jetons de Skipper', async () => {
    const rows = await service.agentRows(personal, camille);
    expect(rows.map((r) => [r.item.name, r.via, Boolean(r.link)])).toEqual([
      ['gmail', 'personal', true],
      ['prod', 'personal', false],
    ]);
  });

  it('ne donne rien d’office hors de son espace personnel, ni à quelqu’un d’autre', async () => {
    expect(await service.agentRows(team, camille)).toEqual([]);
    expect(await service.agentRows(personal, dominique)).toEqual([]);
    expect(await service.agentRows(personal, null)).toEqual([]);
  });
});
