import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import { trackedPullRequestService } from './service.js';

/**
 * Synchronisation des PR suivies déclenchée par les outils des sessions : un `git push`, un `gh pr merge`, un appel
 * à l'API GitHub sur une PR ou un outil `tasks.pr_*` change l'état GitHub (relecture complète, forcée) ; une
 * modification de fichier, un commit ou un changement de branche ne change que le travail local (PR en préparation,
 * relecture locale seulement, sans appel à GitHub). Les appels sont regroupés par projet (attente de 3 s après le
 * dernier, 15 s au plus) pour qu'une rafale d'éditions ne lance qu'une relecture. L'onglet actif (watchPullRequests,
 * 10 s) affiche ensuite le résultat.
 */

export type PullRequestImpact = 'github' | 'local' | null;

const GIT_REMOTE = /\bgit\s+(?:-C\s+\S+\s+)?(?:push|fetch|pull)\b|\bgh\s+pr\b|\bgh\s+api\b[^\n]*\/pulls\b/;
const GIT_LOCAL = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|merge|rebase|reset|checkout|switch|cherry-pick|revert|am|stash|restore|rm|mv)\b/;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PR_TOOLS = new Set(['mcp__tasks__pr_open', 'mcp__tasks__pr_register', 'mcp__tasks__pr_update']);

/** Effet d'un appel d'outil sur les PR suivies : GitHub, travail local seulement, ou aucun. */
export function pullRequestImpact(name: string, input: Record<string, unknown>): PullRequestImpact {
  if (PR_TOOLS.has(name)) return 'github';
  if (FILE_TOOLS.has(name)) return 'local';
  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (GIT_REMOTE.test(command)) return 'github';
    if (GIT_LOCAL.test(command)) return 'local';
    return null;
  }
  if (name === 'mcp__vault__http_request') {
    const url = `${typeof input.url === 'string' ? input.url : ''} ${typeof input.path === 'string' ? input.path : ''}`;
    return /api\.github\.com|\/repos\//.test(url) && /\/pulls?\b|\/merges?\b|\/git\/refs\b/.test(url) ? 'github' : null;
  }
  return null;
}

/** Compte GitHub de la relecture : la personne qui a pris la main, sinon le propriétaire, sinon qui a demandé la session. */
export function toolSyncUser(session: { takenOverById?: string | null; ownerId?: string | null; requestedById?: string | null }): string | null {
  return session.takenOverById ?? session.ownerId ?? session.requestedById ?? null;
}

const DEBOUNCE_MS = 3_000;
const MAX_WAIT_MS = 15_000;

interface Pending {
  timer: NodeJS.Timeout;
  firstAt: number;
  impact: 'github' | 'local';
  userId: string | null;
}

const pending = new Map<string, Pending>();
const running = new Map<string, Promise<void>>();

async function run(projectId: string, impact: 'github' | 'local', userId: string | null): Promise<void> {
  if (impact === 'github') {
    await trackedPullRequestService.sync(projectId, userId, { force: true });
    return;
  }
  const project = await projectService.get(projectId).catch(() => null);
  if (project?.gitUrl) await trackedPullRequestService.refreshPending(project);
}

function fire(projectId: string): void {
  const p = pending.get(projectId);
  if (!p) return;
  pending.delete(projectId);
  const previous = running.get(projectId) ?? Promise.resolve();
  const next = previous
    .then(() => run(projectId, p.impact, p.userId))
    .catch((err) => log.error('[pull-requests] synchronisation après un outil', projectId, err))
    .finally(() => {
      if (running.get(projectId) === next) running.delete(projectId);
    });
  running.set(projectId, next);
}

/** Demande une relecture des PR du projet après un appel d'outil (regroupée, sans attendre). */
export function syncAfterTool(projectId: string, userId: string | null, name: string, input: Record<string, unknown>): void {
  const impact = pullRequestImpact(name, input);
  if (!impact) return;
  const now = Date.now();
  const p = pending.get(projectId);
  if (p) clearTimeout(p.timer);
  const firstAt = p?.firstAt ?? now;
  const merged: Pending = {
    firstAt,
    impact: p?.impact === 'github' || impact === 'github' ? 'github' : 'local',
    userId: userId ?? p?.userId ?? null,
    timer: setTimeout(() => fire(projectId), Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - now))),
  };
  merged.timer.unref?.();
  pending.set(projectId, merged);
}

/** Pour les tests : relectures en attente. */
export function pendingToolSyncs(): Map<string, { impact: 'github' | 'local'; userId: string | null }> {
  return new Map([...pending].map(([k, v]) => [k, { impact: v.impact, userId: v.userId }]));
}
