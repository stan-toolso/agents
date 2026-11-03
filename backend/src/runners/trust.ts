/**
 * Confiance (« trust ») de Claude Code dans les dossiers de travail d'un projet.
 *
 * Le CLI ignore les `permissions.allow` (et le reste des réglages sensibles) d'un `.claude/settings.json` tant que
 * le dossier n'est pas « trusted », c'est-à-dire tant que `projects[<dossier>].hasTrustDialogAccepted` n'est pas
 * vrai dans son fichier de configuration globale (`$CLAUDE_CONFIG_DIR/.claude.json`, sinon `~/.claude.json`).
 * En mode non interactif, personne n'accepte jamais le dialogue : Skipper inscrit la confiance lui-même.
 *
 * Seul le chemin exact compte : un dossier parent marqué « trusted » ne couvre pas ses sous-dossiers (constaté
 * avec Claude Code 2.1.316 le 03/11/2026). On inscrit donc chaque dossier de travail (checkout principal,
 * worktrees) et, avant chaque lancement, le dossier de la session.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';

/** Fichier de configuration globale du CLI dans un dossier de configuration (`CLAUDE_CONFIG_DIR`). */
export function claudeConfigFile(configDir: string): string {
  return path.join(configDir, '.claude.json');
}

/**
 * Configuration avec `hasTrustDialogAccepted: true` pour chacun des dossiers, le reste intact ; null quand
 * rien n'est à changer (tous déjà « trusted »).
 */
export function withTrustedDirectories(current: Record<string, unknown>, dirs: string[]): Record<string, unknown> | null {
  const projects = current.projects && typeof current.projects === 'object' && !Array.isArray(current.projects) ? (current.projects as Record<string, unknown>) : {};
  const missing = [...new Set(dirs.map((d) => path.resolve(d)))].filter((dir) => {
    const entry = projects[dir] as { hasTrustDialogAccepted?: unknown } | undefined;
    return !(entry && typeof entry === 'object' && entry.hasTrustDialogAccepted === true);
  });
  if (!missing.length) return null;
  const next: Record<string, unknown> = { ...projects };
  for (const dir of missing) {
    const entry = projects[dir];
    next[dir] = { ...(entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}), hasTrustDialogAccepted: true };
  }
  return { ...current, projects: next };
}

/** Écritures en cours par fichier : deux lancements simultanés du même projet ne se marchent pas dessus. */
const queues = new Map<string, Promise<void>>();

/**
 * Marque les dossiers comme « trusted » dans `file` : lecture, fusion, écriture atomique (fichier temporaire
 * puis renommage), sans toucher au reste. Fichier absent : créé. Fichier illisible (JSON invalide, en cours
 * d'écriture par le CLI) : laissé tel quel, on ne risque pas d'écraser la configuration ; la session démarre
 * alors sans la confiance, et le prochain lancement réessaie. N'échoue jamais.
 */
export function trustDirectories(file: string, dirs: string[]): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const run = previous.then(() => writeTrust(file, dirs)).catch((err) => log.error(`[runner] confiance Claude Code (${file})`, err));
  queues.set(file, run);
  void run.finally(() => {
    if (queues.get(file) === run) queues.delete(file);
  });
  return run;
}

async function writeTrust(file: string, dirs: string[]): Promise<void> {
  if (!dirs.length) return;
  let current: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw !== null && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('pas un objet');
      current = parsed as Record<string, unknown>;
    } catch (err) {
      log.warn(`[runner] ${file} illisible, confiance non inscrite : ${(err as Error).message}`);
      return;
    }
  }
  const next = withTrustedDirectories(current, dirs);
  if (!next) return;
  const tmp = `${file}.skipper-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
