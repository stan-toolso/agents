import { AppError } from '../errors.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import { userService } from '../users/service.js';
import type { User } from '../users/types.js';
import * as postgres from '../vault/postgres.js';
import { vaultService } from '../vault/service.js';
import { dataSourceRepository } from './dataRepository.js';
import { DATA_LIMITS, assertDataSize, countRows, normalizeSqlResult, parseRefreshMinutes, parseScriptOutput, parseSources, scriptCommand, type AgentSourceConfig, type DataSource, type DataSourceInput, type ScriptSourceConfig, type SqlSourceConfig } from './dataSources.js';
import { sharedPageRepository } from './repository.js';
import { sharedPageService } from './service.js';
import { alertRepository } from './alertRepository.js';
import { alertService } from './alertService.js';
import { launchArtifactSession, sessionBusy } from './launch.js';
import type { SharedPage, SharedPageVersion } from './types.js';

/**
 * Sources d'une ancienne version (`version.sources`) rapprochées des sources actuelles : même nom, même type, même
 * définition → la source actuelle (état, données) ; sinon une source `inactive`. Sans définition gardée : les actuelles.
 */
export function sourcesOfVersion(pageId: string, version: SharedPageVersion, live: DataSource[]): DataSource[] {
  if (!version.sources) return live;
  return version.sources.map((def, position) => {
    const same = live.find((s) => s.name === def.name && s.kind === def.kind && JSON.stringify(s.config) === JSON.stringify(def.config));
    if (same) return same;
    return {
      id: `${pageId}:v${version.version}:${def.name}`,
      pageId,
      name: def.name,
      kind: def.kind,
      config: def.config as unknown as DataSource['config'],
      position,
      data: null,
      rowCount: null,
      status: 'inactive',
      error: null,
      durationMs: null,
      refreshedAt: null,
      attemptedAt: null,
    };
  });
}

/**
 * Rafraîchissement des artefacts « Données » : chaque source est exécutée au nom du propriétaire de l'artefact, dans
 * le projet d'origine (portée du coffre et environnement Docker de ce projet). Les sources tournent l'une après
 * l'autre ; un artefact n'est jamais rafraîchi deux fois en même temps (verrou en mémoire : les appels concurrents
 * attendent le rafraîchissement en cours). Une source en échec garde ses dernières données réussies.
 *
 * Qui déclenche :
 * - `person` : le propriétaire (bouton « Rafraîchir », outil d'un agent piloté par lui) ; les éléments du coffre
 *   « soumis à approbation » sont utilisés (c'est lui qui le demande, dans sa portée).
 * - `auto` : le planificateur ou une session sans personne ; les éléments soumis à approbation sont sautés
 *   (`skipped`) : rien n'y touche sans un humain.
 */
export type RefreshTrigger = 'person' | 'auto';

/**
 * `agents` : lancer aussi les sessions des sources agent. Seuls le planificateur et le bouton Rafraîchir le font ; la
 * publication et l'outil pages.refresh viennent d'une session qui écrit elle-même ses données (pages.set_data).
 */
export interface RefreshOptions {
  agents?: boolean;
}

/** Délai au-delà duquel une session de source agent qui n'a rien écrit est tenue pour perdue. */
const AGENT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Une tentative par minute au plus ; dix artefacts par passage (les autres au suivant). */
const SCHEDULER_INTERVAL_MS = 60_000;
const SCHEDULER_BATCH = 10;

const locks = new Map<string, Promise<DataSource[]>>();

/** Dossier (dans le /tmp du conteneur, hors des volumes du code) où tourne le script d'une source. */
const scriptDir = (source: Pick<DataSource, 'id'>) => `/tmp/skipper-data/${source.id}`;

async function runSql(page: SharedPage, project: Project, source: DataSource, trigger: RefreshTrigger): Promise<{ data: unknown; note: string }> {
  const cfg = source.config as SqlSourceConfig;
  const item = await vaultService.agentItemByName(project.id, page.ownerId, cfg.item);
  if (item.kind !== 'postgres') throw new AppError(`« ${item.name} » n'est pas une base PostgreSQL`);
  if (item.requireApproval && trigger !== 'person') throw new SkippedError(`« ${item.name} » est soumis à approbation : pas de rafraîchissement automatique ; le propriétaire peut rafraîchir depuis l'artefact`);
  const actor = { userId: page.ownerId, projectId: project.id };
  const summary = `[artefact ${page.title}] ${cfg.database ? `[${cfg.database}] ` : ''}${cfg.query}`;
  try {
    const creds = await vaultService.postgresCredentials(item, cfg.database);
    // Toujours en lecture seule, quel que soit le réglage de l'élément : un artefact ne modifie jamais une base.
    const r = await postgres.query(creds, cfg.query, true, DATA_LIMITS.sqlRows);
    if (creds.via) await vaultService.rememberHostKey(creds.via.item, r.sshHostKey);
    const st = r.statements[0];
    if (!st) throw new AppError('La requête n’a rien renvoyé');
    const data = normalizeSqlResult(st.fields, st.rows);
    await vaultService.audit(item, 'used', actor, `data_refresh : ${summary}`);
    return { data, note: `${st.rowCount ?? data.rows.length} ligne(s)${st.truncated ? ` (tronqué à ${DATA_LIMITS.sqlRows})` : ''}` };
  } catch (err) {
    if (!(err instanceof SkippedError)) await vaultService.audit(item, 'used', actor, `data_refresh : ${summary} — ${(err as Error).message}`, false);
    throw err;
  }
}

