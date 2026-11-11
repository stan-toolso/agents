import { auditService } from '../audit/service.js';
import { AppError, NotFoundError } from '../errors.js';
import type { WorkspaceRef } from '../files/service.js';
import { requestGitConflictResolution } from '../git/conflicts.js';
import { ciVerdict, describeCi, type CiVerdict } from '../git/ci.js';
import { pullRequestService, type PullRequest } from '../git/pullRequests.js';
import { gitService, headCommitOf, operationOf } from '../git/service.js';
import { instanceRegistry } from '../instances/registry.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import { foreignRepoOf, projectRepoName, trackedPullRequestService } from '../pullRequests/service.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { reviewOf } from '../reviews/types.js';
import { traceSessionEvent } from '../sessions/events.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import { taskService } from '../tasks/service.js';
import * as ssh from '../vault/ssh.js';
import { vaultService } from '../vault/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { worksessionPath, worksessionService } from '../worksessions/service.js';
import { deliveryRepository, isUniqueViolation } from './repository.js';
import type { DeployedEvent, Delivery, DeliveryStep, DeployConfig, DeployConfigInput } from './types.js';

/**
 * Livraisons d'un projet (tâche 0f3c4c08) :
 * - « Livrer » (kind merge) un dossier de travail : fusion de la base dans la branche, push, PR ouverte ou reprise,
 *   attente des checks verts, fusion avec le compte de la personne qui a cliqué (son clic vaut accord). Chaque étape
 *   s'écrit dans la livraison et dans le transcript de la session du dossier ; un conflit est confié à son agent.
 * - « Déployer » (kind deploy) : commande du projet (deploy_configs) lancée par le backend sur un serveur SSH du coffre,
 *   seulement quand la CI de la branche déployée est verte, jamais deux à la fois (index unique partiel), et les demandes
 *   faites pendant un déploiement se regroupent en un seul déploiement en attente : un seul redémarrage par lot.
 * Les livraisons tournent en arrière-plan dans l'instance qui les a lancées ; une instance en drainage attend qu'elles
 * finissent (index.ts), et la tâche périodique des orphelins marque en échec celles d'une instance disparue.
 */

/** Intervalle entre deux lectures de la CI. */
export const POLL_MS = 15_000;
/** Attente maximale des checks d'une PR ou de la CI de la branche déployée. */
export const CHECKS_TIMEOUT_MS = 30 * 60_000;
/** Délai laissé à la CI pour apparaître sur un commit qui vient d'être poussé ; passé ce délai, « aucun check ». */
export const NO_CHECKS_GRACE_MS = 2 * 60_000;
/** Nouvelles tentatives quand la base a bougé pendant l'attente (refusion, nouvelle attente). */
const MAX_ROUNDS = 3;
/** Taille gardée de la sortie d'une commande de déploiement. */
const OUTPUT_KEEP = 16 * 1024;

/**
 * Premier déploiement connu d'un projet : seules les PR fusionnées depuis ce nombre de jours avant lui sont annoncées
 * (sans quoi le premier déploiement enregistré annoncerait tout l'historique du dépôt).
 */
export const DEPLOY_LOOKBACK_DAYS = 7;

/**
 * Pull requests qu'un déploiement de `branch` peut emporter (avant la vérification par git) : fusionnées sur cette
 * branche, dans le dépôt du projet, pas encore annoncées par un déploiement, et pas plus anciennes que `since`.
 */
export function deployCandidates(prs: TrackedPullRequest[], opts: { branch: string; projectRepo: string; alreadyDeployed: Set<string>; since: Date }): TrackedPullRequest[] {
  return prs.filter(
    (pr) =>
      pr.status === 'merged' &&
      !opts.alreadyDeployed.has(pr.id) &&
      pr.baseBranch === opts.branch &&
      !foreignRepoOf(pr, opts.projectRepo) &&
      (pr.mergedAt ?? pr.updatedAt) >= opts.since,
  );
}

