import { describeCost } from '../billing/display.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { pubSub } from '../pubsub.js';
import { requestRepository } from '../requests/repository.js';
import { cleanupService } from '../sessions/cleanup.js';
import { sessionRepository } from '../sessions/repository.js';
import { scheduledRuns } from '../sessions/scheduledRuns.js';
import { serverSettings } from '../settings/server.js';
import { sessionService } from '../sessions/service.js';
import type { Session, SessionCleanup } from '../sessions/types.js';
import { claudeSettings } from '../settings/claude.js';
import { projectBudget } from '../projects/budget.js';
import { CronError, isValidTimeZone, nextRun, nextRuns, parseCron } from './cron.js';
import { RUN_STATUS_LABELS, runOutcome, summarizeEvents } from './outcome.js';
import { forgetScheduleRules } from './activeRules.js';
import { runSessionName, validArchive } from './archive.js';
import { MAX_SCHEDULE_RULES, normalizeRules, suggestionsFromPrompt, suggestionsFromRuns, type PastRun, type ToolSuggestion } from './permissions.js';
import { vaultService } from '../vault/service.js';
import { scheduleRepository } from './repository.js';
import { type ScheduleRun, type ScheduleRunStatus, type SessionSchedule, type SessionScheduleInput } from './types.js';
import { log } from '../log.js';
import { systemAuthor } from '../sessions/instructionAuthor.js';

/** Fréquence de vérification des échéances. */
const TICK_MS = 30_000;
/** Une échéance manquée (serveur arrêté) est encore exécutée si elle date de moins de dix minutes ; au-delà, on attend la suivante. */
const MISSED_GRACE_MS = 10 * 60_000;
/** Durée maximale d'attente de la fin d'une exécution avant de conclure. */
const RUN_TIMEOUT_MS = 4 * 3_600_000;
/** Pas de l'attente de fin d'une exécution : entre deux pas, on regarde si l'agent attend un humain. */
const WAIT_STEP_MS = 60_000;
/**
 * Une demande (autorisation, question) restée sans réponse aussi longtemps pendant une exécution planifiée la rend
 * « bloquée » : personne ne surveille une exécution planifiée, on prévient au lieu d'attendre des heures.
 */
const BLOCKED_AFTER_MS = 10 * 60_000;
/** Une exécution encore « en cours » sans suivi local depuis ce délai, session au repos, est close par la reprise. */
const ORPHAN_AFTER_MS = 5 * 60_000;
/** Fréquence du balayage de purge des transcripts (durée de conservation). */
const SWEEP_MS = 3_600_000;
const DEFAULT_TIMEZONE = 'UTC';

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let lastSweep = 0;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function emit(sessionId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  const event = await sessionRepository.addEvent(sessionId, type, payload);
  pubSub.publish('sessionEvent', sessionId, event);
  return event.id;
}

/**
 * Nom affiché d'une planification : le sien, sinon celui de la session, sinon (session au nom par défaut
 * « Session », cas des planifications d'avant les noms) le début de l'instruction.
 */
