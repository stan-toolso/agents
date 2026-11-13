import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Versionnage complet des artefacts (PostgreSQL jetable, TEST_DATABASE_URL) : chaque version fige son type, son
 * rafraîchissement et la définition de ses sources (`snapshotLatest`) ; une ancienne version se lit avec ses propres
 * sources (`sourcesOfVersion` : inchangées → données actuelles, modifiées → inactive) et se duplique avec elles.
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

describe.skipIf(!adminUrl)('versions des artefacts (PostgreSQL)', () => {
  const name = `skipper_test_artifact_versions_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./repository.js').sharedPageRepository;
  let data: typeof import('./dataRepository.js').dataSourceRepository;
  let project: string;
  let alice: string;

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
    data = (await import('./dataRepository.js')).dataSourceRepository;
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('A', 'a') RETURNING id`)).rows[0].id;
    alice = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('fige type, rafraîchissement et sources à chaque version, et relit une ancienne version avec les siennes', async () => {
    const { sourcesOfVersion } = await import('./dataService.js');
    const sql = (query: string) => ({ item: 'base', database: null, query });
    const page = await repo.create({ ownerId: alice, title: 'Ventes', description: null, linkAccess: false, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<p>v1</p>'), kind: 'data' });
    await data.replace(page.id, [{ name: 'ventes', kind: 'sql', config: sql('SELECT 1') }]);
    await repo.update(page.id, { refreshMinutes: 60 });
    await repo.snapshotLatest(page.id);

    await repo.addVersion(page.id, { title: 'Ventes', description: null, linkAccess: null, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<p>v2</p>'), createdBy: alice });
    await data.replace(page.id, [
      { name: 'ventes', kind: 'sql', config: sql('SELECT 2') },
      { name: 'pays', kind: 'sql', config: sql('SELECT 3') },
    ]);
    await repo.update(page.id, { refreshMinutes: null });
    await repo.snapshotLatest(page.id);
    const live = await data.list(page.id, true);
    await data.saveSuccess(live.find((s) => s.name === 'pays')!.id, { columns: ['n'], rows: [{ n: 3 }] }, 1, 5);

    const v1 = (await repo.version(page.id, 1))!;
    const v2 = (await repo.version(page.id, 2))!;
    expect(v1).toMatchObject({ kind: 'data', refreshMinutes: 60, sources: [{ name: 'ventes', kind: 'sql', config: sql('SELECT 1') }] });
    expect(v2).toMatchObject({ kind: 'data', refreshMinutes: null });
    expect(v2.sources?.map((s) => s.name)).toEqual(['ventes', 'pays']);
    expect((await repo.versions(page.id)).map((v) => v.version)).toEqual([2, 1]);

    // v1 : la source « ventes » a changé de requête depuis → inactive ; v2 = sources actuelles.
    const now = await data.list(page.id, true);
    expect(sourcesOfVersion(page.id, v1, now).map((s) => [s.name, s.status, s.data])).toEqual([['ventes', 'inactive', null]]);
    expect(sourcesOfVersion(page.id, v2, now).map((s) => [s.name, s.status])).toEqual([['ventes', 'pending'], ['pays', 'ok']]);
    expect(sourcesOfVersion(page.id, { ...v1, sources: null }, now)).toBe(now);

    // Dupliquer la v1 reprend ses sources et son rafraîchissement ; la v2, les sources actuelles avec leurs données.
    const c1 = (await repo.duplicate(page.id, 1, { ownerId: alice, title: 'Copie v1', description: null, projectId: project, sessionId: null, sourcePath: null }))!;
    expect(c1).toMatchObject({ kind: 'data', refreshMinutes: 60 });
    expect((await data.list(c1.id)).map((s) => [s.name, s.status, (s.config as { query: string }).query])).toEqual([['ventes', 'pending', 'SELECT 1']]);
    expect((await repo.version(c1.id, 1))?.sources).toEqual([{ name: 'ventes', kind: 'sql', config: sql('SELECT 1') }]);
    const c2 = (await repo.duplicate(page.id, 2, { ownerId: alice, title: 'Copie v2', description: null, projectId: project, sessionId: null, sourcePath: null }))!;
    expect(c2.refreshMinutes).toBeNull();
    expect(await data.dataOf(c2.id)).toEqual({ ventes: null, pays: { columns: ['n'], rows: [{ n: 3 }] } });
  });

  it('alertes : définitions versionnées, état gardé tant que la règle ne change pas, copie et sources disparues', async () => {
    const { alertRepository } = await import('./alertRepository.js');
    const { parseAlerts } = await import('./alerts.js');
    const sql = (query: string) => ({ item: 'base', database: null, query });
    const sources = [{ name: 'stats', kind: 'sql' as const }];
    const rule = (value: number) => parseAlerts([{ name: 'taux', source: 'stats', path: 'rows.0.taux', op: '>', value }], sources);
    const page = await repo.create({ ownerId: alice, title: 'Alertes', description: null, linkAccess: false, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<p>v1</p>'), kind: 'data' });
    await data.replace(page.id, [{ name: 'stats', kind: 'sql', config: sql('SELECT 1') }]);
    await alertRepository.replace(page.id, rule(5));
    await repo.snapshotLatest(page.id);
    const [a] = await alertRepository.list(page.id);
    await alertRepository.saveEvaluation(a.id, { state: 'firing', streak: 0, value: 7, event: 'triggered', error: null });
    expect((await alertRepository.list(page.id))[0]).toMatchObject({ state: 'firing', lastValue: 7, fireCount: 1 });
    expect((await alertRepository.list(page.id))[0].triggeredAt).not.toBeNull();

    // Même règle : l'état reste ; règle changée : « jamais évaluée ».
    await alertRepository.replace(page.id, rule(5));
    expect((await alertRepository.list(page.id))[0]).toMatchObject({ state: 'firing', fireCount: 1 });
    await repo.addVersion(page.id, { title: 'Alertes', description: null, linkAccess: null, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<p>v2</p>'), createdBy: alice });
    await alertRepository.replace(page.id, rule(10));
    await repo.snapshotLatest(page.id);
    expect((await alertRepository.list(page.id))[0]).toMatchObject({ state: 'unknown', lastValue: null, evaluatedAt: null });
    expect((await repo.version(page.id, 1))?.alerts).toEqual([{ name: 'taux', source: 'stats', config: rule(5)[0].config }]);
    expect((await repo.version(page.id, 2))?.alerts?.[0]?.config).toMatchObject({ value: 10 });

    // Copie de la v1 : sa règle, état remis à zéro.
    const copy = (await repo.duplicate(page.id, 1, { ownerId: alice, title: 'Copie', description: null, projectId: project, sessionId: null, sourcePath: null }))!;
    expect((await alertRepository.list(copy.id)).map((x) => [x.name, x.state, (x.config as { value: number }).value])).toEqual([['taux', 'unknown', 5]]);
    expect((await repo.version(copy.id, 1))?.alerts).toHaveLength(1);

    // Source retirée : l'alerte part avec elle.
    await data.replace(page.id, [{ name: 'autre', kind: 'sql', config: sql('SELECT 2') }]);
    expect(await alertRepository.pruneMissingSources(page.id)).toEqual(['taux']);
    expect(await alertRepository.list(page.id)).toEqual([]);
  });

  it('garde le type de chaque version quand une republication le change', async () => {
    const page = await repo.create({ ownerId: alice, title: 'Deck', description: null, linkAccess: false, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<p>page</p>') });
    await repo.snapshotLatest(page.id);
    await repo.addVersion(page.id, { title: 'Deck', description: null, linkAccess: null, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<section class="slide"></section>'), createdBy: alice, kind: 'slides' });
    await repo.snapshotLatest(page.id);
    expect((await repo.versions(page.id)).map((v) => [v.version, v.kind, v.sources])).toEqual([[2, 'slides', null], [1, 'page', null]]);
  });

  it('source agent : en calcul avec sa session, puis données écrites ; la copie ne reste pas « en calcul »', async () => {
    const page = await repo.create({ ownerId: alice, title: 'Prévisionnel', description: null, linkAccess: false, projectId: project, sessionId: null, sourcePath: null, html: Buffer.from('<p>v1</p>'), kind: 'data' });
    await data.replace(page.id, [{ name: 'resultat', kind: 'agent', config: { prompt: 'Recalcule', agent: null } }]);
    await repo.snapshotLatest(page.id);
    const [src] = await data.list(page.id);
    const session = (await pool.query<{ id: string }>(`INSERT INTO sessions (name, provider, project_id) VALUES ('calcul', 'claude', $1) RETURNING id`, [project])).rows[0].id;
    await data.markRunning(src.id, session);
    expect((await data.list(page.id))[0]).toMatchObject({ status: 'running', sessionId: session });
    const copy = (await repo.duplicate(page.id, 1, { ownerId: alice, title: 'Copie', description: null, projectId: project, sessionId: null, sourcePath: null }))!;
    expect((await data.list(copy.id))[0]).toMatchObject({ status: 'pending', sessionId: null });
    await data.saveAgentData(src.id, { total: 234.83 }, null);
    const [after] = await data.list(page.id, true);
    expect(after).toMatchObject({ status: 'ok', data: { total: 234.83 }, sessionId: session });
    expect(after.durationMs).not.toBeNull();
    expect(after.refreshedAt).not.toBeNull();
  });
});
