import { AppError, NotFoundError } from '../errors.js';
import { log } from '../log.js';
import { taskService } from '../tasks/service.js';
import type { Task, TaskChange } from '../tasks/types.js';
import { DEFAULT_QUALITY_TAGS, DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS, backfillPlan, cleanQualityTags, isQualityTask, pickDelivery, regressionStats, type RegressionStats } from './quality.js';
import { deliveryQualityRepository as repo, type DeliveryTaskLink } from './qualityRepository.js';
import { deliveryRepository } from './repository.js';

/**
 * Tâches « qualité » rattachées aux livraisons (besoin du projet Curso : mesurer les régressions introduites par les
 * agents). Règles pures dans quality.ts ; ici, le branchement : création et changement d'étiquettes d'une tâche,
 * rattrapage d'un projet, correction manuelle, et relevé des taux de régression. Voir dev/livraisons.
 */

export interface QualitySettings {
  tags: string[];
  windowHours: number;
  /** Réglages propres au projet (sinon : défaut). */
  custom: boolean;
  updatedById: string | null;
  updatedAt: Date | null;
}

export interface QualityReport extends RegressionStats {
  since: Date;
  settings: QualitySettings;
}

const ms = (h: number) => h * 3_600_000;

export const deliveryQualityService = {
  async settings(projectId: string): Promise<QualitySettings> {
    const s = await repo.settings(projectId);
    return s
      ? { tags: s.tags, windowHours: s.windowHours, custom: true, updatedById: s.updatedById, updatedAt: s.updatedAt }
      : { tags: [...DEFAULT_QUALITY_TAGS], windowHours: DEFAULT_WINDOW_HOURS, custom: false, updatedById: null, updatedAt: null };
  },

  /** Règle les étiquettes et la fenêtre du projet (null : défaut), puis recalcule les rattachements automatiques. */
  async setSettings(projectId: string, input: { tags?: string[] | null; windowHours?: number | null } | null, userId: string): Promise<QualitySettings> {
    if (input) {
      const windowHours = input.windowHours ?? DEFAULT_WINDOW_HOURS;
      if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > MAX_WINDOW_HOURS) throw new AppError(`Fenêtre entre 1 et ${MAX_WINDOW_HOURS} heures`);
      await repo.setSettings(projectId, { tags: cleanQualityTags(input.tags), windowHours }, userId);
    } else {
      await repo.setSettings(projectId, null, userId);
    }
    await this.backfill(projectId);
    return this.settings(projectId);
  },

  /**
   * Calcule le rattachement automatique d'une tâche (création, étiquettes changées) ; un rattachement manuel est
   * laissé tel quel. Renvoie la livraison retenue (null : aucune).
   */
  async evaluate(task: Pick<Task, 'id' | 'projectId' | 'tags' | 'createdAt'>): Promise<string | null> {
    const current = await repo.linkOf(task.id);
    if (current?.source === 'manual') return current.deliveryId;
    const s = await this.settings(task.projectId);
    const target = isQualityTask(task.tags, s.tags)
      ? pickDelivery(await repo.references(task.projectId, { from: new Date(task.createdAt.getTime() - ms(s.windowHours)), to: task.createdAt }), task.createdAt, s.windowHours)
      : null;
    if (target && current?.deliveryId !== target.id) await repo.setAuto(task.id, target.id);
    else if (!target && current) await repo.removeAuto([task.id]);
    return target?.id ?? null;
  },

  /** Rattrapage d'un projet : recalcule tous les rattachements automatiques. Renvoie le nombre de changements. */
  async backfill(projectId: string): Promise<number> {
    const refs = await repo.references(projectId);
    const existing = await repo.linksOfProject(projectId);
    if (!refs.length && !existing.size) return 0;
    const s = await this.settings(projectId);
    const tasks = refs.length ? await repo.taggedTasksSince(projectId, refs[0].at) : [];
    // Les tâches rattachées automatiquement mais plus candidates (étiquette retirée, livraison disparue) sont réévaluées aussi.
    const seen = new Set(tasks.map((t) => t.id));
    const orphans = [...existing].filter(([id, l]) => l.source === 'auto' && !seen.has(id)).map(([id]) => id);
    const plan = backfillPlan(tasks, refs, existing, s);
    for (const l of plan.link) await repo.setAuto(l.taskId, l.deliveryId);
    await repo.removeAuto([...plan.unlink, ...orphans]);
    return plan.link.length + plan.unlink.length + orphans.length;
  },

  /** Rattrapage de tous les projets qui ont livré (au démarrage de l'instance meneuse). */
  async backfillAll(): Promise<void> {
    let changes = 0;
    for (const projectId of await repo.projectsWithDeliveries()) {
      changes += await this.backfill(projectId).catch((err) => {
        log.warn(`[deliveries] rattrapage des tâches qualité du projet ${projectId}`, err);
        return 0;
      });
    }
    if (changes) log.info(`[deliveries] tâches qualité : ${changes} rattachement(s) mis à jour par rattrapage`);
  },

  linkOf: (taskId: string) => repo.linkOf(taskId),
  linksOfTasks: (taskIds: string[]) => repo.linksOfTasks(taskIds),
  linksOfDeliveries: (deliveryIds: string[]) => repo.linksOfDeliveries(deliveryIds),

  /**
   * Correction à la main : rattache la tâche à une livraison du même projet, ou à aucune (`deliveryId` null), et le
   * calcul automatique n'y touche plus. `reset` : revient au calcul automatique.
   */
  async setLink(taskId: string, deliveryId: string | null, userId: string, opts: { reset?: boolean } = {}): Promise<DeliveryTaskLink | null> {
    const task = await taskService.get(taskId);
    if (opts.reset) {
      await repo.remove(taskId);
      await this.evaluate(task);
      return repo.linkOf(taskId);
    }
    if (deliveryId) {
      const d = await deliveryRepository.get(deliveryId);
      if (!d) throw new NotFoundError('Livraison introuvable');
      if (d.projectId !== task.projectId) throw new AppError("Cette livraison n'est pas du projet de la tâche");
    }
    await repo.setManual(taskId, deliveryId, userId);
    return repo.linkOf(taskId);
  },

  /** Taux de régression du projet sur les `days` derniers jours (livraisons de référence terminées depuis). */
  async report(projectId: string, days = 90): Promise<QualityReport> {
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 3650) * 86_400_000);
    const [settings, refs] = await Promise.all([this.settings(projectId), repo.references(projectId, { from: since })]);
    const ids = refs.map((r) => r.id);
    const [counts, authors] = await Promise.all([repo.qualityCounts(ids), repo.authors(ids)]);
    return { since, settings, ...regressionStats(ids, counts, authors) };
  },

  /** Branché sur les tâches : rattachement à la création, réévaluation quand les étiquettes changent. */
  register(): void {
    taskService.onTaskCreated('deliveryQuality', (task) => void this.evaluate(task).catch((err) => log.warn('[deliveries] rattachement qualité', err)));
    taskService.onTaskChanged('deliveryQuality', (change: TaskChange) => {
      if (change.kind !== 'updated' || change.before.tags.join('\n') === change.task.tags.join('\n')) return;
      void this.evaluate(change.task).catch((err) => log.warn('[deliveries] rattachement qualité', err));
    });
  },
};