export function scheduleLabel(schedule: Pick<SessionSchedule, 'name' | 'prompt'>, session: Pick<Session, 'name'>): string {
  const own = schedule.name?.trim();
  if (own) return own;
  if (session.name.trim() && session.name.trim() !== 'Session') return session.name;
  const line = (schedule.prompt.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line ? (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) : session.name;
}

function parseOrThrow(cron: string) {
  try {
    return parseCron(cron);
  } catch (err) {
    if (err instanceof CronError) throw new AppError(err.message);
    throw err;
  }
}

/** Titre et type de la notification de fin d'une exécution, selon son issue. */
function notificationOf(status: ScheduleRunStatus, label: string): { type: string; title: string } {
  if (status === 'blocked') return { type: 'schedule.blocked', title: `« ${label} » bloquée : autorisation refusée ou demande sans réponse` };
  if (status === 'failed') return { type: 'schedule.failed', title: `« ${label} » en erreur` };
  if (status === 'timeout') return { type: 'schedule.failed', title: `« ${label} » toujours en cours après le délai d'attente` };
  return { type: 'schedule.run', title: `« ${label} » terminée` };
}

/**
 * Réglages du provider repris de la session de la planification pour la session d'une exécution : seulement les
 * champs déclarés par le provider (mode d'autorisation, modèle…), pas les drapeaux internes de la session.
 */
async function runConfig(template: Session): Promise<Record<string, unknown>> {
  let keys: string[] = [];
  try {
    // Import tardif : le registre des providers tire tout le moteur des sessions (inutile aux modules qui n'exécutent rien).
    const { getProvider } = await import('../sessions/providers/registry.js');
    keys = getProvider(template.provider).describe().configFields.map((f) => f.key);
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) if (template.config?.[k] !== undefined && template.config[k] !== null && template.config[k] !== '') out[k] = template.config[k];
  return out;
}

/** Archive la session d'une exécution ; une PR encore ouverte de son dossier (ou une erreur) la laisse active. */
async function archiveRunSession(runSessionId: string, reason: string): Promise<boolean> {
  try {
    const session = await sessionRepository.findById(runSessionId);
    if (!session || session.archivedAt) return false;
    await sessionService.archiveWhenDone(runSessionId, reason, { schedule: true });
    return true;
  } catch (err) {
    log.warn(`[schedules] session d'exécution ${runSessionId} non archivée : ${(err as Error).message}`);
    return false;
  }
}

/** Règles d'une planification validées pour l'enregistrement ; undefined : inchangées. */
function validRules(list: string[] | null | undefined): string[] | undefined {
  if (list === undefined || list === null) return undefined;
  const { rules, invalid } = normalizeRules(list);
  if (invalid.length) throw new AppError(`Règle d'autorisation illisible : ${invalid.join(', ')} (forme attendue : Outil ou Outil(motif), ex. Bash(git status *))`);
  if (rules.length > MAX_SCHEDULE_RULES) throw new AppError(`Au plus ${MAX_SCHEDULE_RULES} outils pré-autorisés par planification`);
  return rules;
}

/** Exécutions suivies par cette instance (identifiant d'exécution par session). */
const localRuns = new Map<string, string>();

/**
 * Clôt une exécution : historique, compte rendu texte (compatibilité), jalon du transcript, notification.
 * Ne fait rien si l'exécution était déjà close (une seule clôture, donc une seule notification).
 */
async function finish(run: ScheduleRun, session: Session, schedule: SessionSchedule, opts: { stillBusy: boolean; startedAt: number; pendingRequest?: string | null }): Promise<ScheduleRun | null> {
  // `session` : celle de l'exécution (sa propre session, ou celle de la planification pour une exécution d'avant).
  const id = session.id;
  const scheduleId = schedule.sessionId;
  const events = run.startEventId ? await sessionRepository.listEvents(id, { after: run.startEventId, limit: 2000 }) : [];
  const summary = summarizeEvents(events);
  const { status, message } = runOutcome(summary, { stillBusy: opts.stillBusy, pendingRequest: opts.pendingRequest ?? null });
  const durationMs = summary.durationMs ?? Date.now() - opts.startedAt;
  const closed = await scheduleRepository.finishRun(run.id, { status, costUsd: summary.cost, durationMs, message, answer: summary.answer });
  forgetScheduleRules(id);
  if (!closed) return null;
  const cost = await describeCost(summary.cost);
  const details = [formatDuration(durationMs), cost].join(' · ');
  await scheduleRepository.setResult(scheduleId, `${RUN_STATUS_LABELS[status]}${message ? ` : ${message}` : ''} · ${details}`);
  await emit(id, 'schedule', { action: 'done', runId: run.id, status, outcome: RUN_STATUS_LABELS[status], message, cost: summary.cost, durationMs, name: schedule.name });
  const label = scheduleLabel(schedule, session);
  const n = notificationOf(status, label);
  void notificationService.notify({
    ...n,
    message: message ? `${message} · ${details}` : details,
    // Bloquée : la notification ouvre la planification, où l'on pré-autorise les outils refusés.
    link: status === 'blocked' ? `/projects/${session.projectId}/schedules?edit=${scheduleId}` : `/sessions/${id}`,
    projectId: session.projectId,
    sessionId: id,
    payload: { runId: run.id, status, cost: summary.cost, durationMs, ...(status === 'blocked' ? { denied: summary.denied, sessionLink: `/sessions/${id}` } : {}) },
  });
  // « Dès la fin de l'exécution » : sauf demande encore en attente (on la laisse à portée de réponse).
  if (schedule.archivePolicy === 'on_finish' && id !== scheduleId && !opts.pendingRequest && !opts.stillBusy) {
    await archiveRunSession(id, 'exécution terminée');
  }
  return closed;
}

export const scheduleService = {
  get: (sessionId: string) => scheduleRepository.findBySession(sessionId),
  findBySessions: (sessionIds: string[]) => scheduleRepository.findBySessions(sessionIds),
  listForProjects: (projectIds: string[]) => scheduleRepository.listForProjects(projectIds),
  listRuns: (sessionId: string, limit?: number) => scheduleRepository.listRuns(sessionId, limit),
  listRecentRuns: (sessionIds: string[], perSession: number) => scheduleRepository.listRecentRuns(sessionIds, perSession),

  /**
   * Outils à pré-autoriser pour une planification : refusés ou demandés pendant ses dernières exécutions, et
   * éléments du coffre « avec approbation » que cite l'instruction. Sans session (nouvelle planification) :
   * seulement ceux de l'instruction.
   */
  async permissionSuggestions(opts: { sessionId?: string | null; projectId: string; ownerId: string | null; prompt?: string | null; runs?: number }): Promise<ToolSuggestion[]> {
    const past: PastRun[] = [];
    if (opts.sessionId) {
      const runs = (await scheduleRepository.listRuns(opts.sessionId, opts.runs ?? 10)).filter((r) => r.startEventId);
      for (const run of runs) {
        const runSessionId = run.runSessionId ?? opts.sessionId;
        const [events, requests] = await Promise.all([
          scheduleRepository.runResultEvents(runSessionId, run.startEventId!, run.finishedAt),
          scheduleRepository.runPermissionRequests(runSessionId, run.startedAt, run.finishedAt),
        ]);
        past.push({ startedAt: run.startedAt, events, requests });
      }
    }
    const fromRuns = suggestionsFromRuns(past);
    const prompt = opts.prompt?.trim();
    const items = prompt ? await vaultService.agentItems(opts.projectId, opts.ownerId).catch(() => []) : [];
    const fromPrompt = prompt ? suggestionsFromPrompt(prompt, items).filter((s) => !fromRuns.some((r) => r.rule.toLowerCase() === s.rule.toLowerCase())) : [];
    return [...fromRuns, ...fromPrompt];
  },

  /** Les prochaines échéances d'une expression (aperçu pour l'interface). Lève AppError si l'expression est invalide. */
  preview(cron: string, timezone: string | null | undefined, count = 5): Date[] {
    const tz = timezone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(tz)) throw new AppError(`Fuseau horaire inconnu : ${tz}`);
    return nextRuns(parseOrThrow(cron), new Date(), tz, Math.min(Math.max(count, 1), 20));
  },

  /** Crée ou remplace la planification d'une session. L'échéance est calculée à partir de maintenant. */
  async set(sessionId: string, input: SessionScheduleInput): Promise<SessionSchedule> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.kind === 'chat') throw new AppError("Un chat ne se planifie pas : planifiez une session");
    const prompt = input.prompt.trim();
    if (!prompt) throw new AppError("L'instruction à envoyer à chaque exécution est vide");
    const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) throw new AppError(`Fuseau horaire inconnu : ${timezone}`);
    const spec = parseOrThrow(input.cron);
    const name = input.name === undefined ? undefined : input.name?.trim().slice(0, 120) || null;
    const enabled = input.enabled ?? true;
    const allowedTools = validRules(input.allowedTools);
    const archive = validArchive(input);
    // Le nettoyage de la conversation accompagne la planification : sans lui, le contexte grossit à chaque exécution.
    if (input.cleanup) await cleanupService.set(sessionId, input.cleanup);
    const schedule = await scheduleRepository.upsert(sessionId, {
      name,
      cron: spec.source,
      timezone,
      prompt,
      enabled,
      endAfterRun: input.endAfterRun ?? true,
      nextRunAt: enabled ? nextRun(spec, new Date(), timezone) : null,
      allowedTools,
      archive,
    });
    forgetScheduleRules(sessionId);
    await emit(sessionId, 'schedule', { action: enabled ? 'set' : 'disabled', cron: schedule.cron, timezone, nextRunAt: schedule.nextRunAt, name: schedule.name });
    // Une session planifiée porte le nom de sa planification : c'est lui qu'on lit dans la sidebar et les onglets.
    if (name && name !== session.name) await sessionService.rename(sessionId, name);
    else pubSub.publish('sessionUpdated', session);
    return schedule;
  },

  /** Met en pause (plus aucune échéance) ou reprend (échéance recalculée depuis maintenant). */
  async setEnabled(sessionId: string, enabled: boolean): Promise<Session> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    const existing = await scheduleRepository.findBySession(sessionId);
    if (!existing) throw new AppError("Cette session n'a pas de planification");
    if (existing.enabled !== enabled) {
      const next = enabled ? nextRun(parseOrThrow(existing.cron), new Date(), existing.timezone) : null;
      await scheduleRepository.setEnabled(sessionId, enabled, next);
      await emit(sessionId, 'schedule', { action: enabled ? 'resumed' : 'disabled', nextRunAt: next, name: existing.name });
    }
    pubSub.publish('sessionUpdated', session);
    return session;
  },

  /**
   * Nouvelle planification avec sa session : la session est créée sans démarrer, dans son propre dossier de
   * travail, et ne fait rien avant la première échéance (ou « Exécuter maintenant » si `runNow`).
   */
  async createWithSession(
    input: SessionScheduleInput & { projectId: string; name: string; provider?: string | null; config?: Record<string, unknown> | null; runNow?: boolean | null },
    ownerId: string,
  ): Promise<Session> {
    const name = input.name.trim();
    if (!name) throw new AppError('Donnez un nom à la planification');
    // Valide tout avant de créer quoi que ce soit (pas de session orpheline sur une expression invalide).
    if (!input.prompt.trim()) throw new AppError("L'instruction à envoyer à chaque exécution est vide");
    parseOrThrow(input.cron);
    validRules(input.allowedTools);
    validArchive(input);
    if (input.timezone && !isValidTimeZone(input.timezone.trim())) throw new AppError(`Fuseau horaire inconnu : ${input.timezone}`);
    const session = await sessionService.create({
      projectId: input.projectId,
      name: name.slice(0, 120),
      provider: input.provider || 'claude',
      config: input.config ?? null,
      newWorksession: {},
      ownerId,
      autoStart: false,
    });
    const cleanup: SessionCleanup = input.cleanup ?? { retentionDays: null, contextAction: 'fresh', contextMaxTokens: null };
    await this.set(session.id, { ...input, name, cleanup });
    if (input.runNow) await this.runNow(session.id, ownerId);
    return (await sessionRepository.findById(session.id)) ?? session;
  },

  async remove(sessionId: string): Promise<Session> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    if (await scheduleRepository.delete(sessionId)) await emit(sessionId, 'schedule', { action: 'removed' });
    pubSub.publish('sessionUpdated', session);
    return session;
  },

  /** Exécution immédiate, hors échéance (la prochaine échéance est inchangée). */
  async runNow(sessionId: string, userId: string | null = null): Promise<Session> {
    const schedule = await scheduleRepository.findBySession(sessionId);
    if (!schedule) throw new AppError("Cette session n'a pas de planification");
    await this.run(schedule, { manual: true, userId });
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    return session;
  },

  /**
   * Exécute la planification : crée une nouvelle session (projet, propriétaire, provider et réglages de la session de
   * la planification, dans son propre dossier de travail) et lui envoie l'instruction ; puis, en tâche de fond, attend
   * la fin du tour, termine la session si demandé, notifie avec le coût et applique l'archivage choisi.
   * `manual` : lancée depuis l'interface, les erreurs sont renvoyées à l'appelant.
   */
  async run(schedule: SessionSchedule, opts: { manual?: boolean; userId?: string | null; scheduledFor?: Date | null } = {}): Promise<void> {
    const manual = Boolean(opts.manual);
    const id = schedule.sessionId;
    const template = await sessionRepository.findById(id);
    if (!template) return;
    const label = scheduleLabel(schedule, template);
    const runBase = { sessionId: id, trigger: manual ? ('manual' as const) : ('schedule' as const), triggeredBy: opts.userId ?? null, scheduledFor: opts.scheduledFor ?? null };
    const skip = async (reason: string) => {
      if (manual) throw new AppError(`Exécution impossible : ${reason}`);
      await scheduleRepository.createRun({ ...runBase, status: 'skipped', message: reason });
      await scheduleRepository.setResult(id, `Ignorée : ${reason}`);
      await emit(id, 'schedule', { action: 'skipped', reason, name: schedule.name });
      pubSub.publish('sessionUpdated', template);
      void notificationService.notify({
        type: 'schedule.skipped',
        title: `« ${label} » ignorée`,
        message: reason,
        link: `/projects/${template.projectId}/schedules?edit=${id}`,
        projectId: template.projectId,
        sessionId: id,
      });
    };

    if (template.archivedAt) return skip('la session de la planification est archivée');
    if (scheduledRuns.has(id) || (await scheduleRepository.hasRunning(id))) return skip("l'exécution précédente n'est pas terminée");
    if (serverSettings.maintenance) return skip('le serveur est en maintenance');
    // La session de l'exécution démarre avec les identifiants et le plafond du propriétaire de la planification.
    try {
      const owner = await claudeSettings.forSession(template.ownerId);
      owner.assertCredentials();
      await owner.assertBudgetAvailable();
      await projectBudget.assertAvailable(template.projectId);
    } catch (err) {
      return skip((err as Error).message);
    }

    const startedAt = Date.now();
    scheduledRuns.add(id);
    let run = await scheduleRepository.createRun({ ...runBase, status: 'running' });
    let runSession: Session;
    try {
      runSession = await sessionService.create({
        projectId: template.projectId,
        name: runSessionName(label, new Date(startedAt), schedule.timezone),
        provider: template.provider,
        config: await runConfig(template),
        newWorksession: {},
        ownerId: template.ownerId,
        requestedById: template.requestedById,
        autoStart: false,
      });
    } catch (err) {
      scheduledRuns.delete(id);
      const message = `Session de l'exécution non créée : ${(err as Error).message}`;
      await scheduleRepository.finishRun(run.id, { status: 'failed', costUsd: 0, durationMs: Date.now() - startedAt, message });
      await scheduleRepository.setResult(id, `Erreur : ${message}`);
      if (manual) throw new AppError(message);
      void notificationService.notify({ type: 'schedule.failed', title: `« ${label} » en erreur`, message, link: `/projects/${template.projectId}/schedules?edit=${id}`, projectId: template.projectId, sessionId: id });
      return;
    }
    const rid = runSession.id;
    await scheduleRepository.setRunSession(run.id, rid);
    const eventId = await emit(rid, 'schedule', { action: 'run', runId: run.id, cron: schedule.cron, timezone: schedule.timezone, manual, name: schedule.name, scheduleSessionId: id });
    await scheduleRepository.setRunStartEvent(run.id, eventId);
    run = { ...run, runSessionId: rid, startEventId: eventId };
    if (manual) await scheduleRepository.markRun(id, new Date());
    await scheduleRepository.setResult(id, 'En cours');
    scheduledRuns.add(rid);
    localRuns.set(rid, run.id);
    forgetScheduleRules(rid);
    // « Archiver l'ancien lors d'un nouveau run » : les sessions des exécutions précédentes sont rangées.
    if (schedule.archivePolicy === 'previous_on_run') {
      for (const previous of await scheduleRepository.activeRunSessions(id, rid)) await archiveRunSession(previous, 'nouvelle exécution de la planification');
    }
    try {
      await sessionService.sendMessage(rid, schedule.prompt, null, { author: systemAuthor(`Planification « ${label} »`) });
    } catch (err) {
      scheduledRuns.delete(id);
      scheduledRuns.delete(rid);
      localRuns.delete(rid);
      const message = (err as Error).message;
      await scheduleRepository.finishRun(run.id, { status: 'failed', costUsd: 0, durationMs: Date.now() - startedAt, message });
      await scheduleRepository.setResult(id, `Erreur : ${message}`);
      if (manual) throw err;
      void notificationService.notify({ type: 'schedule.failed', title: `« ${label} » en erreur`, message, link: `/sessions/${rid}`, projectId: template.projectId, sessionId: rid });
      return;
    }
    // Jalon dans la session de la planification : où trouver cette exécution.
    await emit(id, 'schedule', { action: 'spawned', runId: run.id, runSessionId: rid, manual, name: schedule.name }).catch(() => undefined);
    pubSub.publish('sessionUpdated', template);

    // Suivi en tâche de fond : fin du tour (ou demande restée sans réponse), fin de session si demandé, compte rendu et notification.
    const tracked = run;
    void (async () => {
      try {
        let current = (await sessionRepository.findById(rid)) ?? runSession;
        let pendingRequest: string | null = null;
        while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
          current = await sessionService.waitForIdle(rid, WAIT_STEP_MS);
          if (current.status !== 'running' || current.activity === 'idle') break;
          const waiting = (await requestRepository.list({ sessionId: rid, status: 'pending', limit: 1 }))[0];
          if (waiting && Date.now() - waiting.createdAt.getTime() >= BLOCKED_AFTER_MS) {
            // Personne ne répond : l'exécution est notée « bloquée » ; la demande reste ouverte et l'agent repartira si quelqu'un y répond.
            pendingRequest = waiting.title;
            break;
          }
        }
        if (!pendingRequest && current.status === 'running' && current.activity === 'idle' && schedule.endAfterRun) {
          await sessionService.end(rid).catch(() => undefined);
          current = await sessionService.waitForIdle(rid, 60_000);
        }
        const stillBusy = !pendingRequest && current.status === 'running' && current.activity !== 'idle';
        await finish(tracked, current, schedule, { stillBusy, startedAt, pendingRequest });
      } catch (err) {
        log.error("[schedules] suivi de l'exécution", err);
      } finally {
        scheduledRuns.delete(id);
        scheduledRuns.delete(rid);
        if (localRuns.get(rid) === tracked.id) localRuns.delete(rid);
        const fresh = await sessionRepository.findById(id);
        if (fresh) pubSub.publish('sessionUpdated', fresh);
      }
    })();
  },

  /** Archivage « après X temps » : sessions d'exécutions terminées depuis plus que le délai de leur planification. */
  async archiveExpiredRuns(now = new Date()): Promise<number> {
    let archived = 0;
    for (const id of await scheduleRepository.runSessionsPastDelay(now)) {
      if (scheduledRuns.has(id)) continue;
      if (await archiveRunSession(id, 'délai d’archivage de la planification écoulé')) archived += 1;
    }
    return archived;
  },

  /**
   * Exécutions « en cours » dont le suivi a été perdu (instance arrêtée pendant l'exécution) : celles dont la
   * session est au repos sont closes avec ce que le transcript en dit. La clôture est atomique : si l'instance
   * qui la suit la clôt au même moment, une seule des deux notifie.
   */
  async reconcile(now = new Date()): Promise<number> {
    let closed = 0;
    for (const run of await scheduleRepository.listRunningBefore(new Date(now.getTime() - ORPHAN_AFTER_MS))) {
      const runSessionId = run.runSessionId ?? run.sessionId;
      if (localRuns.get(runSessionId) === run.id) continue;
      const session = await sessionRepository.findById(runSessionId);
      const schedule = await scheduleRepository.findBySession(run.sessionId);
      const settled = !session || (session.status !== 'running' && session.status !== 'queued') || session.activity === 'idle';
      const tooOld = now.getTime() - run.startedAt.getTime() > RUN_TIMEOUT_MS + ORPHAN_AFTER_MS;
      if (!settled && !tooOld) continue;
      if (!session || !schedule) {
        if (await scheduleRepository.finishRun(run.id, { status: 'failed', costUsd: null, durationMs: null, message: 'Planification ou session supprimée pendant l’exécution' })) closed += 1;
        continue;
      }
      if (await finish(run, session, schedule, { stillBusy: !settled, startedAt: run.startedAt.getTime() })) closed += 1;
    }
    return closed;
  },

  /** Un passage de l'ordonnanceur : réserve puis exécute chaque échéance passée. */
  async tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      if (now.getTime() - lastSweep >= SWEEP_MS) {
        lastSweep = now.getTime();
        const swept = await cleanupService.sweep();
        if (swept.deleted) log.info(`[cleanup] ${swept.deleted} événement(s) purgé(s) sur ${swept.sessions} session(s)`);
      }
      await this.reconcile(now).catch((err) => log.error('[schedules] reprise des exécutions orphelines', err));
      await this.archiveExpiredRuns(now).catch((err) => log.error('[schedules] archivage des sessions d’exécution', err));
      for (const due of await scheduleRepository.listDue(now)) {
        if (!due.nextRunAt) continue;
        let next: Date | null = null;
        try {
          next = nextRun(parseCron(due.cron), now, due.timezone);
        } catch (err) {
          log.error(`[schedules] expression invalide pour la session ${due.sessionId} : ${(err as Error).message}`);
        }
        // Réservation atomique : une seule instance du serveur exécute l'échéance.
        const claimed = await scheduleRepository.claim(due.sessionId, due.nextRunAt, next, now);
        if (!claimed) continue;
        if (now.getTime() - due.nextRunAt.getTime() > MISSED_GRACE_MS) {
          await this.recordMissed(due.sessionId, due.nextRunAt);
          continue;
        }
        await this.run(claimed, { scheduledFor: due.nextRunAt }).catch((err) => log.error('[schedules] exécution', err));
      }
    } finally {
      ticking = false;
    }
  },

  /** Échéance passée pendant un arrêt du serveur : notée « manquée » dans l'historique, non rattrapée. */
  async recordMissed(sessionId: string, scheduledFor: Date): Promise<void> {
    await scheduleRepository.createRun({ sessionId, trigger: 'schedule', status: 'missed', scheduledFor, message: 'Serveur arrêté à l’échéance, non rattrapée' });
    await scheduleRepository.setResult(sessionId, `Échéance du ${scheduledFor.toISOString()} manquée (serveur arrêté), non rattrapée`);
  },

  /**
   * Démarrage du serveur : les échéances manquées depuis plus de dix minutes sont recalculées (pas de
   * rattrapage en rafale), puis l'ordonnanceur vérifie les échéances toutes les trente secondes.
   */
  async start(): Promise<number> {
    const now = new Date();
    let skipped = 0;
    for (const s of await scheduleRepository.listEnabled()) {
      if (s.nextRunAt && now.getTime() - s.nextRunAt.getTime() <= MISSED_GRACE_MS) continue;
      try {
        await scheduleRepository.setNextRunAt(s.sessionId, nextRun(parseCron(s.cron), now, s.timezone));
        if (s.nextRunAt) {
          skipped += 1;
          await this.recordMissed(s.sessionId, s.nextRunAt);
        }
      } catch (err) {
        log.error(`[schedules] expression invalide pour la session ${s.sessionId} : ${(err as Error).message}`);
      }
    }
    timer = setInterval(() => void this.tick().catch((err) => log.error('[schedules] ordonnanceur', err)), TICK_MS);
    timer.unref?.();
    return skipped;
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
