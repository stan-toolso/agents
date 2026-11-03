import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Le fil d'une tâche sur les tables des canaux (migration 20261103T1222_task_threads_on_conversations), sur une base
 * PostgreSQL jetable (TEST_DATABASE_URL) : reprise des anciens task_comments / task_reactions / task_attachments en
 * conservant les identifiants, recopie des écritures de l'ancienne version (triggers), façades de taskService
 * (messages, réponses, réactions sur la tâche et sur un message, fichiers), fils suivis, canaux qui ne montrent pas
 * les fils de tâches, déplacement d'une tâche.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

const MIGRATION = '20261103T1222_task_threads_on_conversations.sql';

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const png = (label: string) => ({ name: `${label}.png`, mediaType: 'image/png', data: Buffer.from(`png-${label}`).toString('base64') });

describe.skipIf(!adminUrl)('fil des tâches sur les conversations (PostgreSQL)', () => {
  const name = `skipper_test_task_thread_${process.pid}_${Date.now()}`;
  let root: string;
  let m: {
    pool: pg.Pool;
    tasks: typeof import('./service.js').taskService;
    conversations: typeof import('../conversations/service.js').conversationService;
  };
  let projectId: string;
  let otherProjectId: string;
  let userId: string;
  let legacyTaskId: string;
  const ids = { root: '', reply: '', reaction: '', taskReaction: '', file: '' };

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    root = await mkdtemp(path.join(os.tmpdir(), 'skipper-task-thread-'));
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    process.env.WORKSPACES_ROOT = root;
    const { runMigrations } = await import('../db/migrate.js');
    const { pool } = await import('../db/pool.js');
    // Base d'avant la migration : elle est marquée appliquée le temps de semer d'anciens fils, puis appliquée.
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [MIGRATION]);
    await runMigrations();
    projectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Démo', 'demo') RETURNING id`)).rows[0].id;
    otherProjectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Autre', 'autre') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('camille@example.com', 'Camille') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')`, [projectId, userId]);
    legacyTaskId = (await pool.query<{ id: string }>(`INSERT INTO tasks (project_id, title, created_by_type) VALUES ($1, 'Ancienne', 'human') RETURNING id`, [projectId])).rows[0].id;
    ids.root = (await pool.query<{ id: string }>(
      `INSERT INTO task_comments (task_id, author_type, author_user_id, author_name, body, mentions, created_at) VALUES ($1, 'human', $2, 'Camille', 'Premier', '[]', now() - interval '2 hours') RETURNING id`,
      [legacyTaskId, userId],
    )).rows[0].id;
    ids.reply = (await pool.query<{ id: string }>(
      `INSERT INTO task_comments (task_id, parent_id, author_type, author_name, body, created_at) VALUES ($1, $2, 'agent', 'Ben', 'Réponse', now() - interval '1 hour') RETURNING id`,
      [legacyTaskId, ids.root],
    )).rows[0].id;
    ids.reaction = (await pool.query<{ id: string }>(
      `INSERT INTO task_reactions (task_id, comment_id, emoji, actor_type, user_id, actor_name) VALUES ($1, $2, '👍', 'human', $3, 'Camille') RETURNING id`,
      [legacyTaskId, ids.root, userId],
    )).rows[0].id;
    ids.taskReaction = (await pool.query<{ id: string }>(
      `INSERT INTO task_reactions (task_id, comment_id, emoji, actor_type, user_id, actor_name) VALUES ($1, NULL, '👀', 'human', $2, 'Camille') RETURNING id`,
      [legacyTaskId, userId],
    )).rows[0].id;
    ids.file = (await pool.query<{ id: string }>(
      `INSERT INTO task_attachments (task_id, comment_id, name, media_type, size) VALUES ($1, $2, 'capture.png', 'image/png', 12) RETURNING id`,
      [legacyTaskId, ids.reply],
    )).rows[0].id;
    await pool.query(`INSERT INTO task_attachments (task_id, comment_id, name, media_type, size) VALUES ($1, NULL, 'spec.pdf', 'application/pdf', 30)`, [legacyTaskId]);
    await pool.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION]);
    expect(await runMigrations()).toEqual([MIGRATION]);
    const [{ taskService }, { conversationService }] = await Promise.all([import('./service.js'), import('../conversations/service.js')]);
    m = { pool, tasks: taskService, conversations: conversationService };
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reprend les anciens fils avec leurs identifiants, réactions et fichiers', async () => {
    const comments = await m.tasks.comments(legacyTaskId);
    expect(comments.map((c) => [c.id, c.parentId, c.body, c.taskId])).toEqual([
      [ids.root, null, 'Premier', legacyTaskId],
      [ids.reply, ids.root, 'Réponse', legacyTaskId],
    ]);
    const reactions = await m.tasks.reactions(legacyTaskId);
    expect(reactions.map((r) => [r.id, r.commentId, r.emoji]).sort()).toEqual([[ids.reaction, ids.root, '👍'], [ids.taskReaction, null, '👀']].sort());
    const files = await m.tasks.attachments(legacyTaskId);
    expect(files.map((a) => [a.name, a.commentId])).toEqual([['capture.png', ids.reply], ['spec.pdf', null]]);
    expect((await m.tasks.findAttachment(ids.file))?.commentId).toBe(ids.reply);
    const task = await m.tasks.get(legacyTaskId);
    expect(task.commentCount).toBe(2);
    expect(task.attachmentCount).toBe(1);
  });

  it("recopie les écritures de l'ancienne version (triggers)", async () => {
    const { rows } = await m.pool.query<{ id: string }>(`INSERT INTO task_comments (task_id, author_type, author_name, body) VALUES ($1, 'agent', 'Ben', 'Pendant le drainage') RETURNING id`, [legacyTaskId]);
    expect((await m.tasks.getComment(rows[0].id)).body).toBe('Pendant le drainage');
    await m.pool.query(`UPDATE task_comments SET body = 'Corrigé', updated_at = now() WHERE id = $1`, [rows[0].id]);
    expect((await m.tasks.getComment(rows[0].id)).body).toBe('Corrigé');
    await m.pool.query('DELETE FROM task_comments WHERE id = $1', [rows[0].id]);
    await expect(m.tasks.getComment(rows[0].id)).rejects.toThrow();
  });

  it('écrit le fil d’une nouvelle tâche dans sa conversation', async () => {
    const actor = { type: 'human' as const, userId, name: 'Camille' };
    const task = await m.tasks.create(projectId, { title: 'Nouvelle' }, actor);
    expect(await m.tasks.comments(task.id)).toEqual([]);
    const first = await m.tasks.addComment(task.id, 'Bonjour @Camille', actor, [png('a')]);
    expect(first.mentions.map((x) => x.id)).toEqual([userId]);
    const reply = await m.tasks.addComment(task.id, 'Suite', { type: 'agent', sessionId: null, name: 'Ben' }, null, { parentId: first.id });
    expect(reply.parentId).toBe(first.id);
    const files = await m.tasks.attachments(task.id, first.id);
    expect(files.map((a) => a.name)).toEqual(['a.png']);
    expect((await m.pool.query('SELECT count(*)::int AS n FROM message_attachments WHERE id = $1', [files[0].id])).rows[0].n).toBe(1);

    expect((await m.tasks.toggleReaction(task.id, null, '🎉', actor)).added).toBe(true);
    expect((await m.tasks.toggleReaction(task.id, first.id, '👍', actor)).added).toBe(true);
    expect((await m.tasks.toggleReaction(task.id, first.id, '👍', actor)).added).toBe(false);
    expect((await m.tasks.reactions(task.id)).map((r) => [r.commentId, r.emoji])).toEqual([[null, '🎉']]);

    const edited = await m.tasks.updateComment(reply.id, 'Suite corrigée');
    expect(edited.body).toBe('Suite corrigée');
    expect((await m.tasks.get(task.id)).commentCount).toBe(2);
    expect(await m.tasks.deleteComment(first.id)).toBe(true);
    expect(await m.tasks.comments(task.id)).toEqual([]);
  });

  it('ne montre pas les fils de tâches parmi les canaux, et les liste comme fils suivis', async () => {
    const channels = await m.conversations.list(projectId);
    expect(channels.map((c) => c.kind)).toEqual(['channel']);
    const legacy = (await m.pool.query<{ id: string }>('SELECT id FROM conversations WHERE task_id = $1', [legacyTaskId])).rows[0].id;
    await expect(m.conversations.get(legacy)).rejects.toThrow('Canal introuvable');
    await expect(m.conversations.resolve(projectId, legacy)).rejects.toThrow();
    const followed = await m.conversations.followedTaskThreads(projectId, userId, 'camille@example.com');
    expect(followed.map((t) => t.conversation.taskId)).toContain(legacyTaskId);
    expect(followed.find((t) => t.conversation.taskId === legacyTaskId)?.title).toBe('Ancienne');
    const stranger = (await m.pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('x@example.com', 'X') RETURNING id`)).rows[0].id;
    expect(await m.conversations.followedTaskThreads(projectId, stranger, 'x@example.com')).toEqual([]);
    expect((await m.conversations.unreadByProject([projectId], stranger)).get(projectId) ?? 0).toBe(0);
  });

  it('fait suivre le fil quand la tâche change de projet', async () => {
    await m.tasks.move(legacyTaskId, otherProjectId);
    const { rows } = await m.pool.query<{ project_id: string }>('SELECT project_id FROM conversations WHERE task_id = $1', [legacyTaskId]);
    expect(rows[0].project_id).toBe(otherProjectId);
    expect((await m.tasks.comments(legacyTaskId)).length).toBe(2);
  });
});
