import { agentService } from '../agents/service.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { autoArchiveConfig } from '../sessions/autoArchive.js';
import { startTaskSession } from './launch.js';
import { taskRepository } from './repository.js';
import { taskService } from './service.js';
import type { Task, TaskChange } from './types.js';

/**
 * Enchaînement des tâches : quand une tâche passe à « terminée », celles qui dépendent d'elle, à faire, dont c'était la
 * dernière dépendance non terminée et qui ont l'option « lancer automatiquement quand débloquée », sont confiées à une
 * session avec la configuration par défaut du projet (ou celle de l'agent qui a armé l'option), au nom de qui l'a
 * armée. L'option est consommée (une seule session même si deux dépendances se terminent en même temps). Une
 * notification dit ce qui a été lancé, ou pourquoi le lancement a échoué.
 */
export async function startUnblockedDependents(change: TaskChange): Promise<void> {
  if (change.kind !== 'updated') return;
  const { before, task } = change;
  if (before.status === 'done' || task.status !== 'done' || !task.dependentIds.length) return;
  for (const dependent of await taskRepository.findByIds(task.dependentIds)) {
    if (dependent.blockedByIds.length || !dependent.autoStartWhenUnblocked || dependent.status !== 'todo') continue;
    await launchUnblocked(dependent, task);
  }
}

/** Lance la session d'une tâche débloquée par `cause` (option consommée d'abord) et le notifie. */
export async function launchUnblocked(task: Task, cause: Task): Promise<void> {
  const { armed, byId } = await taskRepository.consumeAutoStart(task.id);
  if (!armed) return;
  const project = await projectService.get(task.projectId);
  const agent = await agentService.forUser(byId).catch(() => null);
  const base = { projectId: task.projectId, link: `/tasks/${task.id}`, userId: agent ? null : byId, payload: { taskId: task.id, causeTaskId: cause.id } };
  try {
    if (!byId) throw new AppError("la personne qui avait armé le lancement automatique n'existe plus");
    let session;
    if (agent) {
      if (agent.archivedAt) throw new AppError(`l'agent ${agent.name} a été retiré du projet`);
      if (!agent.enabled) throw new AppError(`l'agent ${agent.name} est en pause`);
      session = await startTaskSession(task.id, { ownerId: agent.id, provider: agentService.providerOf(agent), config: agentService.sessionConfig(agent, autoArchiveConfig()) });
    } else {
      session = await startTaskSession(task.id, { ownerId: byId });
    }
    log.info(`[tasks] tâche ${task.id} débloquée par ${cause.id} : session ${session.id} lancée`);
    await notificationService.notify({
      ...base,
      type: 'task.unblocked',
      title: 'Tâche débloquée : session lancée',
      message: `${task.title} · « ${cause.title} » est terminée${agent ? ` · confiée à ${agent.name}` : ''} · ${project.name}`,
      link: `/sessions/${session.id}`,
      sessionId: session.id,
      payload: { ...base.payload, sessionId: session.id },
    });
  } catch (err) {
    log.warn(`[tasks] lancement automatique de la tâche ${task.id} échoué : ${(err as Error).message}`);
    await notificationService.notify({
      ...base,
      type: 'task.autostart_failed',
      title: 'Tâche débloquée : lancement automatique impossible',
      message: `${task.title} : ${(err as Error).message} · ${project.name}`,
    });
  }
}

/** Branche l'enchaînement sur le service des tâches (au démarrage du serveur). */
export function registerTaskAutoStart(): void {
  taskService.onTaskChanged('auto-start', startUnblockedDependents);
}