async function runScript(project: Project, source: DataSource): Promise<{ data: unknown; note: string }> {
  const cfg = source.config as ScriptSourceConfig;
  const { file, command } = scriptCommand(cfg.interpreter);
  const dir = scriptDir(source);
  await runner.putFile(project, `${dir}/${file}`, cfg.code);
  try {
    const { stdout, code } = await runner.exec(project, command, { cwd: dir, timeoutSeconds: cfg.timeoutSeconds });
    if (code === 124) throw new AppError(`Le script a dépassé ${cfg.timeoutSeconds} s`);
    if (code !== 0) throw new AppError(`Le script a échoué (code ${code})${stdout.trim() ? ` : ${stdout.trim().slice(-500)}` : ''}`);
    const data = parseScriptOutput(stdout);
    return { data, note: `${countRows(data) ?? '?'} élément(s)` };
  } finally {
    await runner.removePath(project, dir).catch(() => undefined);
  }
}

class SkippedError extends Error {}

/** Texte envoyé à la session qui calcule une source agent : la consigne, puis comment rendre le résultat. */
export function agentSourceInstruction(page: Pick<SharedPage, 'id' | 'title'>, source: Pick<DataSource, 'name'>, cfg: AgentSourceConfig, previous: unknown): string {
  const prev = previous == null ? 'aucune (première fois)' : JSON.stringify(previous).slice(0, 4000);
  return [
    `Rafraîchissement de la source « ${source.name} » de l'artefact de données « ${page.title} » (${page.id}).`,
    '',
    cfg.prompt,
    '',
    `Quand tu as le résultat, écris-le avec l'outil \`pages.set_data\` (page_id: "${page.id}", source: "${source.name}", data: le JSON). ` +
      "Garde la même forme que les données précédentes : la page les lit telles quelles dans Skipper.data. Ne republie pas la page (pas de pages.publish) et ne modifie pas le dépôt. " +
      "Si tu ne peux pas calculer le résultat, explique pourquoi dans ta réponse sans appeler pages.set_data : les données précédentes restent affichées.",
    '',
    `Données précédentes : ${prev}`,
  ].join('\n');
}

/**
 * Source agent : lance une session (au nom de l'agent choisi, sinon du propriétaire de l'artefact) chargée de calculer
 * la source et de l'écrire avec pages.set_data. Une session encore au travail sur la source n'est pas doublée ; une
 * session terminée sans rien écrire passe la source en erreur avant d'en lancer une nouvelle.
 */
async function launchAgentSource(page: SharedPage, project: Project, source: DataSource): Promise<void> {
  const cfg = source.config as AgentSourceConfig;
  // Imports à la demande : sessions et agents dépendent eux-mêmes des pages partagées (outils MCP).
  const { sessionRepository } = await import('../sessions/repository.js');
  if (source.status === 'running' && source.sessionId) {
    const current = await sessionRepository.findById(source.sessionId);
    if (sessionBusy(current)) {
      log.info(`[artifacts] ${page.title} · ${source.name} : session ${source.sessionId} encore au travail, pas de nouvelle session`);
      return;
    }
  }
  const previous = (await dataSourceRepository.list(page.id, true)).find((s) => s.id === source.id)?.data ?? null;
  const text = agentSourceInstruction(page, source, cfg, previous);
  const sessionId = await launchArtifactSession(page, project, { agent: cfg.agent, text, name: `Données · ${page.title} · ${source.name}` });
  await dataSourceRepository.markRunning(source.id, sessionId);
  log.info(`[artifacts] ${page.title} · ${source.name} : session ${sessionId} lancée`);
  // Suivi : une session qui s'arrête sans avoir écrit la source la passe en erreur (les données précédentes restent).
  const { sessionService } = await import('../sessions/service.js');
  void (async () => {
    try {
      await sessionService.waitForIdle(sessionId, AGENT_RUN_TIMEOUT_MS);
      const now = (await dataSourceRepository.list(page.id)).find((s) => s.id === source.id);
      if (now?.status === 'running' && now.sessionId === sessionId) {
        await dataSourceRepository.saveFailure(source.id, 'error', `La session ${sessionId} a fini son tour sans écrire les données (pages.set_data)`, null);
        await alertService.evaluate(page, [source.name], project);
      }
    } catch (err) {
      log.warn(`[artifacts] suivi de la session ${sessionId} : ${(err as Error).message}`);
    }
  })();
}

