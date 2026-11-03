import type { PullRequestCheck } from './pullRequests.js';

/** CI d'un commit ou d'une branche (GitHub) : état agrégé des checks de son dernier commit. */
export interface CiStatus {
  /** Branche ou commit demandé. */
  ref: string;
  /** Commit résolu. */
  sha: string;
  /** SUCCESS, FAILURE, PENDING, ERROR, EXPECTED, ou null (aucun check sur ce commit, ou pas encore). */
  state: string | null;
  checks: PullRequestCheck[];
}

/** Verdict d'un état de CI : vert, rouge, en cours, ou sans check. */
export type CiVerdict = 'success' | 'failure' | 'pending' | 'none';
export function ciVerdict(state: string | null | undefined, checks: Pick<PullRequestCheck, 'state'>[] = []): CiVerdict {
  if (!state) return checks.length ? 'pending' : 'none';
  if (state === 'SUCCESS') return 'success';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'failure';
}

/** Une ligne lisible de l'état de la CI (outil `ci_status`, étapes des livraisons). */
export function describeCi(ci: Pick<CiStatus, 'state' | 'checks'>): string {
  const verdict = ciVerdict(ci.state, ci.checks);
  const label = { success: 'verte', failure: 'rouge', pending: 'en cours', none: 'aucun check' }[verdict];
  const failing = ci.checks.filter((c) => c.state === 'FAILURE').map((c) => c.name);
  const pending = ci.checks.filter((c) => c.state === 'PENDING').map((c) => c.name);
  return [`CI ${label}`, failing.length ? `en échec : ${failing.join(', ')}` : '', pending.length ? `en cours : ${pending.join(', ')}` : ''].filter(Boolean).join(' · ');
}

