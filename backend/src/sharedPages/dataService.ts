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
import { DATA_LIMITS, assertDataSize, countRows, normalizeSqlResult, parseRefreshMinutes, parseScriptOutput, parseSources, scriptCommand, type DataSource, type DataSourceInput, type ScriptSourceConfig, type SqlSourceConfig } from './dataSources.js';
import { sharedPageRepository } from './repository.js';
import { sharedPageService } from './service.js';
import type { SharedPage } from './types.js';

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

async function refreshOne(page: SharedPage, project: Project | null, source: DataSource, trigger: RefreshTrigger, memberOk: boolean): Promise<void> {
  const started = Date.now();
  try {
    if (!project) throw new SkippedError("Le projet d'origine de l'artefact n'existe plus");
    if (!memberOk) throw new SkippedError("Le propriétaire de l'artefact n'est plus membre du projet d'origine");
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
    await dataSourceRepository.replace(page.id, parseSources(inputs));
    return dataSourceRepository.list(page.id);
  },

  /** Règle l'intervalle du rafraîchissement automatique (null : à la demande). */
  async setRefresh(page: SharedPage, minutes: number | null | undefined): Promise<SharedPage> {
    if (page.kind !== 'data') throw new AppError("Seul un artefact de données se rafraîchit");
    return (await sharedPageRepository.update(page.id, { refreshMinutes: parseRefreshMinutes(minutes) })) ?? page;
  },

  /** Rafraîchit toutes les sources d'un artefact (en attendant un rafraîchissement déjà en cours plutôt que d'en lancer un second). */
  refresh(page: SharedPage, trigger: RefreshTrigger): Promise<DataSource[]> {
    const pending = locks.get(page.id);
    if (pending) return pending;
    const run = (async () => {
      const sources = await dataSourceRepository.list(page.id);
      await sharedPageRepository.markDataRefreshed(page.id);
      if (!sources.length) return sources;
      const project = page.projectId ? await projectService.get(page.projectId).catch(() => null) : null;
      const memberOk = project ? (await userService.memberRoleFor(page.ownerId, project.id)) !== null || Boolean((await userService.get(page.ownerId).catch(() => null))?.isAdmin) : false;
      for (const s of sources) await refreshOne(page, project, s, trigger, memberOk);
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
    await this.refresh(page, user.id === page.ownerId ? 'person' : 'auto');
    return sharedPageService.get(id);
  },

  sources: (pageId: string) => dataSourceRepository.list(pageId),
  sourcesWithData: (pageId: string) => dataSourceRepository.list(pageId, true),
  dataOf: (pageId: string) => dataSourceRepository.dataOf(pageId),

  /** Un passage du planificateur : les artefacts dont l'échéance est passée, l'un après l'autre. Renvoie leur nombre. */
  async sweep(): Promise<number> {
    const due = await sharedPageRepository.dueForRefresh(SCHEDULER_BATCH, DATA_LIMITS.idleDays);
    for (const page of due) {
      try {
        await this.refresh(page, 'auto');
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