async function refreshOne(page: SharedPage, project: Project | null, source: DataSource, trigger: RefreshTrigger, memberOk: boolean, opts: RefreshOptions): Promise<void> {
  // Source graphql : vivante, exécutée à la lecture aux droits de la personne qui regarde (cockpit/liveSources.ts) ; rien à rafraîchir.
  if (source.kind === 'graphql') return;
  // Source agent : écrite par une session (pages.set_data) ; lancée seulement par le planificateur ou le bouton Rafraîchir.
  if (source.kind === 'agent' && !opts.agents) return;
  const started = Date.now();
  try {
    if (!project) throw new SkippedError("Le projet d'origine de l'artefact n'existe plus");
    if (!memberOk) throw new SkippedError("Le propriétaire de l'artefact n'est plus membre du projet d'origine");
    if (source.kind === 'agent') {
      await launchAgentSource(page, project, source);
      return;
    }
    const { data, note } = source.kind === 'sql' ? await runSql(page, project, source, trigger) : await runScript(project, source);
    assertDataSize(data);
    await dataSourceRepository.saveSuccess(source.id, data, countRows(data), Date.now() - started);
    log.info(`[artifacts] ${page.title} · ${source.name} rafraîchie (${note}, ${Date.now() - started} ms)`);
  } catch (err) {
    const skipped = err instanceof SkippedError;
    await dataSourceRepository.saveFailure(source.id, skipped ? 'skipped' : 'error', (err as Error).message, Date.now() - started);
    log.warn(`[artifacts] ${page.title} · ${source.name} ${skipped ? 'sautée' : 'en erreur'} : ${(err as Error).message}`);
  }
}

