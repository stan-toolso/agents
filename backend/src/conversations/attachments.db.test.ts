import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Fichiers joints aux messages des canaux sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme
 * db/migrate.test.ts) : enregistrés avec le message, retirés à l'édition, effacés (lignes et fichiers) avec le
 * message et ses réponses.
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

const png = (label: string) => ({ name: `${label}.png`, mediaType: 'image/png', data: Buffer.from(`png-${label}`).toString('base64') });

describe.skipIf(!adminUrl)('fichiers joints aux messages (PostgreSQL)', () => {
  const name = `skipper_test_msg_files_${process.pid}_${Date.now()}`;
  let root: string;
  let m: {
    pool: pg.Pool;
    service: typeof import('./service.js').conversationService;
    files: typeof import('./attachments.js');
  };
  let conversationId: string;
  const actor = { type: 'human' as const, userId: null as string | null, name: 'Camille' };

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    root = await mkdtemp(path.join(os.tmpdir(), 'skipper-msg-files-'));
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    process.env.WORKSPACES_ROOT = root;
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    const [{ pool }, { conversationService }, files] = await Promise.all([import('../db/pool.js'), import('./service.js'), import('./attachments.js')]);
    m = { pool, service: conversationService, files };
    const projectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Démo', 'demo') RETURNING id`)).rows[0].id;
    actor.userId = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('camille@example.com', 'Camille') RETURNING id`)).rows[0].id;
    conversationId = (await conversationService.ensureGeneral(projectId)).id;
  });

  afterAll(async () => {
    await m?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('enregistre les fichiers avec le message (texte facultatif), les retire à l’édition et les efface avec le fil', async () => {
    await expect(m.service.post(conversationId, '  ', actor)).rejects.toThrow('vide');
    const first = await m.service.post(conversationId, '', actor, { attachments: [png('a'), png('b')] });
    const stored = await m.service.attachments([first.id]);
    expect(stored.map((a) => [a.name, a.mediaType, a.size, a.conversationId])).toEqual([
      ['a.png', 'image/png', 5, conversationId],
      ['b.png', 'image/png', 5, conversationId],
    ]);
    for (const a of stored) expect(existsSync(m.files.messageAttachmentPath(a))).toBe(true);

    // Édition : un fichier retiré, un ajouté ; un message sans texte ni fichier est refusé.
    await m.service.updateMessage(first.id, 'avec texte', { removeAttachmentIds: [stored[0].id], attachments: [png('c')] });
    const after = await m.service.attachments([first.id]);
    expect(after.map((a) => a.name)).toEqual(['b.png', 'c.png']);
    expect(existsSync(m.files.messageAttachmentPath(stored[0]))).toBe(false);
    await expect(m.service.updateMessage(first.id, '', { removeAttachmentIds: after.map((a) => a.id) })).rejects.toThrow('vide');

    // Une réponse avec fichier : supprimer la racine efface aussi les fichiers des réponses.
    const reply = await m.service.post(conversationId, 'réponse', actor, { parentId: first.id, attachments: [png('d')] });
    const all = await m.service.attachments([first.id, reply.id]);
    expect(all).toHaveLength(3);
    expect(await m.service.deleteMessage(first.id)).toBe(true);
    expect(await m.service.attachments([first.id, reply.id])).toEqual([]);
    for (const a of all) expect(existsSync(m.files.messageAttachmentPath(a))).toBe(false);
  });

  it('refuse un lot trop gros sans rien laisser derrière lui', async () => {
    const many = Array.from({ length: 11 }, (_, i) => png(`f${i}`));
    await expect(m.service.post(conversationId, 'trop', actor, { attachments: many })).rejects.toThrow('Au plus 10');
    expect(await m.service.countMessages(conversationId)).toBe(0);
  });
});
