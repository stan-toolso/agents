import { AppError } from '../errors.js';
import { headCommitOf } from '../git/service.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { foreignRepoOf, projectRepoName, trackedPullRequestService } from '../pullRequests/service.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { reviewService } from '../reviews/service.js';
import { reviewOf } from '../reviews/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { taskRepository } from '../tasks/repository.js';
import { userService } from '../users/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { worksessionPath } from '../worksessions/service.js';
import { autoMergeDecision, normalizePolicyRules, policyFor, type AutoMergeDecision, type DeliveryPolicy, type ReviewState } from './policy.js';
import { deliveryRepository } from './repository.js';
import { deliveryService } from './service.js';

/**
 * Politique de livraison par étiquette (tâche 30510a65) : pour les tâches dont une étiquette est en « fusion
 * automatique », Skipper demande une relecture par un agent du commit courant de la branche, puis lance « Livrer »
 * (sans déploiement) avec le compte de l'administrateur qui a enregistré la politique, quand la relecture est
 * favorable et la CI verte. Tourne sur l'instance meneuse : un passage par minute, et un passage dès qu'un rapport de
 * relecture est publié. Les décisions (pures) sont dans policy.ts.
 */

/** Fréquence du passage sur les projets qui ont une règle de fusion automatique. */
const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
/** PR en cours d'examen (pas deux examens à la fois). */
const inFlight = new Set<string>();
/** Dernière décision par PR : seuls les changements sont journalisés. */
const lastDecision = new Map<string, string>();

/** Relectures par un agent du dossier de travail (archivées comprises), les plus récentes d'abord. */
async function reviewsOf(projectId: string, worksessionId: string): Promise<{ reviews: ReviewState[]; authorBusy: boolean }> {
  const sessions = await sessionRepository.list({ projectId, worksessionId, archived: 'all', limit: 100 });
  const reviews: ReviewState[] = [];
  let authorBusy = false;
  for (const s of sessions) {
    const review = reviewOf(s);
    if (!review) {
      if (!s.archivedAt && s.status === 'running' && s.activity === 'busy') authorBusy = true;
      continue;
    }
    reviews.push({ sessionId: s.id, headSha: review.headSha ?? null, done: Boolean(review.reportedAt), verdict: review.verdict ?? null, error: review.error ?? null, auto: Boolean(review.auto) });
  }
  return { reviews, authorBusy };
}

