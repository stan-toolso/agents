import { AppError, NotFoundError } from '../errors.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import type { User } from '../users/types.js';
import { sharedPageCommentRepository } from './commentRepository.js';
import { sharedPageService } from './service.js';
import type { CommentAnchor, SharedPage, SharedPageComment } from './types.js';

/** Bornes des champs d'un commentaire ; au-delà, l'ancre venue de la page est tronquée, le texte refusé. */
export const COMMENT_LIMITS = { body: 10_000, selector: 500, text: 200, tag: 40 };

/** Qui agit : une personne, ou une session d'agent au nom de son propriétaire. */
export interface CommentActor {
  user: User;
  sessionId?: string | null;
}

function cleanBody(raw: string): string {
  const body = raw.replace(/\r\n/g, '\n').trim();
  if (!body) throw new AppError('Le commentaire est vide');
  if (body.length > COMMENT_LIMITS.body) throw new AppError(`Le commentaire dépasse ${COMMENT_LIMITS.body} caractères`);
  return body;
}

/**
 * Ancre envoyée par la page (données non fiables : la page est du HTML publié par un agent) : on ne garde que
 * les trois champs attendus, en chaînes bornées. Null quand il n'y a pas de sélecteur.
 */
export function cleanAnchor(raw: unknown): CommentAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const selector = typeof a.selector === 'string' ? a.selector.replace(/\s+/g, ' ').trim().slice(0, COMMENT_LIMITS.selector) : '';
  if (!selector) return null;
  const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim().slice(0, COMMENT_LIMITS.text) : '';
  const tag = typeof a.tag === 'string' ? a.tag.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, COMMENT_LIMITS.tag) : '';
  return { selector, text: text || null, tag: tag || null };
}

/** Résumé d'un commentaire pour une notification : première ligne, bornée. */
const excerpt = (body: string) => {
  const line = body.split('\n')[0].trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

export const sharedPageCommentService = {
  async get(id: string): Promise<SharedPageComment> {
    const comment = await sharedPageCommentRepository.findById(id);
    if (!comment) throw new NotFoundError('Commentaire introuvable');
    return comment;
  },

  /** Le commentaire et sa page, visibles par la personne ; sinon « introuvable ». */
  async getFor(userId: string, id: string): Promise<{ comment: SharedPageComment; page: SharedPage }> {
    const comment = await this.get(id);
    const page = await sharedPageService.getFor(userId, comment.pageId).catch(() => {
      throw new NotFoundError('Commentaire introuvable');
    });
    return { comment, page };
  },

  /** Commentaires racines d'une page (les réponses sont rattachées par `replies`). */
  async roots(pageId: string): Promise<SharedPageComment[]> {
    return (await sharedPageCommentRepository.listOfPage(pageId)).filter((c) => !c.parentId);
  },

  replies: (parentId: string) => sharedPageCommentRepository.replies(parentId),
  countOpen: (pageId: string) => sharedPageCommentRepository.countOpen(pageId),

  /** Nouveau commentaire racine, général ou ancré, par quiconque voit la page. */
  async add(actor: CommentActor, pageId: string, input: { body: string; anchor?: unknown; version?: number | null }): Promise<SharedPageComment> {
    const page = await sharedPageService.getFor(actor.user.id, pageId);
    const body = cleanBody(input.body);
    const version = input.version ?? page.version;
    if (!Number.isInteger(version) || version < 1 || version > page.version) throw new AppError('Version de la page inconnue');
    const comment = await sharedPageCommentRepository.create({ pageId: page.id, parentId: null, authorId: actor.user.id, sessionId: actor.sessionId ?? null, body, anchor: cleanAnchor(input.anchor), version });
    this.notify(page, comment, [page.ownerId], actor.user, `${actor.user.name} a commenté « ${page.title} »`);
    this.forward(page, comment, actor, 'comment');
    return comment;
  },

  /** Réponse dans la micro-conversation d'un commentaire racine. */
  async reply(actor: CommentActor, commentId: string, body: string): Promise<SharedPageComment> {
    const { comment: root, page } = await this.getFor(actor.user.id, commentId);
    if (root.parentId) throw new AppError('On répond au commentaire, pas à une réponse');
    const replies = await sharedPageCommentRepository.replies(root.id);
    const reply = await sharedPageCommentRepository.create({ pageId: page.id, parentId: root.id, authorId: actor.user.id, sessionId: actor.sessionId ?? null, body: cleanBody(body), anchor: null, version: root.version });
    this.notify(page, root, [page.ownerId, root.authorId, ...replies.map((r) => r.authorId)], actor.user, `${actor.user.name} a répondu à un commentaire sur « ${page.title} »`, reply.body);
    this.forward(page, root, actor, 'reply');
    return reply;
  },

  /** Seul l'auteur modifie le texte de son commentaire ou de sa réponse. */
  async update(actor: CommentActor, id: string, body: string): Promise<SharedPageComment> {
    const { comment } = await this.getFor(actor.user.id, id);
    if (comment.authorId !== actor.user.id) throw new AppError("Seul l'auteur modifie son commentaire", 'FORBIDDEN');
    return (await sharedPageCommentRepository.updateBody(id, cleanBody(body))) ?? comment;
  },

  /** Traité ou rouvert : par quiconque voit la page (comme dans un document partagé). */
  async resolve(actor: CommentActor, id: string, resolved: boolean): Promise<SharedPageComment> {
    const { comment } = await this.getFor(actor.user.id, id);
    if (comment.parentId) throw new AppError("C'est le commentaire qui se traite, pas une réponse");
    if (Boolean(comment.resolvedAt) === resolved) return comment;
    return (await sharedPageCommentRepository.setResolved(id, resolved ? actor.user.id : null)) ?? comment;
  },

  /** L'auteur, ou le propriétaire de la page, supprime un commentaire (avec ses réponses) ou une réponse. */
  async delete(actor: CommentActor, id: string): Promise<boolean> {
    const { comment, page } = await this.getFor(actor.user.id, id);
    if (comment.authorId !== actor.user.id && page.ownerId !== actor.user.id) throw new AppError("Seuls l'auteur et le propriétaire de la page suppriment un commentaire", 'FORBIDDEN');
    return sharedPageCommentRepository.delete(id);
  },

  /**
   * Page réglée sur la transmission automatique : le fil du commentaire part à la session d'origine de la page, en
   * tâche de fond. Pas pour ce qu'écrit une session (ses réponses lui reviendraient). Import différé : le module de
   * transmission dépend de celui-ci.
   */
  forward(page: SharedPage, root: SharedPageComment, actor: CommentActor, trigger: 'comment' | 'reply'): void {
    if (page.agentHandoff !== 'auto' || !page.sessionId || actor.sessionId) return;
    void import('./updateRequest.js')
      .then(({ sharedPageUpdateService }) => sharedPageUpdateService.forward(page, root, actor.user, trigger))
      .catch((err) => log.warn(`[pages] transmission automatique du commentaire ${root.id} : ${(err as Error).message}`));
  },

  /** Prévient les personnes concernées (sans doublon, jamais l'auteur de l'action). */
  notify(page: SharedPage, root: SharedPageComment, userIds: string[], actor: User, title: string, body = root.body): void {
    const link = `/shared/${page.id}?comment=${root.id}`;
    for (const userId of new Set(userIds)) {
      if (userId === actor.id) continue;
      void notificationService.notify({ type: 'page.commented', title, message: excerpt(body), link, userId, payload: { pageId: page.id, commentId: root.id } });
    }
  },
};
