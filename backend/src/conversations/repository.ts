import type { Actor } from '../context/types.js';
import { toJson } from '../db/json.js';
import { pool } from '../db/pool.js';
import type { TaskMention } from '../tasks/types.js';
import type { Conversation, Message, MessageAttachment, MessageReaction } from './types.js';

interface ConversationRow {
  id: string;
  project_id: string;
  kind: 'channel' | 'task' | null;
  task_id: string | null;
  slug: string;
  name: string;
  topic: string;
  created_by_id: string | null;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  author_type: 'human' | 'agent';
  author_user_id: string | null;
  author_session_id: string | null;
  author_name: string;
  body: string;
  mentions: TaskMention[] | null;
  created_at: Date;
  updated_at: Date;
}

interface ReactionRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  emoji: string;
  actor_type: 'human' | 'agent';
  user_id: string | null;
  session_id: string | null;
  actor_name: string;
  created_at: Date;
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind ?? 'channel',
  taskId: r.task_id ?? null,
  slug: r.slug,
  name: r.name,
  topic: r.topic ?? '',
  createdById: r.created_by_id,
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  parentId: r.parent_id ?? null,
  authorType: r.author_type,
  authorUserId: r.author_user_id,
  authorSessionId: r.author_session_id,
  authorName: r.author_name,
  body: r.body,
  mentions: Array.isArray(r.mentions) ? r.mentions : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string;
  name: string;
  media_type: string;
  size: number | string;
  created_at: Date;
}

const toAttachment = (r: AttachmentRow): MessageAttachment => ({ id: r.id, conversationId: r.conversation_id, messageId: r.message_id, name: r.name, mediaType: r.media_type, size: Number(r.size), createdAt: r.created_at });

const toReaction = (r: ReactionRow): MessageReaction => ({ id: r.id, conversationId: r.conversation_id ?? null, messageId: r.message_id ?? null, emoji: r.emoji, actorType: r.actor_type, userId: r.user_id, sessionId: r.session_id, actorName: r.actor_name, createdAt: r.created_at });

export interface MessageAuthor {
  type: Actor['type'];
  userId?: string | null;
  sessionId?: string | null;
  name: string;
}

