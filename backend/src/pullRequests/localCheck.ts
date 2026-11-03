import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';

/** Contrôle local d'une branche avant d'ouvrir sa pull request, versionné dans le dépôt (chaque branche peut avoir le sien). */
export const LOCAL_CHECK_FILE = '.skipper/ci.json';

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;
/** Fin du journal gardée dans le message de refus. */
const LOG_TAIL_CHARS = 6000;

export interface LocalCheckConfig {
  /** Commande shell, lancée à la racine du dossier de travail dans l'environnement du projet (ex. `npm run ci`). */
  command: string;
  timeoutSeconds: number;
}

export type LocalCheckResult =
  | { status: 'none' }
  | { status: 'config_error'; error: string }
  | { status: 'passed'; seconds: number; command: string }
  | { status: 'failed'; seconds: number; command: string; code: number; timedOut: boolean; log: string };

/** Lit `.skipper/ci.json` : `{ "command": "npm run ci", "timeout": 600 }` (secondes). */
export function parseLocalCheckConfig(text: string): LocalCheckConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${LOCAL_CHECK_FILE} n'est pas un JSON valide : ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${LOCAL_CHECK_FILE} doit contenir un objet`);
  const o = raw as Record<string, unknown>;
  if (typeof o.command !== 'string' || !o.command.trim()) throw new Error(`${LOCAL_CHECK_FILE} : « command » (commande du contrôle) est obligatoire`);
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (o.timeout !== undefined) {
    if (typeof o.timeout !== 'number' || !Number.isFinite(o.timeout) || o.timeout < 10 || o.timeout > MAX_TIMEOUT_SECONDS) throw new Error(`${LOCAL_CHECK_FILE} : « timeout » est un nombre de secondes entre 10 et ${MAX_TIMEOUT_SECONDS}`);
    timeoutSeconds = Math.round(o.timeout);
  }
  return { command: o.command.trim(), timeoutSeconds };
}

/**
 * Lance le contrôle du projet dans le dossier de travail (environnement Docker du projet, dépendances déjà là).
 * Sans `.skipper/ci.json`, rien n'est contrôlé : la garde est une option du dépôt. Un fichier invalide est une
 * erreur de configuration, pas un échec du code (l'appelant décide).
 */
export const localCheck = {
  async run(project: Project, dir: string): Promise<LocalCheckResult> {
    let text: string;
    try {
      text = await readFile(path.join(dir, LOCAL_CHECK_FILE), 'utf8');
    } catch {
      return { status: 'none' };
    }
    let config: LocalCheckConfig;
    try {
      config = parseLocalCheckConfig(text);
    } catch (err) {
      return { status: 'config_error', error: (err as Error).message };
    }
    await runner.ensureReady(project);
    const started = Date.now();
    const { stdout, code } = await runner.exec(project, ['sh', '-c', config.command], { cwd: dir, timeoutSeconds: config.timeoutSeconds, output: true });
    const seconds = Math.round((Date.now() - started) / 1000);
    if (code === 0) return { status: 'passed', seconds, command: config.command };
    return { status: 'failed', seconds, command: config.command, code, timedOut: code === 124, log: stdout.length > LOG_TAIL_CHARS ? `…${stdout.slice(-LOG_TAIL_CHARS)}` : stdout };
  },
};

/** Message de refus de `pr_open` quand le contrôle échoue ou ne peut pas tourner ; null s'il n'y a rien à dire. */
export function localCheckRefusal(r: LocalCheckResult): string | null {
  if (r.status === 'failed') {
    const why = r.timedOut ? `dépassé le délai de ${r.seconds} s` : `échoué (code ${r.code}, ${r.seconds} s)`;
    return `Le contrôle local (${r.command}, voir ${LOCAL_CHECK_FILE}) a ${why} : la pull request n'est pas ouverte. Corrige, commite, puis rappelle pr_open. Si une personne te demande explicitement d'ouvrir la PR malgré l'échec, rappelle pr_open avec force: true (sinon n'utilise jamais force).\n\n${r.log.trimEnd()}`;
  }
  if (r.status === 'config_error') return `${r.error} : corrige-le, ou rappelle pr_open avec force: true si une personne te demande d'ouvrir la PR sans ce contrôle.`;
  return null;
}