export const artifactDataService = {
  /** Définit (remplace) les sources d'un artefact de données ; sans rafraîchir. */
  async setSources(page: SharedPage, inputs: DataSourceInput[]): Promise<DataSource[]> {
    if (page.kind !== 'data') throw new AppError("Cet artefact n'est pas un artefact de données (publie-le avec kind: data)");
    if (!page.projectId) throw new AppError("Un artefact de données doit être rattaché à un projet (c'est celui de la session qui le publie)");
    const parsed = parseSources(inputs);
    if (page.refreshMinutes && parsed.some((s) => s.kind === 'agent')) parseRefreshMinutes(page.refreshMinutes, true);
    await dataSourceRepository.replace(page.id, parsed);
    // Une alerte dont la source disparaît (ou devient vivante) n'a plus rien à évaluer.
    await alertRepository.pruneMissingSources(page.id);
    // La dernière version garde la définition de ses sources (versionnage complet des artefacts).
    await sharedPageRepository.snapshotLatest(page.id);
    return dataSourceRepository.list(page.id);
  },

  /** Règle l'intervalle du rafraîchissement automatique (null : à la demande). */
  async setRefresh(page: SharedPage, minutes: number | null | undefined, withAgentSources?: boolean): Promise<SharedPage> {
    if (page.kind !== 'data') throw new AppError("Seul un artefact de données se rafraîchit");
    // Minimum d'une heure avec une source agent (`withAgentSources` : les sources sur le point d'être déclarées).
    const withAgent = withAgentSources ?? (await dataSourceRepository.list(page.id)).some((s) => s.kind === 'agent');
    const updated = (await sharedPageRepository.update(page.id, { refreshMinutes: parseRefreshMinutes(minutes, withAgent) })) ?? page;
    await sharedPageRepository.snapshotLatest(page.id);
    return updated;
  },

  /** Rafraîchit toutes les sources d'un artefact (en attendant un rafraîchissement déjà en cours plutôt que d'en lancer un second). */
  refresh(page: SharedPage, trigger: RefreshTrigger, opts: RefreshOptions = {}): Promise<DataSource[]> {
    const pending = locks.get(page.id);
    if (pending) return pending;
    const run = (async () => {
      const sources = await dataSourceRepository.list(page.id);
      await sharedPageRepository.markDataRefreshed(page.id);
      if (!sources.length) return sources;
      const project = page.projectId ? await projectService.get(page.projectId).catch(() => null) : null;
      const memberOk = project ? (await userService.memberRoleFor(page.ownerId, project.id)) !== null || Boolean((await userService.get(page.ownerId).catch(() => null))?.isAdmin) : false;
      for (const s of sources) await refreshOne(page, project, s, trigger, memberOk, opts);
      // Alertes des sources qui viennent d'être exécutées (sql, script) : évaluées sur leur nouvel état, actions au franchissement.
      const ran = sources.filter((s) => s.kind === 'sql' || s.kind === 'script').map((s) => s.name);
      if (ran.length) await alertService.evaluate(page, ran, project);
      return dataSourceRepository.list(page.id);
    })().finally(() => {
      if (locks.get(page.id) === run) locks.delete(page.id);
    });
    locks.set(page.id, run);
    return run;
  },

  /** Rafraîchissement demandé par une personne : le propriétaire de l'artefact (ou un admin de Skipper qui le voit). */
  async refreshFor(user: User, id: string): Promise<SharedPage> {
    const page = await sharedPageService.getManaged(user, id);
    if (page.kind !== 'data') throw new AppError("Cet artefact n'a pas de données à rafraîchir");
    await this.refresh(page, user.id === page.ownerId ? 'person' : 'auto', { agents: true });
    return sharedPageService.get(id);
  },

  /**
   * Données d'une source agent écrites par une session (outil pages.set_data). Permis à une session du propriétaire de
   * l'artefact, ou à la session lancée pour calculer cette source (agent du projet).
   */
  async setAgentData(page: SharedPage, sourceName: string, data: unknown, session: { id: string; ownerId: string | null }): Promise<DataSource> {
    if (page.kind !== 'data') throw new AppError("Cet artefact n'a pas de sources de données");
    const all = await dataSourceRepository.list(page.id);
    const source = all.find((s) => s.name === sourceName);
    if (!source) throw new AppError(`Source « ${sourceName} » introuvable (${all.map((s) => s.name).join(', ') || 'aucune source'})`);
    if (source.kind !== 'agent') throw new AppError(`La source « ${sourceName} » est de type ${source.kind} : Skipper la calcule lui-même ; seule une source agent s'écrit avec pages.set_data`);
    const allowed = (session.ownerId && session.ownerId === page.ownerId) || source.sessionId === session.id;
    if (!allowed) throw new AppError("Seules une session du propriétaire de l'artefact ou la session lancée pour cette source peuvent écrire ses données");
    assertDataSize(data);
    await dataSourceRepository.saveAgentData(source.id, data, countRows(data));
    // Date des données de l'artefact : les cadres (page, tuiles du cockpit) se rechargent sur elle.
    await sharedPageRepository.markDataRefreshed(page.id);
    log.info(`[artifacts] ${page.title} · ${source.name} écrite par la session ${session.id}`);
    await alertService.evaluate(page, [source.name]);
    return (await dataSourceRepository.list(page.id)).find((s) => s.id === source.id) ?? source;
  },

  sources: (pageId: string) => dataSourceRepository.list(pageId),

  /**
   * Sources telles qu'à une version de l'artefact (avec leurs données si `withData`) : la dernière version, ou une
   * version qui n'a pas gardé ses sources (publiée avant le versionnage complet), reçoit les sources actuelles ; une
   * ancienne version reçoit sa propre définition, avec l'état et les données actuels des sources inchangées depuis, les
   * autres étant `inactive` (plus rafraîchies, sans données).
   */
  async sourcesAt(page: SharedPage, version: number | null | undefined, withData = false): Promise<DataSource[]> {
    const live = await dataSourceRepository.list(page.id, withData);
    if (!version || version === page.version) return live;
    const v = await sharedPageRepository.version(page.id, version);
    return v ? sourcesOfVersion(page.id, v, live) : live;
  },
  sourcesWithData: (pageId: string) => dataSourceRepository.list(pageId, true),
  dataOf: (pageId: string) => dataSourceRepository.dataOf(pageId),

  /** Un passage du planificateur : les artefacts dont l'échéance est passée, l'un après l'autre. Renvoie leur nombre. */
  async sweep(): Promise<number> {
    const due = await sharedPageRepository.dueForRefresh(SCHEDULER_BATCH, DATA_LIMITS.idleDays);
    for (const page of due) {
      try {
        await this.refresh(page, 'auto', { agents: true });
      } catch (err) {
        log.error(`[artifacts] rafraîchissement de ${page.title}`, err);
      }
    }
    return due.length;
  },

  /** Planificateur (tâche de l'instance meneuse, voir instances/leadership.ts). */
  start(): void {
    this.stop();
    timer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      void this.sweep()
        .catch((err) => log.error('[artifacts] planificateur', err))
        .finally(() => {
          sweeping = false;
        });
    }, SCHEDULER_INTERVAL_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

let timer: NodeJS.Timeout | null = null;
let sweeping = false;
