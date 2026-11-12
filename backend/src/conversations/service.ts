import { AppError, NotFoundError } from '../errors.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { slugify } from '../projects/slug.js';
import { fold, findMentions, type Mentionable } from '../tasks/mentions.js';
import { normalizeEmoji, taskService } from '../tasks/service.js';
import type { TaskMention } from '../tasks/types.js';
import { userRepository } from '../users/repository.js';
import type { AttachmentInput } from '../sessions/types.js';
import { describeMessageAttachments, removeMessageAttachmentFiles, removeMessageAttachments, storeMessageAttachments, validateMessageAttachments, type MessageFilesDelivery } from './attachments.js';

export { describeMessageAttachments, type MessageFilesDelivery } from './attachments.js';
import { conversationRepository } from './repository.js';
import { CONVERSATION_NAME_MAX, CONVERSATION_SLUG_MAX, CONVERSATION_TOPIC_MAX, GENERAL_NAME, GENERAL_SLUG, type Conversation, type ConversationChange, type Message, type MessageActor, type MessageAttachment, type MessageReaction } from './types.js';

const MAX_MESSAGE = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listeners = new Map<string, (change: ConversationChange) => Promise<void> | void>();

function notifyChanged(change: ConversationChange): void {
  for (const [name, fn] of listeners) {
    Promise.resolve()
      .then(() => fn(change))
      .catch((err) => log.error(`[conversations] écouteur ${name} en erreur`, err));
  }
}

/** « #général » : le nom d'un canal tel qu'on l'écrit. */
export const channelRef = (c: Pick<Conversation, 'slug'>) => `#${c.slug}`;

/** Lien d'un message dans l'interface. */
export const messageLink = (c: Pick<Conversation, 'projectId' | 'slug'>, messageId?: string | null) => `/projects/${c.projectId}/conversations/${c.slug}${messageId ? `#m-${messageId}` : ''}`;

const authorName = (actor: MessageActor) => actor.name?.trim() || (actor.type === 'agent' ? 'Agent' : "Quelqu'un");

