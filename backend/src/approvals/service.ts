import { auditService } from '../audit/service.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { pubSub } from '../pubsub.js';
import { requestRepository } from '../requests/repository.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest } from '../requests/types.js';
import { sessionService } from '../sessions/service.js';
import { taskService } from '../tasks/service.js';
import type { TaskActor, TaskChange } from '../tasks/types.js';
import { userService } from '../users/service.js';
import type { User } from '../users/types.js';
import { ROLE_RANK } from '../users/types.js';

/**
 * Demandes d'accord officielles (type de demande `approval`) : une session d'agent demande l'accord d'un administrateur
 * du projet avant une action sensible (mise en production, configuration d'un serveur…), à propos d'une tâche.
 *
 * Contrairement aux demandes d'autorisation et aux questions, elle ne bloque pas le tour de l'agent : elle est posée,
 * l'agent termine son tour, et la réponse lui revient par le fil de la tâche (message de la personne qui a répondu,
 * qui mentionne la session : le fil la relance, ou reconvoque l'agent si sa session est rangée). Elle survit donc à
 * l'arrêt de la session et aux redémarrages du serveur (requests/repository.ts ne l'expire pas avec sa session).
 *
 * Quand la personne qui a demandé le travail à la session (ou qui la pilote) est elle-même administrateur du projet,
 * son accord est déjà donné : aucune demande n'est posée, l'accord implicite est tracé dans le fil et le journal.
 */
export const APPROVAL = 'approval';

export interface ApprovalPayload {
  taskId: string;
  taskTitle: string;
}

export type ApprovalDecision = 'approve' | 'deny';

export type ApprovalOutcome = { implicit: true; approver: User } | { implicit: false; request: HumanRequest };

const isAdmin = async (userId: string, projectId: string) => {
  const role = await userService.roleFor(userId, projectId);
  return role !== null && ROLE_RANK[role] >= ROLE_RANK.admin;
};

/**
 * La personne à l'origine du travail de la session : celle qui a pris la main, sinon celle qui l'a demandée à l'agent
 * (requested_by), sinon sa propriétaire quand c'est une personne. null pour une session lancée sans personne.
 */
export async function sessionRequester(session: { ownerId: string | null; requestedById: string | null; takenOverById: string | null }): Promise<User | null> {
  for (const id of [session.takenOverById, session.requestedById, session.ownerId]) {
    if (!id) continue;
    const user = await userService.get(id).catch(() => null);
    if (user?.kind === 'person') return user;
  }
  return null;
}

/** Administrateurs (personnes) du projet, destinataires de la notification. */
async function projectAdmins(projectId: string): Promise<User[]> {
  const members = await userService.members(projectId);
  const users = await Promise.all(members.filter((m) => m.role === 'admin').map((m) => userService.get(m.userId).catch(() => null)));
  return users.filter((u): u is User => u?.kind === 'person');
}

const payloadOf = (request: HumanRequest): ApprovalPayload | null => {
  const p = request.payload as Partial<ApprovalPayload>;
  return request.type === APPROVAL && typeof p.taskId === 'string' ? { taskId: p.taskId, taskTitle: p.taskTitle ?? '' } : null;
};

const sessionLink = (sessionId: string) => `${config.appUrl}/sessions/${sessionId}`;