export const conversationRepository = {
  // ---- Canaux ----------------------------------------------------------------------------------

  /** Canaux d'un projet (pas les fils de tâches), non archivés par défaut, le dernier actif d'abord (le canal général toujours en tête). */
  async list(projectId: string, opts: { includeArchived?: boolean } = {}): Promise<Conversation[]> {
    const { rows } = await pool.query<ConversationRow>(
      `SELECT * FROM conversations WHERE project_id = $1 AND kind = 'channel'${opts.includeArchived ? '' : ' AND archived_at IS NULL'}
       ORDER BY (slug = 'general') DESC, last_message_at DESC NULLS LAST, created_at ASC`,
      [projectId],
    );
    return rows.map(toConversation);
  },

  async findById(id: string): Promise<Conversation | null> {
    const { rows } = await pool.query<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
    return rows[0] ? toConversation(rows[0]) : null;
  },

  async findBySlug(projectId: string, slug: string): Promise<Conversation | null> {
    const { rows } = await pool.query<ConversationRow>('SELECT * FROM conversations WHERE project_id = $1 AND slug = $2', [projectId, slug]);
    return rows[0] ? toConversation(rows[0]) : null;
  },

  /** La conversation (fil) d'une tâche, créée au besoin ; null si la tâche n'existe pas. */
  async ensureForTask(taskId: string): Promise<Conversation | null> {
    const { rows } = await pool.query<{ id: string | null }>('SELECT task_conversation_id($1) AS id', [taskId]);
    return rows[0]?.id ? this.findById(rows[0].id) : null;
  },

  /** La conversation d'une tâche, si elle existe déjà. */
  async findByTask(taskId: string): Promise<Conversation | null> {
    const { rows } = await pool.query<ConversationRow>('SELECT * FROM conversations WHERE task_id = $1', [taskId]);
    return rows[0] ? toConversation(rows[0]) : null;
  },

  /** Une tâche change de projet : son fil la suit. */
  async moveTaskConversation(taskId: string, projectId: string): Promise<void> {
    await pool.query('UPDATE conversations SET project_id = $2, updated_at = now() WHERE task_id = $1', [taskId, projectId]);
  },

  /**
   * Fils de tâches que la personne suit dans un projet, le plus récemment actif d'abord : elle y a écrit, réagi ou
   * y est mentionnée, ou elle est responsable ou rapporteur de la tâche (par e-mail).
   */
  async followedTaskThreads(projectId: string, userId: string, email: string | null, limit = 30): Promise<{ conversation: Conversation; title: string; status: string; messageCount: number }[]> {
    const { rows } = await pool.query<ConversationRow & { title: string; status: string; message_count: string }>(
      `SELECT c.*, t.title, t.status, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c JOIN tasks t ON t.id = c.task_id
       WHERE c.project_id = $1 AND c.kind = 'task' AND c.last_message_at IS NOT NULL AND (
         EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND (m.author_user_id = $2 OR m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', $2::text))))
         OR EXISTS (SELECT 1 FROM message_reactions r WHERE r.conversation_id = c.id AND r.user_id = $2)
         OR ($3::text IS NOT NULL AND (lower(t.assignee_email) = $3 OR lower(t.reporter_email) = $3)))
       ORDER BY c.last_message_at DESC LIMIT $4`,
      [projectId, userId, email?.toLowerCase() ?? null, limit],
    );
    return rows.map((r) => ({ conversation: toConversation(r), title: r.title, status: r.status, messageCount: Number(r.message_count) }));
  },

  async create(input: { projectId: string; slug: string; name: string; topic: string; createdById: string | null }): Promise<Conversation> {
    const { rows } = await pool.query<ConversationRow>(
      `INSERT INTO conversations (project_id, slug, name, topic, created_by_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, slug) DO UPDATE SET updated_at = conversations.updated_at RETURNING *`,
      [input.projectId, input.slug, input.name, input.topic, input.createdById],
    );
    return toConversation(rows[0]);
  },

  async update(id: string, input: { name?: string; topic?: string; archivedAt?: Date | null }): Promise<Conversation | null> {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (input.name !== undefined) sets.push(`name = $${params.push(input.name)}`);
    if (input.topic !== undefined) sets.push(`topic = $${params.push(input.topic)}`);
    if (input.archivedAt !== undefined) sets.push(`archived_at = $${params.push(input.archivedAt)}`);
    const { rows } = await pool.query<ConversationRow>(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toConversation(rows[0]) : null;
  },

  // ---- Messages --------------------------------------------------------------------------------

  /**
   * Les derniers messages racines d'un canal (`limit`, avant `before` s'il est donné) avec toutes leurs réponses, du
   * plus ancien au plus récent.
   */
  async listMessages(conversationId: string, opts: { before?: Date | null; limit?: number } = {}): Promise<Message[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [conversationId, limit];
    const before = opts.before ? ` AND created_at < $${params.push(opts.before)}` : '';
    const { rows } = await pool.query<MessageRow>(
      `WITH roots AS (SELECT * FROM messages WHERE conversation_id = $1 AND parent_id IS NULL${before} ORDER BY created_at DESC, id DESC LIMIT $2)
       SELECT * FROM roots
       UNION ALL
       SELECT m.* FROM messages m WHERE m.parent_id IN (SELECT id FROM roots)
       ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(toMessage);
  },

  /** Tous les messages d'une conversation, du plus ancien au plus récent (le fil d'une tâche). */
  async listAllMessages(conversationId: string): Promise<Message[]> {
    const { rows } = await pool.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC', [conversationId]);
    return rows.map(toMessage);
  },

  /** Un fil : le message racine et ses réponses, dans l'ordre. */
  async listThread(rootId: string): Promise<Message[]> {
    const { rows } = await pool.query<MessageRow>('SELECT * FROM messages WHERE id = $1 OR parent_id = $1 ORDER BY created_at ASC, id ASC', [rootId]);
    return rows.map(toMessage);
  },

  async findMessage(id: string): Promise<Message | null> {
    const { rows } = await pool.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id]);
    return rows[0] ? toMessage(rows[0]) : null;
  },

  async countMessages(conversationId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM messages WHERE conversation_id = $1', [conversationId]);
    return Number(rows[0]?.n ?? 0);
  },

  /** Nombre de réponses et date de la dernière, par message racine. */
  async replyStats(rootIds: string[]): Promise<Map<string, { count: number; lastAt: Date }>> {
    if (!rootIds.length) return new Map();
    const { rows } = await pool.query<{ parent_id: string; n: string; last_at: Date }>('SELECT parent_id, count(*) AS n, max(created_at) AS last_at FROM messages WHERE parent_id = ANY($1::uuid[]) GROUP BY parent_id', [rootIds]);
    return new Map(rows.map((r) => [r.parent_id, { count: Number(r.n), lastAt: r.last_at }]));
  },

  async addMessage(conversationId: string, body: string, author: MessageAuthor, opts: { parentId?: string | null; mentions?: TaskMention[] } = {}): Promise<Message> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<MessageRow>(
        `INSERT INTO messages (conversation_id, parent_id, author_type, author_user_id, author_session_id, author_name, body, mentions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
        [conversationId, opts.parentId ?? null, author.type, author.userId ?? null, author.sessionId ?? null, author.name, body, toJson(opts.mentions ?? [])],
      );
      await client.query('UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [conversationId]);
      // L'auteur (personne) a lu ce qu'il vient d'écrire.
      if (author.userId) {
        await client.query(
          'INSERT INTO conversation_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, now()) ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()',
          [conversationId, author.userId],
        );
      }
      await client.query('COMMIT');
      return toMessage(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Modifie le texte d'un message (et ses mentions quand elles sont données). */
  async updateMessage(id: string, body: string, mentions?: TaskMention[]): Promise<Message | null> {
    const { rows } = mentions
      ? await pool.query<MessageRow>('UPDATE messages SET body = $2, mentions = $3::jsonb, updated_at = now() WHERE id = $1 RETURNING *', [id, body, toJson(mentions)])
      : await pool.query<MessageRow>('UPDATE messages SET body = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, body]);
    return rows[0] ? toMessage(rows[0]) : null;
  },

  async deleteMessage(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM messages WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Fichiers joints ------------------------------------------------------------------------

  /** Fichiers joints à des messages, dans l'ordre d'ajout. */
  async listAttachments(messageIds: string[]): Promise<MessageAttachment[]> {
    if (!messageIds.length) return [];
    const { rows } = await pool.query<AttachmentRow>('SELECT * FROM message_attachments WHERE message_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC', [messageIds]);
    return rows.map(toAttachment);
  },

  /** Fichiers d'un message et de ses réponses (avant sa suppression : les lignes partent en cascade, pas les fichiers). */
  async listAttachmentsWithReplies(messageId: string): Promise<MessageAttachment[]> {
    const { rows } = await pool.query<AttachmentRow>('SELECT a.* FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE m.id = $1 OR m.parent_id = $1', [messageId]);
    return rows.map(toAttachment);
  },

  async findAttachment(id: string): Promise<MessageAttachment | null> {
    const { rows } = await pool.query<AttachmentRow>('SELECT * FROM message_attachments WHERE id = $1', [id]);
    return rows[0] ? toAttachment(rows[0]) : null;
  },

  async createAttachment(input: Omit<MessageAttachment, 'createdAt'>): Promise<MessageAttachment> {
    const { rows } = await pool.query<AttachmentRow>('INSERT INTO message_attachments (id, conversation_id, message_id, name, media_type, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
      input.id,
      input.conversationId,
      input.messageId,
      input.name,
      input.mediaType,
      input.size,
    ]);
    return toAttachment(rows[0]);
  },

  async deleteAttachment(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM message_attachments WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Réactions -------------------------------------------------------------------------------

  async listReactions(messageIds: string[]): Promise<MessageReaction[]> {
    if (!messageIds.length) return [];
    const { rows } = await pool.query<ReactionRow>('SELECT * FROM message_reactions WHERE message_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC', [messageIds]);
    return rows.map(toReaction);
  },

  /** Toutes les réactions d'une conversation (sur ses messages et sur son ouverture), les plus anciennes d'abord. */
  async listConversationReactions(conversationId: string): Promise<MessageReaction[]> {
    const { rows } = await pool.query<ReactionRow>(
      `SELECT * FROM message_reactions WHERE conversation_id = $1
       UNION SELECT r.* FROM message_reactions r JOIN messages m ON m.id = r.message_id WHERE m.conversation_id = $1 AND r.conversation_id IS NULL
       ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    return rows.map(toReaction);
  },

  /** Pose la réaction si l'acteur ne l'a pas encore, la retire sinon. `messageId` null : l'ouverture de la conversation (description d'une tâche). */
  async toggleReaction(target: { conversationId: string; messageId: string | null }, emoji: string, actor: MessageAuthor): Promise<{ reaction: MessageReaction; added: boolean }> {
    const key = actor.userId ?? actor.sessionId ?? null;
    const { rows: existing } = target.messageId
      ? await pool.query<ReactionRow>('SELECT * FROM message_reactions WHERE message_id = $1 AND emoji = $2 AND COALESCE(user_id, session_id) = $3', [target.messageId, emoji, key])
      : await pool.query<ReactionRow>('SELECT * FROM message_reactions WHERE conversation_id = $1 AND message_id IS NULL AND emoji = $2 AND COALESCE(user_id, session_id) = $3', [target.conversationId, emoji, key]);
    if (existing[0]) {
      await pool.query('DELETE FROM message_reactions WHERE id = $1', [existing[0].id]);
      return { reaction: toReaction(existing[0]), added: false };
    }
    const { rows } = await pool.query<ReactionRow>(
      'INSERT INTO message_reactions (conversation_id, message_id, emoji, actor_type, user_id, session_id, actor_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [target.conversationId, target.messageId, emoji, actor.type, actor.userId ?? null, actor.sessionId ?? null, actor.name],
    );
    return { reaction: toReaction(rows[0]), added: true };
  },

  // ---- Sessions reliées à un fil ---------------------------------------------------------------

  async linkSession(rootMessageId: string, sessionId: string): Promise<void> {
    await pool.query('INSERT INTO conversation_sessions (root_message_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rootMessageId, sessionId]);
  },

  /** Sessions reliées à un fil, la plus récemment reliée d'abord. */
  async sessionIdsOnThread(rootMessageId: string): Promise<string[]> {
    const { rows } = await pool.query<{ session_id: string }>('SELECT session_id FROM conversation_sessions WHERE root_message_id = $1 ORDER BY linked_at DESC', [rootMessageId]);
    return rows.map((r) => r.session_id);
  },

  /** Fils (messages racines) auxquels une session est reliée. */
  async threadsOfSession(sessionId: string): Promise<Message[]> {
    const { rows } = await pool.query<MessageRow>('SELECT m.* FROM conversation_sessions cs JOIN messages m ON m.id = cs.root_message_id WHERE cs.session_id = $1 ORDER BY cs.linked_at DESC', [sessionId]);
    return rows.map(toMessage);
  },

  /** Sessions de l'agent (propriétaire) reliées au fil, la plus récente d'abord : non archivées, ou archivées seulement (`archived`). */
  async agentSessionIdsOnThread(agentId: string, rootMessageId: string, opts: { archived?: boolean } = {}): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id FROM conversation_sessions cs JOIN sessions s ON s.id = cs.session_id WHERE cs.root_message_id = $1 AND s.owner_id = $2 AND s.archived_at IS ${opts.archived ? 'NOT NULL' : 'NULL'} ORDER BY cs.linked_at DESC`,
      [rootMessageId, agentId],
    );
    return rows.map((r) => r.id);
  },

  /** Sessions reliées au fil qui tournent et dont l'agent travaille (« X répond… »). */
  async busySessionIdsOnThread(rootMessageId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id FROM conversation_sessions cs JOIN sessions s ON s.id = cs.session_id WHERE cs.root_message_id = $1 AND s.status = 'running' AND s.activity = 'busy'`,
      [rootMessageId],
    );
    return rows.map((r) => r.id);
  },

  // ---- Lectures --------------------------------------------------------------------------------

  async markRead(conversationId: string, userId: string): Promise<void> {
    await pool.query('INSERT INTO conversation_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, now()) ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()', [conversationId, userId]);
  },

  /** Dernière lecture d'un canal par la personne (null : jamais ouvert). */
  async lastReadAt(conversationId: string, userId: string): Promise<Date | null> {
    const { rows } = await pool.query<{ last_read_at: Date }>('SELECT last_read_at FROM conversation_reads WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    return rows[0]?.last_read_at ?? null;
  },

  /** Messages non lus par la personne, par canal (ceux des autres, postés après sa dernière lecture). */
  async unreadCounts(conversationIds: string[], userId: string): Promise<Map<string, number>> {
    if (!conversationIds.length) return new Map();
    const { rows } = await pool.query<{ conversation_id: string; n: string }>(
      `SELECT m.conversation_id, count(*) AS n FROM messages m
       LEFT JOIN conversation_reads r ON r.conversation_id = m.conversation_id AND r.user_id = $2
       WHERE m.conversation_id = ANY($1::uuid[]) AND m.author_user_id IS DISTINCT FROM $2 AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
       GROUP BY m.conversation_id`,
      [conversationIds, userId],
    );
    return new Map(rows.map((r) => [r.conversation_id, Number(r.n)]));
  },

  /** Non-lus de la personne sur les canaux (non archivés) des projets donnés, par projet. */
  async unreadByProject(projectIds: string[], userId: string): Promise<Map<string, number>> {
    if (!projectIds.length) return new Map();
    const { rows } = await pool.query<{ project_id: string; n: string }>(
      `SELECT c.project_id, count(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.archived_at IS NULL AND c.kind = 'channel'
       LEFT JOIN conversation_reads r ON r.conversation_id = m.conversation_id AND r.user_id = $2
       WHERE c.project_id = ANY($1::uuid[]) AND m.author_user_id IS DISTINCT FROM $2 AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
       GROUP BY c.project_id`,
      [projectIds, userId],
    );
    return new Map(rows.map((r) => [r.project_id, Number(r.n)]));
  },
};
