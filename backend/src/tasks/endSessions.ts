import { log } from '../log.js';
import { sessionService } from '../sessions/service.js';
import { taskRepository } from './repository.js';
import { taskService } from './service.js';
import type { TaskChange } from './types.js';

const closed = (status: string) => status === 'done' || status === 'cancelled';

/**
 * Fin des sessions d'une tâche terminée : quand une tâche passe à « terminée » (ou « annulée »), chaque session en charge
 * qui ne l'est d'aucune autre tâche ouverte se termine, sans attendre le délai d'inactivité du serveur. Inactive, tout de
 * suite ; au travail, à la fin de son tour (`sessionService.endForTask`). Sa conversation est conservée : un message
 * (fil de la tâche, mention, instruction) la relance.
 */
export async function endSessionsOfClosedTask(change: TaskChange): Promise<void> {
  if (change.kind !== 'updated') return;
  const { before, task } = change;
  if (closed(before.status) || !closed(task.status) || !task.sessionIds.length) return;
  const notice = `La tâche « ${task.title} » est ${task.status === 'done' ? 'terminée' : 'annulée'} : session terminée pour libérer sa place et sa mémoire. Envoyez un message pour la reprendre.`;
  for (const sessionId of task.sessionIds) {
    try {
      const others = await taskRepository.listForSession(sessionId);
      if (others.some((t) => t.id !== task.id && t.sessionIds.includes(sessionId) && !closed(t.status))) continue;
      const outcome = await sessionService.endForTask(sessionId, notice);
      if (outcome !== 'none') log.info(`[tasks] tâche ${task.id} ${task.status} : session ${sessionId} ${outcome === 'ended' ? 'terminée' : 'terminée à la fin de son tour'}`);
    } catch (err) {
      log.warn(`[tasks] fin de la session ${sessionId} (tâche ${task.id} terminée) : ${(err as Error).message}`);
    }
  }
}

/** Branche la fin des sessions sur le service des tâches (au démarrage du serveur). */
export function registerTaskSessionEnd(): void {
  taskService.onTaskChanged('end-sessions', endSessionsOfClosedTask);
}
