import { agentService } from '../agents/service.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { sessionRepository } from '../sessions/repository.js';
import type { Session } from '../sessions/types.js';
import { ACTIVE_SESSION_STATUSES, taskRepository } from './repository.js';
import { formatWakeAt } from './service.js';
import type { Task } from './types.js';

/**
 * Réveil des tâches mises en attente (`tasks.wake_at`, posé par `tasks.update` avec `wake_at`) : quand la date est
 * passée, l'agent qui tenait la tâche (propriétaire de la dernière session en charge) est reconvoqué sur la tâche avec
 * ce qu'il devait vérifier ; une session pilotée par une personne n'est pas relancée d'office (elle consommerait son
 * compte sans qu'elle l'ait demandé) : la personne est prévenue, et la tâche revient dans « À traiter » d'elle-même
 * (`ATTENTION_JOIN` : réveil passé = agent arrêté). Chaque date posée n'est traitée qu'une fois (`woken_at`).
 * Tâche périodique de l'instance meneuse (instances/leadership.ts).
 */

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** Consigne de l'agent réveillé : se suffit à elle-même (la session peut repartir de zéro). */
export function wakeInstruction(task: Pick<Task, 'id' | 'title' | 'wakeAt' | 'wakeNote'>): string {
  return [
    `[Réveil] Tu avais mis la tâche « ${task.title} » (${task.id}) en attente jusqu'au ${task.wakeAt ? formatWakeAt(task.wakeAt) : '?'}. C'est l'heure de reprendre.`,
    task.wakeNote ? `À vérifier : ${task.wakeNote}` : 'Relis le fil de la tâche (`tasks.get`) pour retrouver ce que tu attendais.',
    "Fais la vérification, rends compte dans le fil de la tâche, puis passe-la à `done` si c'est fini, ou pose une nouvelle date de réveil (`tasks.update` avec `wake_at` et `wake_note`) s'il faut encore attendre, ou rends-la (`tasks.release`) en expliquant ce qui reste. Sans l'un des trois, elle est signalée « agent arrêté » à l'équipe.",
  ].join('\n\n');
}

/** Session de référence d'une tâche : la plus récente des sessions en charge (null : aucune). */
async function lastInCharge(task: Task): Promise<{ sessions: Session[]; last: Session | null }> {
  const sessions = (await Promise.all(task.sessionIds.map((id) => sessionRepository.findById(id)))).filter((s): s is Session => s !== null);
  return { sessions, last: sessions[0] ?? null };
}

/** Réveille une tâche (date déjà marquée traitée par `claimDueWakes`). Renvoie ce qui a été fait, pour les journaux et les tests. */
export async function wakeTask(taskId: string): Promise<'summoned' | 'notified' | 'skipped'> {
  const task = await taskRepository.findById(taskId);
  if (!task || task.status !== 'in_progress' || !task.wakeAt) return 'skipped';
  const { sessions, last } = await lastInCharge(task);
  // Un agent y travaille déjà : il a la main, le réveil n'a plus d'objet.
  if (sessions.some((s) => (ACTIVE_SESSION_STATUSES as readonly string[]).includes(s.status))) return 'skipped';
  const project = await projectService.get(task.projectId);
  const agent = await agentService.forUser(last?.ownerId).catch(() => null);
  if (agent && !agent.archivedAt && agent.enabled) {
    try {
      // Personne ne pilote la session ouverte pour l'occasion : elle se range seule à la fin de son tour.
      const session = await agentService.summon(agent.id, { taskId: task.id, text: wakeInstruction(task), actor: { type: 'human' }, autoArchive: true });
      log.info(`[tasks] réveil de la tâche ${task.id} : ${agent.name} reconvoqué (session ${session.id})`);
      await notificationService.notify({
        type: 'task.woken',
        title: `Tâche « ${task.title} » : réveil, ${agent.name} reprend`,
        message: `${task.wakeNote ? `À vérifier : ${task.wakeNote.slice(0, 160)} · ` : ''}${project.name}`,
        link: `/sessions/${session.id}`,
        projectId: task.projectId,
        sessionId: session.id,
        payload: { taskId: task.id },
      });
      return 'summoned';
    } catch (err) {
      log.warn(`[tasks] réveil de la tâche ${task.id} : ${agent.name} non reconvoqué : ${(err as Error).message}`);
    }
  }
  await notificationService.notify({
    type: 'task.wake_due',
    title: `Tâche « ${task.title} » : à vérifier`,
    message: `Réveil prévu le ${formatWakeAt(task.wakeAt)}${task.wakeNote ? ` · ${task.wakeNote.slice(0, 160)}` : ''} · ${project.name}`,
    link: `/tasks/${task.id}`,
    projectId: task.projectId,
    // Session d'une personne : c'est elle qui la reprend ; sinon (agent en pause, retiré, convocation impossible) l'équipe.
    userId: agent ? null : (last?.ownerId ?? null),
    sessionId: last?.id ?? null,
    payload: { taskId: task.id },
  });
  log.info(`[tasks] réveil de la tâche ${task.id} : à vérifier par une personne`);
  return 'notified';
}

/** Un passage : tous les réveils échus. */
export async function wakeDueTasks(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    let n = 0;
    for (;;) {
      const ids = await taskRepository.claimDueWakes();
      for (const id of ids) {
        await wakeTask(id).catch((err) => log.error(`[tasks] réveil de la tâche ${id}`, err));
        n++;
      }
      if (ids.length < 20) return n;
    }
  } finally {
    running = false;
  }
}

export const taskWaker = {
  start(): void {
    timer ??= setInterval(() => void wakeDueTasks().catch((err) => log.error('[tasks] réveils', err)), INTERVAL_MS);
    void wakeDueTasks().catch((err) => log.error('[tasks] réveils', err));
  },
  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