function normalizeName(name: string): { name: string; slug: string } {
  const clean = name.replace(/^#+/, '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new AppError('Le nom du canal est obligatoire');
  if (clean.length > CONVERSATION_NAME_MAX) throw new AppError(`Le nom du canal dépasse ${CONVERSATION_NAME_MAX} caractères`);
  const slug = slugify(clean).slice(0, CONVERSATION_SLUG_MAX);
  if (!slug) throw new AppError('Le nom du canal doit contenir des lettres ou des chiffres');
  return { name: clean, slug };
}

function normalizeTopic(topic: string | null | undefined): string {
  const t = (topic ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > CONVERSATION_TOPIC_MAX) throw new AppError(`Le sujet du canal dépasse ${CONVERSATION_TOPIC_MAX} caractères`);
  return t;
}

export const conversationService = {
  onChanged: (name: string, fn: (change: ConversationChange) => Promise<void> | void) => listeners.set(name, fn),

  // ---- Canaux ----------------------------------------------------------------------------------

  /** Le canal général du projet, créé à la première demande. */
  async ensureGeneral(projectId: string): Promise<Conversation> {
    return (await conversationRepository.findBySlug(projectId, GENERAL_SLUG)) ?? conversationRepository.create({ projectId, slug: GENERAL_SLUG, name: GENERAL_NAME, topic: '', createdById: null });
  },

  /** Canaux du projet (le général d'abord, créé au besoin). */
  async list(projectId: string, opts: { includeArchived?: boolean } = {}): Promise<Conversation[]> {
    await this.ensureGeneral(projectId);
    return conversationRepository.list(projectId, opts);
  },

  /**
   * Un canal. Le fil d'une tâche est aussi une conversation, mais il ne se lit ni ne s'écrit par les canaux : ses
   * effets (notifications, sessions reliées à la tâche, convocations) sont ceux de la tâche (taskService.addComment…).
   */
  async get(id: string): Promise<Conversation> {
    const c = await conversationRepository.findById(id);
    if (!c || c.kind !== 'channel') throw new NotFoundError('Canal introuvable');
    return c;
  },

  /** Fils de tâches que la personne suit dans le projet (onglet Conversations). */
  followedTaskThreads: (projectId: string, userId: string, email: string | null, limit?: number) => conversationRepository.followedTaskThreads(projectId, userId, email, limit),

  /** Canal désigné par son identifiant, son slug (« général », « #general ») ou son nom, dans le projet. */
  async resolve(projectId: string, ref: string): Promise<Conversation> {
    const r = ref.trim();
    if (UUID_RE.test(r)) {
      const c = await conversationRepository.findById(r);
      if (c && c.projectId === projectId && c.kind === 'channel') return c;
      throw new NotFoundError(`Canal ${r} introuvable dans ce projet`);
    }
    const wanted = fold(r.replace(/^#/, ''));
    const all = await this.list(projectId, { includeArchived: true });
    const found = all.find((c) => fold(c.slug) === wanted || fold(c.name) === wanted || slugify(c.name) === slugify(wanted));
    if (!found) throw new NotFoundError(`Canal « ${r} » introuvable : ${all.map(channelRef).join(', ')}`);
    return found;
  },

  async create(projectId: string, input: { name: string; topic?: string | null }, createdById: string | null): Promise<Conversation> {
    const { name, slug } = normalizeName(input.name);
    if (await conversationRepository.findBySlug(projectId, slug)) throw new AppError(`Le canal #${slug} existe déjà`);
    return conversationRepository.create({ projectId, slug, name, topic: normalizeTopic(input.topic), createdById });
  },

  async update(id: string, input: { name?: string | null; topic?: string | null }): Promise<Conversation> {
    const current = await this.get(id);
    const patch: { name?: string; topic?: string } = {};
    if (input.name != null) {
      if (current.slug === GENERAL_SLUG) throw new AppError('Le canal général ne se renomme pas');
      patch.name = normalizeName(input.name).name;
    }
    if (input.topic !== undefined) patch.topic = normalizeTopic(input.topic);
    const c = await conversationRepository.update(id, patch);
    if (!c) throw new NotFoundError('Canal introuvable');
    return c;
  },

  async setArchived(id: string, archived: boolean): Promise<Conversation> {
    const current = await this.get(id);
    if (archived && current.slug === GENERAL_SLUG) throw new AppError("Le canal général ne s'archive pas");
    const c = await conversationRepository.update(id, { archivedAt: archived ? new Date() : null });
    if (!c) throw new NotFoundError('Canal introuvable');
    return c;
  },

  // ---- Messages --------------------------------------------------------------------------------

  messages: (conversationId: string, opts: { before?: Date | null; limit?: number } = {}) => conversationRepository.listMessages(conversationId, opts),
  thread: (rootId: string) => conversationRepository.listThread(rootId),
  reactions: (messageIds: string[]) => conversationRepository.listReactions(messageIds),
  attachments: (messageIds: string[]) => conversationRepository.listAttachments(messageIds),
  findAttachment: (id: string) => conversationRepository.findAttachment(id),
  replyStats: (rootIds: string[]) => conversationRepository.replyStats(rootIds),
  countMessages: (conversationId: string) => conversationRepository.countMessages(conversationId),
  linkSession: (rootMessageId: string, sessionId: string) => conversationRepository.linkSession(rootMessageId, sessionId),
  sessionIdsOnThread: (rootMessageId: string) => conversationRepository.sessionIdsOnThread(rootMessageId),
  busySessionIdsOnThread: (rootMessageId: string) => conversationRepository.busySessionIdsOnThread(rootMessageId),
  threadsOfSession: (sessionId: string) => conversationRepository.threadsOfSession(sessionId),
  agentSessionIdsOnThread: (agentId: string, rootMessageId: string, opts: { archived?: boolean } = {}) => conversationRepository.agentSessionIdsOnThread(agentId, rootMessageId, opts),
  markRead: (conversationId: string, userId: string) => conversationRepository.markRead(conversationId, userId),
  lastReadAt: (conversationId: string, userId: string) => conversationRepository.lastReadAt(conversationId, userId),
  unreadCounts: (conversationIds: string[], userId: string) => conversationRepository.unreadCounts(conversationIds, userId),
  unreadByProject: (projectIds: string[], userId: string) => conversationRepository.unreadByProject(projectIds, userId),

  async getMessage(id: string): Promise<Message> {
    const m = await conversationRepository.findMessage(id);
    if (!m) throw new NotFoundError('Message introuvable');
    return m;
  },

  /** Le message racine du fil d'un message (lui-même s'il est racine). */
  async rootOf(message: Message): Promise<Message> {
    return message.parentId ? this.getMessage(message.parentId) : message;
  },

  /** Qui l'on peut mentionner dans les canaux du projet : la même liste que dans le fil des tâches. */
  mentionables: (projectId: string): Promise<Mentionable[]> => taskService.mentionables(projectId),

  async resolveMentions(projectId: string, body: string): Promise<TaskMention[]> {
    return body.includes('@') ? findMentions(body, await this.mentionables(projectId)) : [];
  },

  /**
   * Poste un message dans un canal. `parentId` : réponse dans le fil d'un message (une réponse à une réponse rejoint
   * le fil de la racine). Les mentions sont résolues parmi les membres et sessions du projet : les personnes
   * mentionnées et l'auteur du message auquel on répond sont notifiés, les sessions mentionnées sont reliées au fil
   * (elles reçoivent le message), les agents mentionnés sont convoqués par les déclencheurs (agents/triggers.ts).
   */
  async post(conversationId: string, body: string, author: MessageActor, opts: { parentId?: string | null; attachments?: AttachmentInput[] | null } = {}): Promise<Message> {
    const conversation = await this.get(conversationId);
    if (conversation.archivedAt) throw new AppError(`Le canal ${channelRef(conversation)} est archivé`);
    const text = body.replace(/\u0000/g, '').trim();
    if (!text && !opts.attachments?.length) throw new AppError('Le message est vide');
    if (text.length > MAX_MESSAGE) throw new AppError(`Le message dépasse ${MAX_MESSAGE} caractères`);
    await validateMessageAttachments(null, opts.attachments);
    let parent: Message | null = null;
    if (opts.parentId) {
      parent = await this.getMessage(opts.parentId);
      if (parent.conversationId !== conversationId) throw new AppError("Le message auquel vous répondez n'appartient pas à ce canal");
      if (parent.parentId) parent = await this.getMessage(parent.parentId);
    }
    const mentions = await this.resolveMentions(conversation.projectId, text);
    const message = await conversationRepository.addMessage(conversationId, text, { type: author.type, userId: author.userId, sessionId: author.sessionId, name: authorName(author) }, { parentId: parent?.id ?? null, mentions });
    const attachments = await storeMessageAttachments(conversationId, message.id, opts.attachments).catch(async (err) => {
      await conversationRepository.deleteMessage(message.id).catch(() => undefined);
      throw err;
    });
    const root = parent ?? message;
    // L'autrice (session) et les sessions mentionnées suivent le fil.
    if (author.sessionId) await conversationRepository.linkSession(root.id, author.sessionId).catch((err) => log.warn('[conversations] session autrice non reliée', err));
    for (const m of mentions) if (m.kind === 'session') await conversationRepository.linkSession(root.id, m.id).catch((err) => log.warn('[conversations] session mentionnée non reliée', err));
    void this.notifyPeople(conversation, message, parent, author);
    notifyChanged({ kind: 'posted', conversation, message, root, parent, attachments });
    return message;
  },

  /** Notifications d'un nouveau message : aux personnes mentionnées, et à l'auteur (humain) du message auquel il répond. */
  async notifyPeople(conversation: Conversation, message: Message, parent: Message | null, author: MessageActor): Promise<void> {
    const excerpt = message.body.length > 140 ? `${message.body.slice(0, 140)}…` : message.body || '(fichiers joints)';
    const notified = new Set<string>();
    if (author.userId) notified.add(author.userId);
    const base = { link: messageLink(conversation, message.id), projectId: conversation.projectId, sessionId: author.sessionId ?? null, payload: { conversationId: conversation.id, messageId: message.id } };
    for (const m of message.mentions) {
      if (m.kind !== 'user' || notified.has(m.id)) continue;
      notified.add(m.id);
      // Un agent mentionné n'est pas notifié : il est convoqué (agents/triggers.ts) ou reçoit le message par le fil.
      if ((await userRepository.findById(m.id))?.kind === 'agent') continue;
      await notificationService.notify({ ...base, type: 'conversation.mentioned', userId: m.id, title: `${message.authorName} vous mentionne · ${channelRef(conversation)}`, message: excerpt });
    }
    if (parent?.authorUserId && !notified.has(parent.authorUserId)) {
      await notificationService.notify({ ...base, type: 'conversation.replied', userId: parent.authorUserId, title: `${message.authorName} répond à votre message · ${channelRef(conversation)}`, message: excerpt });
    }
  },

  /** Modifie le texte d'un message ; `files` : fichiers ajoutés (base64) et retirés (identifiants). */
  async updateMessage(id: string, body: string, files: { attachments?: AttachmentInput[] | null; removeAttachmentIds?: string[] | null } = {}): Promise<Message> {
    const current = await this.getMessage(id);
    const kept = (await conversationRepository.listAttachments([id])).filter((a) => !files.removeAttachmentIds?.includes(a.id));
    const text = body.replace(/\u0000/g, '').trim();
    if (!text && kept.length + (files.attachments?.length ?? 0) === 0) throw new AppError('Le message est vide');
    if (text.length > MAX_MESSAGE) throw new AppError(`Le message dépasse ${MAX_MESSAGE} caractères`);
    await validateMessageAttachments(id, files.attachments, files.removeAttachmentIds);
    const conversation = await this.get(current.conversationId);
    const m = await conversationRepository.updateMessage(id, text, await this.resolveMentions(conversation.projectId, text));
    if (!m) throw new NotFoundError('Message introuvable');
    await removeMessageAttachments(id, files.removeAttachmentIds);
    await storeMessageAttachments(current.conversationId, id, files.attachments);
    return m;
  },

  /** Supprime un message (et ses réponses, en cascade) avec leurs fichiers (les lignes partent en cascade, les fichiers ici). */
  async deleteMessage(id: string): Promise<boolean> {
    await this.get((await this.getMessage(id)).conversationId);
    const attachments = await conversationRepository.listAttachmentsWithReplies(id);
    const deleted = await conversationRepository.deleteMessage(id);
    if (deleted) await removeMessageAttachmentFiles(attachments);
    return deleted;
  },

  /** Pose ou retire une réaction sur un message ; l'autrice (session) du message en est informée (écouteurs). */
  async toggleReaction(messageId: string, emoji: string, actor: MessageActor): Promise<{ reaction: MessageReaction; added: boolean }> {
    const message = await this.getMessage(messageId);
    const conversation = await this.get(message.conversationId);
    const result = await conversationRepository.toggleReaction({ conversationId: conversation.id, messageId }, normalizeEmoji(emoji), { type: actor.type, userId: actor.userId, sessionId: actor.sessionId, name: authorName(actor) });
    notifyChanged({ kind: 'reacted', conversation, message, reaction: result.reaction, added: result.added });
    return result;
  },
};

/** Première ligne d'un message, pour nommer son fil. */
export const threadTitle = (root: Pick<Message, 'body'>, max = 80): string => {
  const line = (root.body.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || '(sans texte)';
};

/**
 * Paragraphe du prompt système d'une session reliée à des fils de canaux (convoquée par une mention, mentionnée, ou
 * qui y a écrit) : elle en reçoit les messages suivants.
 */
export async function linkedThreadsPrompt(sessionId: string): Promise<string> {
  const threads = await conversationRepository.threadsOfSession(sessionId);
  if (!threads.length) return '';
  const channels = new Map<string, Conversation>();
  const lines: string[] = [];
  for (const root of threads.slice(0, 10)) {
    const c = channels.get(root.conversationId) ?? (await conversationRepository.findById(root.conversationId));
    if (!c) continue;
    channels.set(c.id, c);
    lines.push(`- « ${threadTitle(root)} » dans ${channelRef(c)} (fil ${root.id}, canal « ${c.slug} »)`);
  }
  return [
    `Cette session suit ${threads.length > 1 ? `${threads.length} fils de conversation` : 'un fil de conversation'} du projet (\`conversations.read\` avec \`thread\` pour relire un fil, \`conversations.post\` avec \`reply_to\` pour y répondre) :`,
    ...lines,
    ...(threads.length > 10 ? [`… et ${threads.length - 10} autres.`] : []),
  ].join('\n');
}

/** « 👍 2 (Alice, Bob) » */
export function summarizeMessageReactions(reactions: MessageReaction[]): string {
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.actorName]);
  return [...byEmoji].map(([emoji, names]) => `${emoji} ${names.length} (${names.join(', ')})`).join(' · ');
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
const readableMentions = (m: Message): string => (m.mentions.length ? ` (mentionne ${m.mentions.map((x) => (x.kind === 'session' ? `la session « ${x.label} » (${x.id})` : x.label)).join(', ')})` : '');

/** Un message tel que montré à un agent : auteur, date, identifiant (pour y répondre ou y réagir), mentions, texte, fichiers, réactions. */
export function describeMessage(m: Message, opts: { reactions?: MessageReaction[]; attachments?: MessageAttachment[]; files?: MessageFilesDelivery; indent?: string; replyTo?: Message | null } = {}): string[] {
  const pad = opts.indent ?? '';
  const head = `${pad}- ${m.authorName}${m.authorType === 'agent' ? ' (agent)' : ''}, ${fmtDate(m.createdAt)} UTC (message ${m.id}${opts.replyTo ? `, en réponse à ${opts.replyTo.authorName}` : ''})${readableMentions(m)} :`;
  const body = [m.body || '(pas de texte)'];
  const own = (opts.attachments ?? []).filter((a) => a.messageId === m.id);
  if (own.length) body.push(...describeMessageAttachments(own, opts.files));
  if (opts.reactions?.length) body.push(`Réactions : ${summarizeMessageReactions(opts.reactions)}`);
  return [head, ...body.join('\n').split('\n').map((l) => `${pad}  ${l}`)];
}

/** Des messages (racines dans l'ordre, réponses indentées sous chacune) pour un agent. */
export function describeMessages(messages: Message[], reactions: MessageReaction[] = [], files: { attachments?: MessageAttachment[]; delivery?: MessageFilesDelivery } = {}): string[] {
  const roots = messages.filter((m) => !m.parentId || !messages.some((p) => p.id === m.parentId));
  const lines: string[] = [];
  const common = { attachments: files.attachments, files: files.delivery };
  for (const root of roots) {
    lines.push(...describeMessage(root, { ...common, reactions: reactions.filter((r) => r.messageId === root.id) }));
    for (const reply of messages.filter((m) => m.parentId === root.id)) {
      lines.push(...describeMessage(reply, { ...common, reactions: reactions.filter((r) => r.messageId === reply.id), indent: '    ', replyTo: root }));
    }
  }
  return lines;
}
