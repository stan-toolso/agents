import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Aller-retour export → import d'un projet sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme
 * db/migrate.test.ts) : le contexte importé reproduit la même arborescence (noms, versions), les tâches leur fil.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

// Les skills sont écrits sur disque après chaque modification du contexte : sans objet ici.
vi.mock('../context/skills.js', () => ({ materializeSkills: async () => '' }));

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe.skipIf(!adminUrl)('export et import d’un projet (PostgreSQL)', () => {
  const name = `skipper_test_exports_${process.pid}_${Date.now()}`;
  let m: {
    pool: pg.Pool;
    contextService: typeof import('../context/service.js').contextService;
    taskRepository: typeof import('../tasks/repository.js').taskRepository;
    collectProjectExport: typeof import('./service.js').collectProjectExport;
    importProjectArchive: typeof import('./service.js').importProjectArchive;
    buildProjectArchive: typeof import('./projectArchive.js').buildProjectArchive;
  };
  let source: string;
  let target: string;
  const human = { type: 'human' as const };

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    const [{ pool }, { contextService }, { taskRepository }, service, archive] = await Promise.all([
      import('../db/pool.js'),
      import('../context/service.js'),
      import('../tasks/repository.js'),
      import('./service.js'),
      import('./projectArchive.js'),
    ]);
    m = { pool, contextService, taskRepository, collectProjectExport: service.collectProjectExport, importProjectArchive: service.importProjectArchive, buildProjectArchive: archive.buildProjectArchive };
    source = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug, system_prompt) VALUES ('Source', 'source', 'Sois bref') RETURNING id`)).rows[0].id;
    target = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Cible', 'cible') RETURNING id`)).rows[0].id;

    // Contexte : dossiers imbriqués aux noms accentués, un dossier vide, une instruction en deux versions.
    const dev = await contextService.createFolder(source, { name: 'Développement' }, human);
    const api = await contextService.createFolder(source, { parentId: dev.id, name: 'API Rest' }, human);
    await contextService.createFolder(source, { name: 'Vide' }, human);
    const rules = await contextService.createInstruction(source, { folderId: api.id, name: 'Règles JWT', description: 'Jetons', content: 'v1' }, human);
    await contextService.updateInstruction(rules.id, { content: 'v2', changeNote: 'Précision' }, { type: 'agent' });
    await contextService.createInstruction(source, { name: 'Accueil', content: '# Bienvenue' }, human);

    // Tâches : une terminée, une ouverte avec un message et une réponse.
    await taskRepository.create(source, { title: 'Faite', status: 'done', tags: ['infra'] }, human);
    const open = await taskRepository.create(source, { title: 'Ouverte', description: 'À faire', priority: 'high', customFields: [{ key: 'Lien', value: 'x' }] }, human);
    const root = await taskRepository.addComment(open.id, 'Question ?', { type: 'human', name: 'Camille' });
    await taskRepository.addComment(open.id, 'Réponse.', { type: 'agent', name: 'Agent' }, { parentId: root.id });
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('reproduit la même arborescence de contexte, versions comprises', async () => {
    const archive = m.buildProjectArchive(await m.collectProjectExport(source));
    const report = await m.importProjectArchive(target, archive, { context: true, tasks: true, settings: true });
    expect(report).toMatchObject({ foldersCreated: 3, instructionsCreated: 2, instructionsSkipped: [], tasksCreated: 2, commentsCreated: 2, settingsUpdated: true });

    const [a, b] = await Promise.all([m.contextService.tree(source), m.contextService.tree(target)]);
    const shape = (t: typeof a) => ({
      folders: t.folders.map((f) => [f.path, f.name]),
      instructions: t.instructions.map((i) => [i.path, i.name, i.description, i.content, i.version]),
    });
    expect(shape(b)).toEqual(shape(a));
    expect(shape(b).folders).toContainEqual(['developpement/api-rest', 'API Rest']);

    const rulesB = b.instructions.find((i) => i.path === 'developpement/api-rest/regles-jwt')!;
    const versions = await m.pool.query('SELECT version, content, change_note, author_type FROM context_instruction_versions WHERE instruction_id = $1 ORDER BY version', [rulesB.id]);
    expect(versions.rows).toEqual([
      { version: 1, content: 'v1', change_note: 'Création', author_type: 'human' },
      { version: 2, content: 'v2', change_note: 'Précision', author_type: 'agent' },
    ]);
  });

  it('importe les tâches avec leur fil et les réglages', async () => {
    const tasks = await m.taskRepository.list({ projectId: target, status: ['todo', 'in_progress', 'done', 'cancelled'] });
    expect(tasks.map((t) => [t.title, t.status, t.priority]).sort()).toEqual([
      ['Faite', 'done', 'medium'],
      ['Ouverte', 'todo', 'high'],
    ]);
    const open = tasks.find((t) => t.title === 'Ouverte')!;
    expect(open.customFields).toEqual([{ key: 'Lien', value: 'x' }]);
    const comments = await m.taskRepository.listComments(open.id);
    expect(comments.map((c) => c.body)).toEqual(['Question ?', 'Réponse.']);
    expect(comments[1].parentId).toBe(comments[0].id);
    const { rows } = await m.pool.query('SELECT system_prompt FROM projects WHERE id = $1', [target]);
    expect(rows[0].system_prompt).toBe('Sois bref');
  });

  it('laisse en place les instructions déjà présentes à un second import', async () => {
    const archive = m.buildProjectArchive(await m.collectProjectExport(source));
    const report = await m.importProjectArchive(target, archive, { context: true, tasks: false, settings: false });
    expect(report.foldersCreated).toBe(0);
    expect(report.instructionsCreated).toBe(0);
    expect(report.instructionsSkipped.sort()).toEqual(['accueil', 'developpement/api-rest/regles-jwt']);
  });
});
