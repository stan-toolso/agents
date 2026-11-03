import { log } from '../log.js';
import { pubSub } from '../pubsub.js';
import { sessionRepository } from './repository.js';

/**
 * Journalise un événement dans le transcript d'une session et le publie aussitôt (subscription des événements).
 * Pour les modules qui rendent compte d'un effet d'un outil (tâches, contexte) sans passer par le provider.
 */
export async function emitSessionEvent(sessionId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const event = await sessionRepository.addEvent(sessionId, type, payload);
  pubSub.publish('sessionEvent', sessionId, event);
}

/** Comme `emitSessionEvent`, sans jamais faire échouer l'appelant : la trace dans le transcript est accessoire. */
export function traceSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  return emitSessionEvent(sessionId, type, payload).catch((err) => log.error(`[sessions] événement ${type} de la session ${sessionId}`, err));
}