export const approvalService = {
  /**
   * Demande l'accord d'un administrateur du projet pour `action` (ce que l'agent va faire), à propos de la tâche
   * `taskId`. Accord implicite si la personne à l'origine de la session est administrateur ; sinon une demande
   * officielle est posée (une seule en attente par session et par tâche : la précédente est remplacée).
   */
  async request(input: { projectId: string; sessionId: string; taskId: string; action: string; details?: string | null; actor: TaskActor }): Promise<ApprovalOutcome> {
    const action = input.action.trim();
    if (!action) throw new AppError("Décris l'action pour laquelle tu demandes l'accord");
    const task = await taskService.get(input.taskId);
    if (task.projectId !== input.projectId) throw new AppError('Tâche introuvable dans ce projet');
    const session = await sessionService.get(input.sessionId);
    if (!session) throw new AppError('Session introuvable');

    const requester = await sessionRequester(session);
    if (requester && (await isAdmin(requester.id, input.projectId))) {
      await taskService.addComment(task.id, `✅ Accord implicite pour **${action}** : ${requester.name || requester.email}, administrateur du projet, a demandé ce travail à la session.`, input.actor);
      await auditService.record({
        projectId: input.projectId,
        actor: { sessionId: input.sessionId },
        action: 'approval.implicit',
        targetType: 'task',
        targetId: task.id,
        targetLabel: task.title,
        details: { action, approvedBy: requester.id },
      });
      return { implicit: true, approver: requester };
    }

    // Une nouvelle demande remplace celle que la session attendait encore pour la même tâche.
    const pending = await requestRepository.list({ sessionId: input.sessionId, status: 'pending', limit: 500 });
    for (const old of pending.filter((r) => payloadOf(r)?.taskId === task.id)) await requestService.cancel(old.id).catch(() => undefined);

    const request = await requestRepository.create(input.sessionId, {
      type: APPROVAL,
      title: action,
      message: input.details?.trim() || null,
      payload: { taskId: task.id, taskTitle: task.title } satisfies ApprovalPayload,
    });
    pubSub.publish('requestCreated', request);
    const admins = await projectAdmins(input.projectId);
    const notification = {
      type: 'request.created',
      title: `« ${session.name} » demande votre accord`,
      message: action,
      link: `/sessions/${session.id}`,
      projectId: input.projectId,
      sessionId: session.id,
      payload: { requestType: APPROVAL, requestId: request.id, taskId: task.id },
    };
    // Sans administrateur identifié (projet sans membre admin), la notification va à tout le projet.
    if (admins.length) await Promise.all(admins.map((a) => notificationService.notify({ ...notification, userId: a.id })));
    else await notificationService.notify(notification);
    await taskService.addComment(
      task.id,
      [
        `🔐 Demande d'accord officielle : **${action}**.`,
        input.details?.trim() ? `\n${input.details.trim()}\n` : '',
        `Un administrateur du projet l'accorde ou la refuse depuis les demandes (cloche, page Demandes, ou la session : ${sessionLink(session.id)}). Je ne fais rien avant.`,
      ]
        .filter(Boolean)
        .join('\n'),
      input.actor,
    );
    return { implicit: false, request };
  },

  /**
   * Réponse d'une personne à une demande d'accord : réservée aux administrateurs du projet (vérifié par l'appelant
   * pour l'accès, ici pour le rôle). La décision est postée dans le fil de la tâche au nom de la personne, avec une
   * mention de la session qui l'a demandée : c'est ce message qui la relance.
   */
  async answer(id: string, response: Record<string, unknown>, user: User): Promise<HumanRequest> {
    const current = await requestService.get(id);
    const payload = payloadOf(current);
    if (!payload) throw new AppError("Ce n'est pas une demande d'accord");
    const decision = response.decision;
    if (decision !== 'approve' && decision !== 'deny') throw new AppError('Réponse attendue : decision approve ou deny');
    const projectId = await projectOfSession(current.sessionId);
    if (!(await isAdmin(user.id, projectId))) throw new AppError("Seul un administrateur du projet peut répondre à une demande d'accord", 'FORBIDDEN');
    const message = typeof response.message === 'string' ? response.message.trim() : '';
    const request = await requestService.answer(id, { decision, ...(message ? { message } : {}) }, user.id);
    await postDecision(request, payload, user, decision === 'approve' ? 'approved' : 'denied', message);
    return request;
  },

  /** Demande écartée (« Ignorer cette demande ») : l'agent en est prévenu par le fil, comme d'un refus sans motif. */
  async cancel(id: string, user: User): Promise<HumanRequest> {
    const current = await requestService.get(id);
    const payload = payloadOf(current);
    if (!payload) throw new AppError("Ce n'est pas une demande d'accord");
    const projectId = await projectOfSession(current.sessionId);
    if (!(await isAdmin(user.id, projectId))) throw new AppError("Seul un administrateur du projet peut écarter une demande d'accord", 'FORBIDDEN');
    const request = await requestService.cancel(id, user.id);
    if (request.status === 'cancelled' && request.answeredById === user.id) await postDecision(request, payload, user, 'dismissed', '');
    return request;
  },

  /** La tâche est terminée ou annulée : ses demandes d'accord encore en attente n'ont plus d'objet. */
  async cancelForTask(taskId: string): Promise<number> {
    const pending = await requestRepository.pendingApprovalsForTask(taskId);
    for (const r of pending) await requestService.cancel(r.id).catch(() => undefined);
    return pending.length;
  },
};

async function projectOfSession(sessionId: string): Promise<string> {
  const session = await sessionService.get(sessionId);
  if (!session) throw new AppError('Session introuvable');
  return session.projectId;
}

async function postDecision(request: HumanRequest, payload: ApprovalPayload, user: User, outcome: 'approved' | 'denied' | 'dismissed', message: string): Promise<void> {
  const head =
    outcome === 'approved'
      ? `✅ J'accorde : **${request.title}**. @session:${request.sessionId} tu peux y aller.`
      : outcome === 'denied'
        ? `❌ Je refuse : **${request.title}**. @session:${request.sessionId} ne le fais pas.`
        : `Demande d'accord écartée sans suite : **${request.title}**. @session:${request.sessionId} ne le fais pas.`;
  try {
    await taskService.addComment(payload.taskId, message ? `${head}\n\n${message}` : head, { type: 'human', userId: user.id, name: user.name || user.email });
  } catch (err) {
    log.warn(`[approvals] décision non postée dans la tâche ${payload.taskId} : ${(err as Error).message}`);
  }
}

/** Branche l'annulation des demandes d'accord d'une tâche fermée (au démarrage du serveur). */
export function registerApprovalTaskListener(): void {
  taskService.onTaskChanged('approvals', async (change: TaskChange) => {
    if (change.kind !== 'updated' || change.before.status === change.task.status) return;
    if (change.task.status !== 'done' && change.task.status !== 'cancelled') return;
    await approvalService.cancelForTask(change.task.id).catch((err) => log.warn(`[approvals] tâche ${change.task.id} : ${(err as Error).message}`));
  });
}