type DeployedListener = (event: DeployedEvent) => Promise<void> | void;
const deployedListeners = new Map<string, DeployedListener>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pollMs = POLL_MS;
let graceMs = NO_CHECKS_GRACE_MS;
/** Tests : délais raccourcis. */
export function setDeliveryTimingsForTests(t: { pollMs?: number; graceMs?: number }): void {
  pollMs = t.pollMs ?? POLL_MS;
  graceMs = t.graceMs ?? NO_CHECKS_GRACE_MS;
}

/** Ce qu'il faut faire d'une PR pendant l'attente des checks. */
export type ChecksAction = { action: 'merge'; note?: string } | { action: 'wait' } | { action: 'fail'; reason: string } | { action: 'rebase' } | { action: 'done'; reason: string };

/** Décision à partir de l'état lu sur la forge (pur, testé). `elapsedMs` : depuis le push. */
export function checksAction(pr: Pick<PullRequest, 'state' | 'isDraft' | 'checksState' | 'checks' | 'mergeable'>, elapsedMs: number, grace = NO_CHECKS_GRACE_MS): ChecksAction {
  if (pr.state === 'MERGED') return { action: 'done', reason: 'La pull request a déjà été fusionnée' };
  if (pr.state !== 'OPEN') return { action: 'fail', reason: 'La pull request a été fermée' };
  if (pr.isDraft) return { action: 'fail', reason: 'La pull request est en brouillon : marquez-la prête pour la revue, puis relancez la livraison' };
  if (pr.mergeable === 'CONFLICTING') return { action: 'rebase' };
  const verdict: CiVerdict = ciVerdict(pr.checksState, pr.checks);
  if (verdict === 'failure') return { action: 'fail', reason: describeCi(pr) };
  if (verdict === 'pending') return { action: 'wait' };
  if (verdict === 'none') return elapsedMs >= grace ? { action: 'merge', note: 'aucun check sur ce commit' } : { action: 'wait' };
  return { action: 'merge' };
}

