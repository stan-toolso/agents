import { AppError, NotFoundError } from '../errors.js';
import { pubSub } from '../pubsub.js';
import { notificationService } from '../notifications/service.js';
import { userRepository } from '../users/repository.js';
import { requestRepository } from './repository.js';
import type { CreateRequestInput, HumanRequest, RequestStatus } from './types.js';

export class RequestCancelledError extends Error {
  constructor(readonly request: HumanRequest) {
    super(`Demande ${request.id} ${request.status}`);
    this.name = 'RequestCancelledError';
  }
}

interface Waiter {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/** Clé ajoutée à la réponse remise à l'agent qui attend : identifiant de la personne qui a répondu. */
export const ANSWERED_BY = 'answeredById';

/** Code de l'erreur renvoyée quand on répond à une demande déjà réglée autrement : l'interface la tait et rafraîchit. */
export const REQUEST_SETTLED = 'REQUEST_SETTLED';

/** Sérialisation stable (clés triées) pour comparer deux réponses. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const sameResponse = (a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean => canonical(a ?? {}) === canonical(b ?? {});

const settledLabels: Record<string, string> = { answered: 'traitée', cancelled: 'ignorée', expired: 'expirée' };

async function settledError(request: HumanRequest): Promise<AppError> {
  const by = request.answeredById ? await userRepository.findById(request.answeredById).catch(() => null) : null;
  const who = by ? ` par ${by.name || by.email}` : '';
  return new AppError(`Cette demande a déjà été ${settledLabels[request.status] ?? request.status}${who}`, REQUEST_SETTLED);
}

/** Promesses en attente d'une réponse humaine, indexées par id de demande (mémoire du serveur). */
const waiters = new Map<string, Waiter>();

function settleWaiter(request: HumanRequest): void {
  const waiter = waiters.get(request.id);
  if (!waiter) return;
  waiters.delete(request.id);
  // La personne qui a répondu accompagne la réponse (`answeredById`) : un outil peut agir avec son compte (fusion d'une PR).
  if (request.status === 'answered') waiter.resolve({ ...(request.response ?? {}), ...(request.answeredById ? { [ANSWERED_BY]: request.answeredById } : {}) });
  else waiter.reject(new RequestCancelledError(request));
}

export const requestService = {
  list: (filter?: { sessionId?: string; projectIds?: string[]; status?: RequestStatus; limit?: number; newestFirst?: boolean }) => requestRepository.list(filter),
  countPending: (sessionId: string) => requestRepository.countPending(sessionId),

  async get(id: string): Promise<HumanRequest> {
    const request = await requestRepository.findById(id);
    if (!request) throw new NotFoundError('Demande introuvable');
    return request;
  },

  /**
   * Crée une demande et attend la réponse humaine. Rejette avec RequestCancelledError
   * si la demande est annulée (arrêt de la session, abandon explicite) ou si `signal` est déclenché.
   * `onCreated` reçoit la demande une fois enregistrée (pour la notifier avec son identifiant).
   */
  async ask(sessionId: string, input: CreateRequestInput, signal?: AbortSignal, onCreated?: (request: HumanRequest) => void): Promise<Record<string, unknown>> {
    const request = await requestRepository.create(sessionId, input);
    pubSub.publish('requestCreated', request);
    onCreated?.(request);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(request.id, { resolve, reject });
      signal?.addEventListener('abort', () => void this.cancel(request.id).catch(() => undefined), { once: true });
    });
  },

  /**
   * Répond à une demande. Idempotent : une demande déjà réglée avec la même réponse (double clic, Entrée répété,
   * même demande affichée dans deux onglets) est renvoyée telle quelle ; une réponse différente, ou une demande
   * ignorée ou expirée, donne une erreur explicite (code REQUEST_SETTLED).
   */
  async answer(id: string, response: Record<string, unknown>, answeredBy: string | null = null): Promise<HumanRequest> {
    return (await this.answerOnce(id, response, answeredBy)).request;
  },

  /** Comme `answer`, en disant si c'est cet appel qui a réglé la demande (`settled`) ou s'il en était le doublon. */
  async answerOnce(id: string, response: Record<string, unknown>, answeredBy: string | null = null): Promise<{ request: HumanRequest; settled: boolean }> {
    const request = await requestRepository.settle(id, 'answered', response, answeredBy);
    if (!request) {
      const existing = await this.get(id);
      if (existing.status === 'answered' && sameResponse(existing.response, response)) return { request: existing, settled: false };
      throw await settledError(existing);
    }
    pubSub.publish('requestUpdated', request);
    settleWaiter(request);
    void notificationService.markReadForRequests([request.id]);
    return { request, settled: true };
  },

  async cancel(id: string, cancelledBy: string | null = null): Promise<HumanRequest> {
    return (await this.cancelOnce(id, cancelledBy)).request;
  },

  /** Comme `cancel`, en disant si c'est cet appel qui a réglé la demande (`settled`). Une demande déjà réglée est renvoyée telle quelle. */
  async cancelOnce(id: string, cancelledBy: string | null = null): Promise<{ request: HumanRequest; settled: boolean }> {
    const request = await requestRepository.settle(id, 'cancelled', null, cancelledBy);
    if (!request) return { request: await this.get(id), settled: false };
    pubSub.publish('requestUpdated', request);
    settleWaiter(request);
    void notificationService.markReadForRequests([request.id]);
    return { request, settled: true };
  },

  /** Annule toutes les demandes en attente d'une session (arrêt, fin de processus). */
  async cancelAllForSession(sessionId: string, status: 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
    const requests = await requestRepository.settleAllPending(sessionId, status);
    for (const request of requests) {
      pubSub.publish('requestUpdated', request);
      settleWaiter(request);
    }
    void notificationService.markReadForRequests(requests.map((r) => r.id));
  },

  /**
   * Demande réglée sur une autre instance du backend (bus entre instances) : si l'agent qui l'attend tourne ici,
   * il reçoit la réponse (ou l'annulation).
   */
  settleLocalWaiter(request: HumanRequest): void {
    if (request.status !== 'pending') settleWaiter(request);
  },

  /**
   * Au démarrage : expire les demandes en attente qu'aucun processus ne consommera plus (leur session n'est pas tenue
   * par une instance vivante, `liveInstanceIds`) et marque lues leurs notifications.
   */
  async expireAllPending(liveInstanceIds: string[] = []): Promise<number> {
    const n = await requestRepository.expireAllPending(liveInstanceIds);
    await notificationService.markReadForSettledRequests();
    return n;
  },
};
