import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';

/**
 * Serveurs MCP qui n'ont pas démarré dans le CLI Claude (incident du 10/10/2026 : `tools/list` du serveur `vault`
 * échouait, l'agent n'avait aucun outil du coffre et rien ne le montrait). Le message `system` / `init` du SDK donne
 * le statut de chaque serveur et la liste des outils chargés ; un serveur « connecté » dont le CLI n'a pu lister
 * aucun outil (schéma refusé, « Failed to fetch tools ») est en échec lui aussi.
 */

/** Serveurs dont l'échec est déjà expliqué ailleurs (navigateur : diagnostic du conteneur). */
const HANDLED_ELSEWHERE = new Set(['playwright']);

/** Libellé des outils de chaque serveur de Skipper, pour un avis lisible. */
const LABELS: Record<string, string> = {
  vault: 'Outils du coffre',
  cockpit: 'Outils du cockpit (agencements des tableaux de bord)',
  tasks: 'Outils des tâches',
  context: 'Outils de la bibliothèque de contexte',
  sessions: 'Outils des sessions',
  worksessions: 'Outils des dossiers de travail',
  pages: 'Outils des pages partagées',
  google: 'Outils Google',
  env: "Outils des fichiers d'environnement",
  preview: "Outils de l'aperçu",
  agents: 'Outils des agents',
  conversations: 'Outils des conversations',
  projects: 'Outils des projets',
  chrome: 'Outils du navigateur Chrome',
};

export interface McpServerFailure {
  name: string;
  /** Statut rapporté par le CLI (`failed`, ou `connected` sans aucun outil listé). */
  status: string;
  /** Pourquoi : statut seul, ou outils impossibles à lister. */
  reason: string;
}

/** Serveurs en échec d'après le message d'init : statut `failed`, ou connecté sans un seul outil chargé. */
export function failedMcpServers(init: { mcp_servers?: { name: string; status: string }[]; tools?: string[] }): McpServerFailure[] {
  const tools = init.tools ?? [];
  const failures: McpServerFailure[] = [];
  for (const server of init.mcp_servers ?? []) {
    if (HANDLED_ELSEWHERE.has(server.name)) continue;
    if (server.status === 'failed') {
      failures.push({ name: server.name, status: server.status, reason: "n'a pas démarré" });
    } else if (server.status === 'connected') {
      const prefix = `mcp__${server.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
      if (!tools.some((t) => t.startsWith(prefix))) failures.push({ name: server.name, status: server.status, reason: "n'a fourni aucun outil (liste des outils impossible à obtenir)" });
    }
  }
  return failures;
}

/** Avis du fil de la session : « Outils du coffre indisponibles : le serveur vault n'a pas démarré (cause). » */
export function mcpFailureNotice(failure: McpServerFailure, detail: string | null): string {
  const label = LABELS[failure.name] ?? `Outils du serveur MCP ${failure.name}`;
  const cause = detail ? ` : ${detail}` : '';
  return `${label} indisponibles : le serveur ${failure.name} ${failure.reason}${cause}. L'agent n'a pas ces outils dans cette session ; une nouvelle session les rechargera une fois le problème corrigé.`;
}

/** Longueur maximale de la cause tirée du journal, pour garder l'avis lisible. */
const MAX_DETAIL = 500;

/**
 * Cause d'échec tirée d'un journal `mcp-logs-<serveur>/<date>.jsonl` du CLI (une entrée JSON par ligne,
 * `{ "error": "Failed to fetch tools: …", "timestamp": … }` ou `{ "debug": … }`) : la dernière ligne
 * « Failed to fetch tools », à défaut la dernière erreur.
 */
export function parseMcpLog(text: string): string | null {
  const errors: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { error?: unknown };
      if (typeof entry.error === 'string' && entry.error.trim()) errors.push(entry.error.trim());
    } catch {
      // Ligne tronquée (journal en cours d'écriture) : ignorée.
    }
  }
  const found = [...errors].reverse().find((e) => /failed to fetch tools/i.test(e)) ?? errors.at(-1) ?? null;
  if (!found) return null;
  const oneLine = found.replace(/\s+/g, ' ');
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL)}…` : oneLine;
}

/** Nom du dossier du CLI pour un répertoire de travail (`/a/b.c` → `-a-b-c`). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Dernier journal du serveur ($2) pour le dossier de travail encodé ($1) ; les 200 dernières lignes suffisent.
const READ_LOG = 'd="${XDG_CACHE_HOME:-$HOME/.cache}/claude-cli-nodejs/$1/mcp-logs-$2"; f=$(ls -1t "$d"/*.jsonl 2>/dev/null | head -n 1); [ -n "$f" ] && tail -n 200 "$f"';

/** Cause lue dans le journal du CLI, dans le conteneur du projet ; null si absent ou illisible. */
export async function readMcpLogDetail(project: Project, cwd: string, server: string): Promise<string | null> {
  try {
    const { stdout } = await runner.exec(project, ['sh', '-c', READ_LOG, 'sh', encodeCwd(cwd), server], { timeoutSeconds: 10 });
    return parseMcpLog(stdout);
  } catch {
    return null;
  }
}