/** Commande de déploiement avec `{sha}` et `{branch}` remplacés (valeurs vérifiées : pas d'injection). */
export function renderDeployCommand(command: string, vars: { sha: string; branch: string }): string {
  if (!/^[0-9a-f]{7,40}$/i.test(vars.sha)) throw new AppError(`Commit invalide : ${vars.sha}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(vars.branch)) throw new AppError(`Branche invalide : ${vars.branch}`);
  return command.replaceAll('{sha}', vars.sha).replaceAll('{branch}', vars.branch);
}

/** Valide la configuration de déploiement saisie. */
export function normalizeDeployConfig(input: DeployConfigInput): DeployConfigInput {
  const vaultItem = input.vaultItem.trim().toLowerCase();
  const command = input.command.trim();
  const branch = input.branch?.trim() || null;
  if (!vaultItem) throw new AppError("Choisissez le serveur SSH du coffre sur lequel lancer la commande");
  if (!command) throw new AppError('La commande de déploiement est vide');
  if (branch && !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch)) throw new AppError(`Branche invalide : ${branch}`);
  const timeoutMinutes = input.timeoutMinutes ?? 30;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) throw new AppError('Le délai maximal va de 1 à 120 minutes');
  return { vaultItem, command, branch, timeoutMinutes };
}

/** Fin d'un texte (sortie de commande gardée). */
const tail = (text: string, max = OUTPUT_KEEP) => (text.length > max ? `…\n${text.slice(-max)}` : text);

// ---- Travaux en cours dans cette instance -----------------------------------------------------------------------

const jobs = new Set<Promise<void>>();
function track(name: string, fn: () => Promise<void>): void {
  const p = fn()
    .catch((err) => log.error(`[deliveries] ${name}`, err))
    .finally(() => jobs.delete(p));
  jobs.add(p);
}

/** Journalise une étape dans la livraison et, s'il y en a une, dans le transcript de la session du dossier. */
async function step(d: Pick<Delivery, 'id' | 'sessionId' | 'kind'>, message: string, level: DeliveryStep['level'] = 'info', phase?: DeliveryStep['phase']): Promise<void> {
  await deliveryRepository.appendStep(d.id, { at: new Date().toISOString(), message, level, ...(phase ? { phase } : {}) });
  if (d.sessionId) await traceSessionEvent(d.sessionId, 'system', { message: `${d.kind === 'deploy' ? 'Déploiement' : 'Livraison'} : ${message}`, delivery: { id: d.id, level } });
}

/** La livraison a-t-elle été annulée (ou terminée ailleurs) ? */
const stillActive = async (id: string) => {
  const d = await deliveryRepository.get(id);
  return Boolean(d && (d.status === 'running' || d.status === 'queued'));
};

/** Session du dossier de travail (hors relecture), la plus récente non archivée. */
async function worksessionSession(projectId: string, worksessionId: string): Promise<string | null> {
  const sessions = await sessionRepository.list({ projectId, worksessionId, archived: 'exclude', limit: 20 });
  return sessions.find((s) => !reviewOf(s))?.id ?? null;
}

export const deliveryService = {
  /** Écoute les déploiements réussis (lancés par Skipper ou déclarés), avec les PR et tâches qu'ils emportent. */
  onDeployed: (name: string, fn: DeployedListener) => deployedListeners.set(name, fn),

  /** Livraisons qui tournent dans cette instance (drainage : on les laisse finir). */
  localCount: () => jobs.size,

  get: (id: string) => deliveryRepository.get(id),
  list: (filter: Parameters<typeof deliveryRepository.list>[0]) => deliveryRepository.list(filter),
  getConfig: (projectId: string) => deliveryRepository.getConfig(projectId),

  async setConfig(projectId: string, input: DeployConfigInput | null, userId: string): Promise<DeployConfig | null> {
    if (!input) {
      await deliveryRepository.deleteConfig(projectId);
      return null;
    }
    const normalized = normalizeDeployConfig(input);
    // L'élément doit exister dans le coffre du projet et être un serveur SSH (vérifié pour la personne qui configure).
    const item = await vaultService.agentItemByName(projectId, userId, normalized.vaultItem);
    if (item.kind !== 'ssh') throw new AppError(`« ${item.name} » n'est pas un serveur SSH`);
    vaultService.assertCommandAllowed(item, normalized.command);
    return deliveryRepository.setConfig(projectId, normalized, userId);
  },

  /**
   * « Livrer » le dossier de travail d'une session ou d'une tâche : vérifications immédiates (erreur renvoyée à la
   * personne), puis la livraison continue en arrière-plan. `deploy` : demander un déploiement une fois fusionnée.
   */
  async deliver(input: { sessionId?: string | null; taskId?: string | null; userId: string; deploy?: boolean }): Promise<Delivery> {
    let worksessionId: string | null = null;
    let projectId: string;
    let taskId = input.taskId ?? null;
    let sessionId = input.sessionId ?? null;
    if (sessionId) {
      const s = await sessionService.get(sessionId);
      if (!s) throw new NotFoundError('Session introuvable');
      projectId = s.projectId;
      worksessionId = s.worksessionId;
      if (!worksessionId) throw new AppError('Cette session travaille dans le dossier principal du projet : il n’y a pas de branche à livrer');
    } else if (taskId) {
      const t = await taskService.get(taskId);
      projectId = t.projectId;
      if (!t.branch) throw new AppError("Cette tâche n'a pas de branche : rien à livrer");
      const ws = (await worksessionRepository.listByProject(projectId)).find((w) => w.branch === t.branch);
      if (!ws) throw new AppError(`Aucun dossier de travail actif sur la branche ${t.branch}`);
      worksessionId = ws.id;
    } else throw new AppError('Livrer quoi ? Une session ou une tâche est attendue');

    const project = await projectService.get(projectId);
    if (!project.gitUrl || !(await pullRequestService.hasPullRequests(projectId))) throw new AppError("Ce projet n'a pas de dépôt avec pull requests (GitHub, GitLab ou dépôt hébergé) : rien à livrer");
    const ws = await worksessionService.get(worksessionId);
    sessionId ??= await worksessionSession(projectId, worksessionId);
    if (sessionId) {
      const s = await sessionService.get(sessionId);
      if (s?.activity === 'busy' && s.status === 'running') throw new AppError("L'agent de la session est au travail : attendez la fin de son tour avant de livrer");
    }
    if (!taskId) {
      const t = (await taskService.list({ projectId, limit: 1000 }).catch(() => [])).find((x) => x.branch === ws.branch);
      taskId = t?.id ?? null;
    }
    // Vérifications immédiates : opération git en cours, fichiers non commités.
    const ref: WorkspaceRef = { projectId, worksessionId };
    const status = await gitService.status(ref);
    if (status.operation) throw new AppError('Une opération git est en cours dans ce dossier (fusion, rebase…) : terminez-la ou abandonnez-la avant de livrer');
    if (status.changes.length) throw new AppError(`${status.changes.length} fichier(s) non commité(s) dans ce dossier : commitez-les (ou demandez à l'agent de le faire) avant de livrer`);
    if (!status.branch) throw new AppError('HEAD détaché : rien à livrer');

    let d: Delivery;
    try {
      d = await deliveryRepository.create({ projectId, kind: 'merge', status: 'running', requestedById: input.userId, sessionId, worksessionId, taskId, branch: status.branch, instanceId: instanceRegistry.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('Une livraison est déjà en cours pour ce dossier de travail');
      throw err;
    }
    await auditService.record({ projectId, actor: { userId: input.userId }, action: 'delivery.merge', targetType: 'delivery', targetId: d.id, targetLabel: status.branch, details: { sessionId, taskId, deploy: Boolean(input.deploy) } }).catch(() => undefined);
    track(`livraison ${d.id}`, () => this.runMerge(d, Boolean(input.deploy)));
    return d;
  },

  /** Déroulé d'une livraison « merge » (arrière-plan). */
  async runMerge(d: Delivery, deployAfter: boolean): Promise<void> {
    const userId = d.requestedById!;
    const ref: WorkspaceRef = { projectId: d.projectId, worksessionId: d.worksessionId };
    const fail = async (message: string) => {
      await step(d, message, 'error');
      await deliveryRepository.finish(d.id, 'failed', { error: message });
    };
    try {
      const project = await projectService.get(d.projectId);
      const ws = await worksessionService.get(d.worksessionId!);
      const cwd = worksessionPath(project, ws);
      let pr: PullRequest | null = null;
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        // 1. Base fusionnée dans la branche.
        await step(d, `fusion de la branche de base dans ${d.branch}${round > 1 ? ` (tentative ${round})` : ''}`);
        await gitService.mergeBase(ref, userId);
        gitService.invalidate(ref);
        if (await operationOf(cwd)) {
          const msg = "conflit en fusionnant la branche de base : résolution confiée à l'agent de la session ; relancez « Livrer » une fois la résolution poussée";
          await step(d, msg, 'warn');
          await deliveryRepository.finish(d.id, 'conflict', { error: 'Conflit avec la branche de base' });
          await requestGitConflictResolution(ref, userId, { delivery: true }).catch((err) => step(d, `l'agent n'a pas pu être saisi du conflit : ${(err as Error).message}`, 'error'));
          return;
        }
        // 2. Push.
        await step(d, 'push de la branche');
        await gitService.push(ref, userId);
        const head = await headCommitOf(cwd);
        await deliveryRepository.updateActive(d.id, { sha: head });

        // 3. PR ouverte, ou reprise.
        if (!pr) {
          pr = (await pullRequestService.list(d.projectId, userId, 'OPEN', 100, { fresh: true })).find((p) => p.headRefName === d.branch && !p.isCrossRepository) ?? null;
          if (pr) {
            await trackedPullRequestService.recordGithub(d.projectId, pr, { type: 'human', userId }, { taskId: d.taskId });
            await step(d, `pull request #${pr.number} reprise`);
          } else {
            const draft = await pullRequestService.draft(ref, userId);
            const tracked = await trackedPullRequestService.open(ref, userId, { title: draft.title, body: draft.body }, { taskId: d.taskId }, { type: 'human', userId });
            pr = await pullRequestService.get(d.projectId, userId, tracked.number!);
            await step(d, `pull request #${pr.number} ouverte`);
          }
          await deliveryRepository.updateActive(d.id, { prNumber: pr.number, prUrl: pr.url });
        }

        // 4. Attente des checks.
        await step(d, 'attente des checks de la pull request');
        const pushedAt = Date.now();
        let decision: ReturnType<typeof checksAction> = { action: 'wait' };
        let lastWait = '';
        while (Date.now() - pushedAt < CHECKS_TIMEOUT_MS) {
          await sleep(pollMs);
          if (!(await stillActive(d.id))) return;
          pr = await pullRequestService.get(d.projectId, userId, pr.number);
          decision = checksAction(pr, Date.now() - pushedAt, graceMs);
          if (decision.action !== 'wait') break;
          const now = describeCi(pr);
          if (now !== lastWait && pr.checks.length) {
            lastWait = now;
            await deliveryRepository.appendStep(d.id, { at: new Date().toISOString(), message: now, level: 'info' });
          }
        }
        if (decision.action === 'wait') return fail(`les checks ne sont pas terminés au bout de ${CHECKS_TIMEOUT_MS / 60_000} minutes`);
        if (decision.action === 'fail') return fail(decision.reason);
        if (decision.action === 'done') {
          await step(d, decision.reason, 'success');
          await deliveryRepository.finish(d.id, 'succeeded');
          return;
        }
        if (decision.action === 'rebase') {
          await step(d, 'la branche de base a bougé et entre en conflit : nouvelle fusion', 'warn');
          continue;
        }
        await step(d, `checks verts${decision.note ? ` (${decision.note})` : ''}`, decision.note ? 'warn' : 'success');

        // 5. Fusion, avec le compte de la personne qui a cliqué.
        if (!(await stillActive(d.id))) return;
        try {
          const result = await pullRequestService.merge(d.projectId, userId, pr.number, 'MERGE', { deleteRemoteBranch: true, completeTasks: true });
          await trackedPullRequestService.markMerged(d.projectId, result.pullRequest, result.sha, { type: 'human', userId });
          for (const w of result.warnings) await step(d, w, 'warn');
          await step(d, `pull request #${pr.number} fusionnée${result.sha ? ` (${result.sha.slice(0, 7)})` : ''}`, 'success');
          await deliveryRepository.finish(d.id, 'succeeded', { sha: result.sha ?? undefined });
        } catch (err) {
          const message = (err as Error).message;
          // La base a bougé entre la lecture et la fusion : on refusionne et on réattend la CI.
          if (/modified|a changé|not mergeable|conflict/i.test(message) && round < MAX_ROUNDS) {
            await step(d, `fusion refusée (${message}) : nouvelle tentative`, 'warn');
            continue;
          }
          return fail(`fusion refusée : ${message}`);
        }
        if (deployAfter) {
          const config = await deliveryRepository.getConfig(d.projectId);
          if (!config) await step(d, "pas de déploiement configuré pour ce projet : rien n'est mis en production", 'warn');
          else {
            const deploy = await this.requestDeploy(d.projectId, userId).catch(async (err) => {
              await step(d, `déploiement non demandé : ${(err as Error).message}`, 'error');
              return null;
            });
            if (deploy) await step(d, deploy.status === 'queued' && deploy.requestedById !== userId ? 'déploiement demandé (regroupé avec celui qui attend déjà)' : 'déploiement demandé');
          }
        }
        return;
      }
      await fail('la branche de base bouge trop vite : relancez la livraison');
    } catch (err) {
      await fail((err as Error).message);
    }
  },

  // ---- Déploiement ------------------------------------------------------------------------------------------------

  /**
   * Demande un déploiement du projet : rejoint celui qui attend déjà (lot), sinon en crée un en attente ; il part dès
   * qu'aucun autre n'est en cours. Le clic d'une personne (administratrice du projet) vaut accord.
   */
  async requestDeploy(projectId: string, userId: string): Promise<Delivery> {
    const config = await deliveryRepository.getConfig(projectId);
    if (!config) throw new AppError("Aucun déploiement n'est configuré pour ce projet (Livraisons → Configurer le déploiement)");
    let d: Delivery | null = null;
    for (let attempt = 0; attempt < 3 && !d; attempt++) {
      const queued = await deliveryRepository.queuedDeploy(projectId);
      if (queued) {
        d = await deliveryRepository.join(queued.id, userId);
        if (d && d.requestedById !== userId) await deliveryRepository.appendStep(d.id, { at: new Date().toISOString(), message: 'demande regroupée avec ce déploiement en attente', level: 'info' });
        continue;
      }
      try {
        d = await deliveryRepository.create({ projectId, kind: 'deploy', status: 'queued', requestedById: userId, branch: config.branch, steps: [{ at: new Date().toISOString(), message: 'déploiement demandé', level: 'info' }] });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (!d) throw new AppError('Le déploiement n’a pas pu être mis en attente : réessayez');
    await auditService.record({ projectId, actor: { userId }, action: 'delivery.deploy', targetType: 'delivery', targetId: d.id, targetLabel: config.vaultItem, details: { command: config.command } }).catch(() => undefined);
    void this.pump(projectId);
    return (await deliveryRepository.get(d.id)) ?? d;
  },

  /** Lance le déploiement en attente du projet si aucun n'est en cours (verrou en base, entre instances). */
  async pump(projectId: string): Promise<void> {
    if (instanceRegistry.draining) return;
    const d = await deliveryRepository.startQueuedDeploy(projectId, instanceRegistry.id).catch((err) => {
      log.error('[deliveries] démarrage du déploiement', err);
      return null;
    });
    if (!d) return;
    track(`déploiement ${d.id}`, async () => {
      try {
        await this.runDeploy(d);
      } finally {
        // Le lot suivant (demandes arrivées pendant ce déploiement).
        await this.pump(projectId);
      }
    });
  },

  /** Déroulé d'un déploiement (arrière-plan) : CI verte de la branche, puis la commande sur le serveur. */
  async runDeploy(d: Delivery): Promise<void> {
    const fail = async (message: string) => {
      await step(d, message, 'error');
      await deliveryRepository.finish(d.id, 'failed', { error: message });
    };
    try {
      const config = await deliveryRepository.getConfig(d.projectId);
      if (!config) return fail("la configuration du déploiement a été retirée");
      const project = await projectService.get(d.projectId);
      const branch = config.branch || project.gitBranch || 'main';
      const userId = d.requestedById;
      await step(d, `vérification de la CI de ${branch}`);
      const started = Date.now();
      let sha: string | null = null;
      let announced = false;
      for (;;) {
        if (!(await stillActive(d.id))) return;
        let ci;
        try {
          ci = await pullRequestService.ciStatus(d.projectId, userId, branch);
        } catch (err) {
          return fail(`CI de ${branch} illisible : ${(err as Error).message}`);
        }
        sha = ci.sha;
        const verdict = ciVerdict(ci.state, ci.checks);
        if (verdict === 'failure') return fail(`CI rouge sur ${branch} (${ci.sha.slice(0, 7)}) : ${describeCi(ci)} ; rien n'est déployé`);
        if (verdict === 'success') {
          await step(d, `CI verte sur ${branch} (${ci.sha.slice(0, 7)})`, 'success');
          break;
        }
        if (verdict === 'none' && Date.now() - started >= graceMs) {
          await step(d, `aucun check sur ${branch} (${ci.sha.slice(0, 7)}) : déploiement sans CI`, 'warn');
          break;
        }
        if (Date.now() - started >= CHECKS_TIMEOUT_MS) return fail(`la CI de ${branch} n'est pas terminée au bout de ${CHECKS_TIMEOUT_MS / 60_000} minutes`);
        if (!announced) {
          announced = true;
          await step(d, `CI en cours sur ${branch} (${ci.sha.slice(0, 7)}) : attente`);
        }
        await sleep(pollMs);
      }
      await deliveryRepository.updateActive(d.id, { sha, branch });
      if (!(await stillActive(d.id))) return;

      const item = await vaultService.agentItemByName(d.projectId, userId, config.vaultItem);
      if (item.kind !== 'ssh') return fail(`« ${item.name} » n'est pas un serveur SSH`);
      const command = renderDeployCommand(config.command, { sha: sha!, branch });
      vaultService.assertCommandAllowed(item, command);
      await step(d, `commande lancée sur « ${item.name} » : ${command}`, 'info', 'command');
      const session = await ssh.connect(vaultService.sshCredentials(item), item.hostKey);
      let result: ssh.ExecResult;
      try {
        await vaultService.rememberHostKey(item, session.hostKey);
        result = await ssh.exec(session, command, { timeoutMs: config.timeoutMinutes * 60_000, maxBytes: 256 * 1024 });
      } finally {
        session.close();
      }
      const output = tail([result.stdout.trimEnd(), result.stderr.trim() ? `--- stderr ---\n${result.stderr.trimEnd()}` : ''].filter(Boolean).join('\n'));
      const ok = result.exitCode === 0;
      await vaultService.audit(item, 'used', { userId, projectId: d.projectId }, `déploiement : ${command} — code ${result.exitCode ?? result.signal}`, ok);
      if (!ok) {
        await deliveryRepository.updateActive(d.id, { output });
        return fail(`la commande a échoué (code ${result.exitCode ?? `signal ${result.signal}`}, ${Math.round(result.durationMs / 1000)} s)`);
      }
      await step(d, `déployé (${sha!.slice(0, 7)}, ${Math.round(result.durationMs / 1000)} s)`, 'success');
      await deliveryRepository.finish(d.id, 'succeeded', { output });
      const done = await deliveryRepository.get(d.id);
      if (done?.status === 'succeeded') await this.afterDeploy(done);
    } catch (err) {
      await fail((err as Error).message);
    }
  },

  /**
   * Déclare un déploiement fait hors de Skipper (script lancé par une session, CI, à la main) : il est enregistré comme
   * un déploiement réussi du projet, puis traité comme ceux que Skipper lance (PR emportées, agents prévenus).
   * `rev` : SHA (même abrégé) ou branche du dépôt, résolu après un fetch. Renvoie la livraison et l'événement.
   */
  async recordDeploy(input: { projectId: string; rev: string; branch?: string | null; note?: string | null; userId: string | null; sessionId?: string | null; gitUserId?: string | null }): Promise<{ delivery: Delivery; event: DeployedEvent }> {
    const project = await projectService.get(input.projectId);
    if (!project.gitUrl) throw new AppError("Ce projet n'est pas relié à un dépôt git : impossible de savoir ce qui a été déployé");
    const rev = input.rev.trim();
    if (!rev) throw new AppError('Quel commit a été déployé ? Donnez son SHA');
    const ref: WorkspaceRef = { projectId: input.projectId };
    await gitService.fetch(ref, input.gitUserId ?? input.userId).catch((err) => log.warn(`[deliveries] fetch avant déclaration de déploiement : ${(err as Error).message}`));
    const sha = (await gitService.resolveCommit(ref, rev)) ?? (await gitService.resolveCommit(ref, `origin/${rev}`));
    if (!sha) throw new AppError(`Commit inconnu du dépôt du projet : ${rev} (poussé sur origin ?)`);
    const branch = input.branch?.trim() || (await deliveryRepository.getConfig(input.projectId))?.branch || project.gitBranch || 'main';
    const note = input.note?.trim();
    const d = await deliveryRepository.create({
      projectId: input.projectId,
      kind: 'deploy',
      status: 'succeeded',
      requestedById: input.userId,
      sessionId: input.sessionId ?? null,
      branch,
      sha,
      steps: [{ at: new Date().toISOString(), message: `déploiement déclaré (${sha.slice(0, 7)})${note ? ` : ${note}` : ''}`, level: 'success' }],
    });
    await auditService
      .record({ projectId: input.projectId, actor: input.sessionId ? { sessionId: input.sessionId, userId: input.userId } : { userId: input.userId }, action: 'delivery.deploy_recorded', targetType: 'delivery', targetId: d.id, targetLabel: sha.slice(0, 7), details: { branch, note: note ?? null } })
      .catch(() => undefined);
    const event = await this.afterDeploy(d);
    return { delivery: d, event };
  },

  /**
   * Après un déploiement réussi : pull requests fusionnées emportées (commit de fusion contenu dans le commit déployé,
   * vérifié par git ; à défaut, fusionnées avant le déploiement), liées au déploiement pour n'être annoncées qu'une
   * fois, puis écouteurs prévenus (agents qui suivent les déploiements). Ne lève jamais.
   */
  async afterDeploy(d: Delivery): Promise<DeployedEvent> {
    const event: DeployedEvent = { delivery: d, pullRequests: [], tasks: [] };
    if (!d.sha) return event;
    try {
      const project = await projectService.get(d.projectId);
      const branch = d.branch || project.gitBranch || 'main';
      const first = (await deliveryRepository.firstDeployAt(d.projectId)) ?? d.createdAt;
      const since = new Date(first.getTime() - DEPLOY_LOOKBACK_DAYS * 86_400_000);
      const merged = await trackedPullRequestService.list({ projectId: d.projectId, status: ['merged'], limit: 500 });
      const candidates = deployCandidates(merged, { branch, projectRepo: projectRepoName(project), alreadyDeployed: await deliveryRepository.deployedPullRequestIds(d.projectId), since });
      const ref: WorkspaceRef = { projectId: d.projectId };
      const included: TrackedPullRequest[] = [];
      for (const pr of candidates) {
        const contained = pr.mergeSha ? await gitService.isAncestor(ref, pr.mergeSha, d.sha).catch(() => null) : null;
        // Commit de fusion inconnu (PR fusionnée à la main, dépôt pas à jour) : la date tranche.
        if (contained ?? (pr.mergedAt ?? pr.updatedAt) <= (d.finishedAt ?? new Date())) included.push(pr);
      }
      await deliveryRepository.linkPullRequests(d.id, included.map((pr) => pr.id));
      event.pullRequests = included;
      const taskIds = [...new Set(included.map((pr) => pr.taskId).filter((id): id is string => Boolean(id)))];
      for (const id of taskIds) {
        const t = await taskService.get(id).catch(() => null);
        if (t) event.tasks.push(t);
      }
      if (included.length) await deliveryRepository.appendStep(d.id, { at: new Date().toISOString(), message: `emporte ${included.length} pull request${included.length > 1 ? 's' : ''} : ${included.map((pr) => (pr.number != null ? `#${pr.number}` : pr.title)).join(', ')}`, level: 'info' });
    } catch (err) {
      log.error(`[deliveries] pull requests du déploiement ${d.id}`, err);
      return event;
    }
    for (const [name, fn] of deployedListeners) {
      try {
        await fn(event);
      } catch (err) {
        log.error(`[deliveries] écouteur « ${name} » du déploiement ${d.id}`, err);
      }
    }
    return event;
  },

  /** Annule une livraison en attente, ou en cours tant qu'elle attend la CI (pas une commande de déploiement lancée). */
  async cancel(id: string, userId: string): Promise<Delivery> {
    const d = await deliveryRepository.get(id);
    if (!d) throw new NotFoundError('Livraison introuvable');
    if (d.status !== 'queued' && d.status !== 'running') throw new AppError('Cette livraison est déjà terminée');
    if (d.steps.some((s) => s.phase === 'command')) throw new AppError('La commande de déploiement est lancée : elle ne peut plus être annulée');
    const done = await deliveryRepository.finish(id, 'cancelled', { error: 'Annulée' });
    await step(d, 'livraison annulée', 'warn');
    await auditService.record({ projectId: d.projectId, actor: { userId }, action: 'delivery.cancel', targetType: 'delivery', targetId: d.id, targetLabel: d.branch ?? d.kind }).catch(() => undefined);
    return done ?? d;
  },

  /**
   * Tâche périodique (instance qui tient les tâches) : livraisons d'une instance disparue marquées en échec, puis
   * déploiements en attente relancés.
   */
  async recover(liveInstanceIds: string[]): Promise<void> {
    const orphans = await deliveryRepository.failOrphans(liveInstanceIds, "Interrompue : l'instance du serveur qui la menait s'est arrêtée (vérifier le résultat avant de relancer)");
    for (const o of orphans) if (o.sessionId) await traceSessionEvent(o.sessionId, 'system', { message: "Livraison interrompue : l'instance du serveur qui la menait s'est arrêtée", delivery: { id: o.id, level: 'error' } });
    if (orphans.length) log.warn(`[deliveries] ${orphans.length} livraison(s) interrompue(s) par l'arrêt d'une instance`);
    for (const projectId of await deliveryRepository.projectsWithQueuedDeploy()) await this.pump(projectId);
  },

  /** Tests : attend la fin des livraisons en cours dans cette instance. */
  async settle(): Promise<void> {
    while (jobs.size) await Promise.all([...jobs]);
  },
};
