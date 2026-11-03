import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Liens publics de session sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) :
 * un lien valable montre le transcript filtré et masqué, un lien expiré ou révoqué renvoie 404, et la route
 * n'accepte que GET.
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

/** Appelle la route avec une requête et une réponse minimales ; renvoie le statut et le corps JSON. */
async function call(handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>, path: string, method = 'GET'): Promise<{ handled: boolean; status: number; body: unknown }> {
  let status = 0;
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(s: number) {
      status = s;
      this.headersSent = true;
      return this;
    },
    end(data?: Buffer | string) {
      if (data) raw += data.toString();
      return this;
    },
  };
  const handled = await handler({ url: path, method, headers: {} } as IncomingMessage, res as unknown as ServerResponse);
  return { handled, status, body: raw ? JSON.parse(raw) : null };
}

describe.skipIf(!adminUrl)('liens publics de session (PostgreSQL)', () => {
  const name = `skipper_test_shares_${process.pid}_${Date.now()}`;
  let m: {
    pool: pg.Pool;
    service: typeof import('./service.js').sessionShareService;
    route: typeof import('./route.js').handleSessionShareRoute;
  };
  let sessionId: string;
  let userId: string;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    const [{ pool }, { sessionShareService }, { handleSessionShareRoute }] = await Promise.all([import('../db/pool.js'), import('./service.js'), import('./route.js')]);
    m = { pool, service: sessionShareService, route: handleSessionShareRoute };
    const projectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Démo', 'demo') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('camille@example.com', 'Camille') RETURNING id`)).rows[0].id;
    sessionId = (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider, owner_id) VALUES ($1, 'Ma session', 'claude', $2) RETURNING id`, [projectId, userId])).rows[0].id;
    const insert = (type: string, payload: unknown) => pool.query('INSERT INTO session_events (session_id, type, payload) VALUES ($1, $2, $3)', [sessionId, type, JSON.stringify(payload)]);
    await insert('instruction', { text: 'Déploie avec GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' });
    await insert('claude.assistant', { message: { content: [{ type: 'thinking', thinking: 'réflexion privée' }, { type: 'text', text: 'Fait.' }] } });
    await insert('claude.result', { subtype: 'success', duration_ms: 10, total_cost_usd: 3.21 });
    await insert('stderr', { text: 'trace interne' });
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('montre le transcript filtré, secrets masqués, à un lien valable', async () => {
    const share = await m.service.create(sessionId, userId, 7);
    const { handled, status, body } = await call(m.route, `/api/share/${share.token}`);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const view = body as { session: { name: string; ownerName: string }; events: Array<{ type: string }> };
    expect(view.session).toMatchObject({ name: 'Ma session', ownerName: 'Camille' });
    expect(view.events.map((e) => e.type)).toEqual(['instruction', 'claude.assistant', 'claude.result']);
    const text = JSON.stringify(body);
    for (const hidden of ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'réflexion privée', '3.21', 'trace interne', 'camille@example.com']) expect(text).not.toContain(hidden);
    expect(await m.service.listActive(sessionId)).toHaveLength(1);
  });

  it('refuse toute autre méthode que GET', async () => {
    const share = await m.service.create(sessionId, userId, 1);
    expect((await call(m.route, `/api/share/${share.token}`, 'POST')).status).toBe(405);
  });

  it('renvoie 404 pour un lien révoqué, expiré ou inconnu', async () => {
    const revoked = await m.service.create(sessionId, userId, 7);
    await m.service.revoke(revoked.id);
    expect((await call(m.route, `/api/share/${revoked.token}`)).status).toBe(404);

    const expired = await m.service.create(sessionId, userId, 1, new Date(Date.now() - 2 * 24 * 3600 * 1000));
    expect((await call(m.route, `/api/share/${expired.token}`)).status).toBe(404);
    expect((await m.service.listActive(sessionId)).map((s) => s.id)).not.toContain(expired.id);

    expect((await call(m.route, '/api/share/inconnu')).status).toBe(404);
    expect((await call(m.route, '/api/sessions/x')).handled).toBe(false);
  });

  it('refuse une durée hors bornes', async () => {
    await expect(m.service.create(sessionId, userId, 0)).rejects.toThrow();
    await expect(m.service.create(sessionId, userId, 31)).rejects.toThrow();
  });
});
