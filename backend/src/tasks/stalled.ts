import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { sessionService, type SessionEnd } from '../sessions/service.js';
import type { SessionStatus } from '../sessions/types.js';
import { taskService } from './service.js';

const ENDED: Partial<Record<SessionStatus, string>> = { completed: 'terminée', stopped: 'arrêtée', failed: 'en erreur' };

/**
 * « Agent arrêté » : quand le processus d'une session se termine alors qu'elle avait la charge de tâches en cours, et
 * qu'aucune autre session en charge ne tourne (ni pull request ouverte : `Task.stalledSince`), les membres du projet
 * reçoivent `task.stalled` avec le lien de la session. Les fins silencieuses (inactivité, archivage, remise à zéro,
 * prise en main) ne notifient pas : la tâche apparaît quand même dans « À traiter » et sur le tableau des tâches.
 */
export async function notifyStalledTasks({ session, quiet }: SessionEnd): Promise<number> {
  if (quiet || session.kind !== 'session') return 0;
  const how = ENDED[session.status];
  if (!how) return 0;
  const stalled = (await taskService.tasksInCharge(session.id)).filter((t) => t.status === 'in_progress' && t.stalledSince !== null);
  if (!stalled.length) return 0;
  const project = await projectService.get(session.projectId);
  for (const task of stalled) {
    await notificationService.notify({
      type: 'task.stalled',
      title: `Tâche « ${task.title} » : l'agent s'est arrêté`,
      message: `Session « ${session.name} » ${how} sans terminer la tâche · ${project.name}${session.status === 'failed' && session.error ? ` · ${session.error.slice(0, 160)}` : ''}`,
      link: `/sessions/${session.id}`,
      projectId: task.projectId,
      sessionId: session.id,
      payload: { taskId: task.id },
    });
  }
  log.info(`[tasks] session ${session.id} ${session.status} : ${stalled.length} tâche(s) en cours sans agent (${stalled.map((t) => t.id).join(', ')})`);
  return stalled.length;
}

/** Branche la détection sur la fin des sessions (au démarrage du serveur). */
export function registerStalledTasks(): void {
  sessionService.onEnded('stalled-tasks', async (end) => void (await notifyStalledTasks(end)));
}