export const deliveryPolicyService = {
  get: (projectId: string) => deliveryRepository.getPolicy(projectId),

  /**
   * Enregistre la politique d'un projet (administrateur du projet, vérifié par l'appelant). La personne qui enregistre
   * devient le compte de fusion : c'est elle qui accepte que Skipper fusionne en son nom. Sans règle : politique retirée.
   */
  async set(projectId: string, rules: { tag: string; mode: string }[], userId: string): Promise<DeliveryPolicy | null> {
    let normalized;
    try {
      normalized = normalizePolicyRules(rules);
    } catch (err) {
      throw new AppError((err as Error).message);
    }
    if (!normalized.length) {
      await deliveryRepository.deletePolicy(projectId);
      return null;
    }
    return deliveryRepository.setPolicy(projectId, normalized, userId);
  },

  /** Examine les PR ouvertes d'un projet dont la tâche relève de la fusion automatique. */
  async evaluateProject(projectId: string, policy?: DeliveryPolicy | null): Promise<void> {
    policy ??= await deliveryRepository.getPolicy(projectId);
    if (!policy || !policy.rules.some((r) => r.mode === 'auto_merge')) return;
    const project = await projectService.get(projectId);
    if (!project.gitUrl) return;
    const repo = projectRepoName(project);
    const prs = await trackedPullRequestService.list({ projectId, status: ['open'], limit: 100 });
    for (const pr of prs) {
      if (!pr.taskId || foreignRepoOf(pr, repo) || inFlight.has(pr.id)) continue;
      inFlight.add(pr.id);
      try {
        await this.evaluate(project, pr, policy);
      } catch (err) {
        log.warn(`[deliveries] fusion automatique de la PR #${pr.number ?? '?'} (${projectId})`, err);
      } finally {
        inFlight.delete(pr.id);
      }
    }
  },

  /** Une PR : relecture à demander, fusion à lancer, ou attente. Renvoie la décision prise. */
  async evaluate(project: Awaited<ReturnType<typeof projectService.get>>, pr: TrackedPullRequest, policy: DeliveryPolicy): Promise<AutoMergeDecision> {
    const task = pr.taskId ? await taskRepository.findById(pr.taskId) : null;
    const applied = policyFor(policy.rules, task?.tags ?? []);
    if (!task || applied.mode !== 'auto_merge') return { action: 'skip', reason: 'tâche en livraison manuelle' };
    const ws = pr.worksessionId ? await worksessionRepository.findById(pr.worksessionId) : await worksessionRepository.findByBranch(project.id, pr.headBranch);
    if (!ws || ws.archivedAt) return note(pr, { action: 'wait', reason: 'pas de dossier de travail actif sur la branche' });
    const headSha = await headCommitOf(worksessionPath(project, ws)).catch(() => null);
    const { reviews, authorBusy } = await reviewsOf(project.id, ws.id);
    const deliveryActive = (await deliveryRepository.list({ worksessionId: ws.id, kind: 'merge', limit: 1 })).some((d) => d.status === 'running' || d.status === 'queued');
    const decision = autoMergeDecision({ pr, headSha, reviews, authorBusy, deliveryActive });
    if (decision.action === 'skip' || decision.action === 'wait') return note(pr, decision);

    // Compte de fusion : l'administrateur qui a enregistré la politique, s'il l'est encore.
    const mergeUserId = policy.mergeUserId;
    const role = mergeUserId ? await userService.memberRoleFor(mergeUserId, project.id) : null;
    if (!mergeUserId || role !== 'admin') {
      const reason = "le compte de fusion de la politique n'est plus administrateur du projet : réenregistrez la politique";
      if (lastDecision.get(pr.id) !== `wait : ${reason}`) {
        void notificationService.notify({ type: 'delivery.failed', title: 'Fusion automatique impossible', message: reason, link: `/projects/${project.id}/deliveries`, projectId: project.id });
      }
      return note(pr, { action: 'wait', reason });
    }

    if (decision.action === 'review') {
      try {
        await reviewService.request({ projectId: project.id, pullRequestId: pr.id }, mergeUserId, { auto: true });
      } catch (err) {
        return note(pr, { action: 'wait', reason: `relecture non lancée : ${(err as Error).message}` });
      }
      note(pr, decision);
      log.info(`[deliveries] relecture automatique demandée pour la PR #${pr.number} (${project.name}, étiquette « ${applied.tag} »)`);
      return decision;
    }
    try {
      await deliveryService.deliver({ worksessionId: ws.id, taskId: task.id, userId: mergeUserId, deploy: false, auto: { tag: applied.tag ?? '', reviewSessionId: decision.reviewSessionId, prNumber: pr.number } });
    } catch (err) {
      // Refus immédiat (fichiers non commités, opération git en cours…) : nouvel essai au prochain passage.
      return note(pr, { action: 'wait', reason: `livraison refusée : ${(err as Error).message}` });
    }
    note(pr, decision);
    log.info(`[deliveries] fusion automatique lancée pour la PR #${pr.number} (${project.name})`);
    return decision;
  },

  /** Un passage sur tous les projets qui ont une règle de fusion automatique. */
  async tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const policy of await deliveryRepository.autoMergeProjects()) {
        await this.evaluateProject(policy.projectId, policy).catch((err) => log.warn(`[deliveries] politique de livraison du projet ${policy.projectId}`, err));
      }
    } finally {
      ticking = false;
    }
  },

  /** Instance meneuse : passage périodique, et dès qu'une relecture est publiée. */
  start(): void {
    if (timer) return;
    reviewService.onReported('delivery-policy', (session) => {
      void this.evaluateProject(session.projectId).catch((err) => log.warn('[deliveries] politique de livraison après une relecture', err));
    });
    timer = setInterval(() => void this.tick().catch((err) => log.error('[deliveries] politique de livraison', err)), TICK_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

/** Garde la décision pour la PR et journalise ses changements. */
function note(pr: TrackedPullRequest, decision: AutoMergeDecision): AutoMergeDecision {
  const text = decision.action === 'wait' || decision.action === 'skip' ? `${decision.action} : ${decision.reason}` : decision.action;
  if (lastDecision.get(pr.id) !== text) {
    lastDecision.set(pr.id, text);
    log.info(`[deliveries] fusion automatique, PR #${pr.number ?? '?'} : ${text}`);
  }
  return decision;
}
