import { AppError } from '../errors.js';
import { gitlabFetch } from '../settings/gitlab.js';
import type { MergeMethod, PullRequest, PullRequestCheck, PullRequestFilter, PullRequestReview } from './pullRequests.js';

/**
 * Merge requests GitLab (API v4, `/projects/:id/merge_requests`), au format des pull requests de Skipper (celui de
 * GitHub) : liste, détail (pipeline du dernier commit et ses jobs, approbations), création, fusion, suppression de la
 * branche source, commentaire. Toutes les requêtes portent le jeton du compte GitLab de la personne qui agit.
 * `PullRequest.number` est l'`iid` de la MR (numéro dans le projet, « !12 ») et `PullRequest.repo` le chemin complet
 * du projet (« groupe/sous-groupe/projet »).
 */

/** Projet GitLab visé : instance, chemin complet et jeton de la personne. */
export interface GitlabTarget {
  host: string;
  path: string;
  token: string;
}

interface GlUser {
  username: string;
  avatar_url?: string | null;
}

export interface GlMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  author: GlUser | null;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  has_conflicts?: boolean;
  detailed_merge_status?: string | null;
  merge_status?: string | null;
  sha?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  changes_count?: string | null;
  head_pipeline?: { id: number; status: string; web_url?: string | null } | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
}

interface GlJob {
  name: string;
  status: string;
  allow_failure?: boolean;
  web_url?: string | null;
}

interface GlApprovals {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: Array<{ user: GlUser }>;
}

/** Erreur de l'API GitLab, avec son code HTTP. */
export class GitlabApiError extends AppError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(host: string, status: number, body: unknown): string {
  const b = body as { message?: unknown; error?: string; error_description?: string } | null;
  const raw = b?.message ?? b?.error_description ?? b?.error;
  const msg = Array.isArray(raw) ? raw.join(' ; ') : raw && typeof raw === 'object' ? Object.entries(raw).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' ; ') : (raw as string | undefined);
  if (status === 401) return `GitLab (${host}) refuse le jeton (invalide, expiré ou révoqué)`;
  if (status === 403 || status === 404) return `GitLab (${host}) : accès refusé ou projet introuvable${msg ? ` (${msg})` : ''}. Le jeton doit avoir la portée « api ».`;
  return `GitLab (${host}, ${status}) : ${msg || 'erreur inconnue'}`;
}

export async function gitlabApi<T>(t: Pick<GitlabTarget, 'host' | 'token'>, method: string, apiPath: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await gitlabFetch(t.host, `/api/v4${apiPath}`, { method, token: t.token, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new AppError(`GitLab (${t.host}) injoignable : ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new GitlabApiError(res.status, errorMessage(t.host, res.status, data));
  return data as T;
}

const projectPath = (t: GitlabTarget) => `/projects/${encodeURIComponent(t.path)}`;
const mrPath = (t: GitlabTarget, iid: number) => `${projectPath(t)}/merge_requests/${iid}`;

/** État d'un pipeline GitLab au vocabulaire de Skipper (celui du rollup des checks GitHub). */
export function pipelineState(status: string | null | undefined): string | null {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
      return 'FAILURE';
    case 'canceled':
    case 'canceling':
      return 'ERROR';
    case 'created':
    case 'waiting_for_resource':
    case 'waiting_for_callback':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
    case 'manual':
      return 'PENDING';
    default:
      // skipped, ou pas de pipeline.
      return null;
  }
}

/** État d'un job au vocabulaire des checks de Skipper : SUCCESS, FAILURE, PENDING, NEUTRAL, SKIPPED. */
export function jobState(job: Pick<GlJob, 'status' | 'allow_failure'>): string {
  switch (job.status) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
      return job.allow_failure ? 'NEUTRAL' : 'FAILURE';
    case 'canceled':
    case 'canceling':
      return 'FAILURE';
    case 'skipped':
      return 'SKIPPED';
    case 'manual':
      return 'NEUTRAL';
    default:
      return 'PENDING';
  }
}

/** Décision de revue d'après les approbations : approuvée, approbation encore requise, ou rien d'exigé. */
export function approvalDecision(a: GlApprovals | null, detailedStatus?: string | null): string | null {
  if (detailedStatus === 'requested_changes') return 'CHANGES_REQUESTED';
  if (!a) return null;
  if ((a.approvals_left ?? 0) > 0) return 'REVIEW_REQUIRED';
  return (a.approved_by ?? []).length ? 'APPROVED' : null;
}

/** Statuts de fusion où GitLab n'a pas encore fini de calculer. */
const CHECKING = new Set(['unchecked', 'checking', 'preparing', 'approvals_syncing']);

export interface GitlabDetails {
  jobs?: GlJob[];
  approvals?: GlApprovals | null;
  commitCount?: number;
  diffStats?: { additions: number; deletions: number; files: number } | null;
}

/** MR GitLab au format des PR de Skipper ; `details` : jobs du pipeline, approbations, commits et diff (MR ouvertes, détail). */
export function toPullRequest(projectId: string, repo: string, mr: GlMergeRequest, details: GitlabDetails = {}): PullRequest {
  const state = mr.state === 'merged' ? 'MERGED' : mr.state === 'opened' ? 'OPEN' : 'CLOSED';
  const isDraft = Boolean(mr.draft ?? mr.work_in_progress) || /^(draft:|\[draft\]|\(draft\)|wip:|\[wip\])/i.test(mr.title.trim());
  const detailed = mr.detailed_merge_status ?? null;
  const conflicts = Boolean(mr.has_conflicts) || detailed === 'conflict' || detailed === 'broken_status' || mr.merge_status === 'cannot_be_merged';
  const checksState = pipelineState(mr.head_pipeline?.status);
  const reviewDecision = approvalDecision(details.approvals ?? null, detailed);
  const mergeable = state !== 'OPEN' ? 'UNKNOWN' : conflicts ? 'CONFLICTING' : detailed && CHECKING.has(detailed) ? 'UNKNOWN' : 'MERGEABLE';
  let mergeStateStatus = 'UNKNOWN';
  if (state === 'OPEN') {
    if (isDraft) mergeStateStatus = 'DRAFT';
    else if (conflicts) mergeStateStatus = 'DIRTY';
    else if (detailed === 'need_rebase') mergeStateStatus = 'BEHIND';
    else if (checksState === 'FAILURE' || checksState === 'ERROR') mergeStateStatus = 'UNSTABLE';
    else if (detailed && ['not_approved', 'discussions_not_resolved', 'blocked_status', 'ci_must_pass', 'ci_still_running', 'requested_changes', 'jira_association_missing', 'external_status_checks', 'security_policy_violations', 'locked_paths', 'locked_lfs_files', 'merge_time'].includes(detailed)) mergeStateStatus = 'BLOCKED';
    else if (detailed === 'mergeable' || detailed == null) mergeStateStatus = 'CLEAN';
  }
  const checks: PullRequestCheck[] = (details.jobs ?? []).map((j) => ({ name: j.name, state: jobState(j), url: j.web_url ?? null }));
  if (!checks.length && mr.head_pipeline) checks.push({ name: `pipeline #${mr.head_pipeline.id}`, state: checksState ?? 'SKIPPED', url: mr.head_pipeline.web_url ?? null });
  const reviews: PullRequestReview[] = (details.approvals?.approved_by ?? []).map((a) => ({ author: a.user.username, state: 'APPROVED' }));
  const changes = Number.parseInt(mr.changes_count ?? '', 10);
  return {
    projectId,
    repo,
    number: mr.iid,
    title: mr.title,
    body: mr.description ?? '',
    url: mr.web_url,
    state,
    isDraft,
    author: mr.author?.username ?? null,
    authorAvatarUrl: mr.author?.avatar_url ?? null,
    headRefName: mr.source_branch,
    baseRefName: mr.target_branch,
    isCrossRepository: mr.source_project_id !== mr.target_project_id,
    mergeable,
    mergeStateStatus,
    reviewDecision,
    checksState,
    checks,
    reviews,
    additions: details.diffStats?.additions ?? 0,
    deletions: details.diffStats?.deletions ?? 0,
    changedFiles: details.diffStats?.files ?? (Number.isFinite(changes) ? changes : 0),
    commitCount: details.commitCount ?? 0,
    createdAt: new Date(mr.created_at),
    updatedAt: new Date(mr.updated_at),
    mergedAt: mr.merged_at ? new Date(mr.merged_at) : null,
    closedAt: mr.closed_at ? new Date(mr.closed_at) : null,
    forge: 'gitlab',
  };
}

/** Lignes ajoutées et retirées d'un diff unifié. */
export function diffLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/**
 * MR lue en détail (la liste ne donne ni pipeline ni nombre de fichiers) : pipeline et ses jobs, approbations ; avec
 * `full` (fenêtre de détail), commits et lignes modifiées en plus. Une MR fermée ou fusionnée n'est pas détaillée.
 */
async function withDetails(projectId: string, t: GitlabTarget, listed: GlMergeRequest, full = false): Promise<PullRequest> {
  if (listed.state !== 'opened' && !full) return toPullRequest(projectId, t.path, listed);
  const mr = listed.head_pipeline !== undefined ? listed : await gitlabApi<GlMergeRequest>(t, 'GET', mrPath(t, listed.iid)).catch(() => listed);
  const open = mr.state === 'opened';
  const [jobs, approvals, commits, diffs] = await Promise.all([
    open && mr.head_pipeline ? gitlabApi<GlJob[]>(t, 'GET', `${projectPath(t)}/pipelines/${mr.head_pipeline.id}/jobs?per_page=50`).catch(() => []) : Promise.resolve([]),
    open ? gitlabApi<GlApprovals>(t, 'GET', `${mrPath(t, mr.iid)}/approvals`).catch(() => null) : Promise.resolve(null),
    full ? gitlabApi<unknown[]>(t, 'GET', `${mrPath(t, mr.iid)}/commits?per_page=100`).catch(() => null) : Promise.resolve(null),
    full ? gitlabApi<Array<{ diff?: string }>>(t, 'GET', `${mrPath(t, mr.iid)}/diffs?per_page=100`).catch(() => null) : Promise.resolve(null),
  ]);
  let diffStats: GitlabDetails['diffStats'] = null;
  if (diffs) {
    diffStats = { additions: 0, deletions: 0, files: diffs.length };
    for (const d of diffs) {
      const s = diffLineStats(d.diff ?? '');
      diffStats.additions += s.additions;
      diffStats.deletions += s.deletions;
    }
  }
  return toPullRequest(projectId, t.path, mr, { jobs, approvals, commitCount: commits?.length, diffStats });
}

const encodeBranch = (branch: string) => encodeURIComponent(branch);

export const gitlabMergeRequests = {
  async defaultBranch(t: GitlabTarget): Promise<string> {
    return (await gitlabApi<{ default_branch: string }>(t, 'GET', projectPath(t))).default_branch;
  },

  /** MR du projet, les plus récemment mises à jour d'abord ; les MR ouvertes sont détaillées (pipeline, approbations). */
  async list(projectId: string, t: GitlabTarget, filter: PullRequestFilter, limit: number): Promise<PullRequest[]> {
    const state = filter === 'OPEN' ? 'opened' : filter === 'MERGED' ? 'merged' : filter === 'CLOSED' ? 'closed' : 'all';
    const perPage = Math.min(Math.max(limit, 1), 100);
    const mrs = await gitlabApi<GlMergeRequest[]>(t, 'GET', `${projectPath(t)}/merge_requests?state=${state}&order_by=updated_at&sort=desc&per_page=${perPage}`);
    // Une MR « locked » (fusion en cours) est comptée ouverte, comme une MR « closed » est fermée sans fusion.
    return Promise.all(mrs.slice(0, perPage).map((mr) => withDetails(projectId, t, mr)));
  },

  async get(projectId: string, t: GitlabTarget, iid: number): Promise<PullRequest> {
    const mr = await gitlabApi<GlMergeRequest>(t, 'GET', mrPath(t, iid)).catch((err) => {
      if (err instanceof GitlabApiError && err.status === 404) throw new AppError(`Merge request !${iid} introuvable dans ${t.path}`);
      throw err;
    });
    return withDetails(projectId, t, mr, true);
  },

  /** Ouvre la MR ; un brouillon est marqué par le préfixe « Draft: » (convention de GitLab). Renvoie son iid. */
  async create(t: GitlabTarget, input: { title: string; head: string; base: string; body: string; draft: boolean }): Promise<number> {
    const title = input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title;
    try {
      const created = await gitlabApi<GlMergeRequest>(t, 'POST', `${projectPath(t)}/merge_requests`, { source_branch: input.head, target_branch: input.base, title, description: input.body });
      return created.iid;
    } catch (err) {
      if (err instanceof GitlabApiError && err.status === 409) throw new AppError(`Une merge request est déjà ouverte pour la branche ${input.head}`);
      throw err;
    }
  },

  /**
   * Fusionne (merge ou squash) ; renvoie le commit de fusion (ou de squash). GitLab n'a pas de fusion « rebase » par
   * requête : la méthode de fusion du projet (merge commit, fast-forward) s'applique.
   */
  async merge(t: GitlabTarget, iid: number, method: MergeMethod, sha?: string | null): Promise<string | null> {
    if (method === 'REBASE') throw new AppError('GitLab ne fusionne pas en « rebase » à la demande : choisissez merge ou squash (la méthode de fusion du projet GitLab s\'applique)');
    try {
      const mr = await gitlabApi<GlMergeRequest>(t, 'PUT', `${mrPath(t, iid)}/merge`, { squash: method === 'SQUASH', ...(sha ? { sha } : {}) });
      return mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? null;
    } catch (err) {
      if (err instanceof GitlabApiError && err.status === 409) throw new AppError('La branche a changé pendant la fusion : rechargez et réessayez');
      if (err instanceof GitlabApiError && (err.status === 405 || err.status === 406 || err.status === 422)) throw new AppError(`Fusion refusée par GitLab : ${err.message.replace(/^GitLab \([^)]*\) : /, '')}`);
      throw err;
    }
  },

  async deleteBranch(t: GitlabTarget, branch: string): Promise<void> {
    await gitlabApi(t, 'DELETE', `${projectPath(t)}/repository/branches/${encodeBranch(branch)}`).catch((err) => {
      // Déjà supprimée (option « supprimer la branche source » de la MR).
      if (!(err instanceof GitlabApiError && err.status === 404)) throw err;
    });
  },

  /** Commentaire (note) sur la MR ; renvoie son URL. */
  async comment(t: GitlabTarget, iid: number, body: string): Promise<string> {
    const note = await gitlabApi<{ id: number }>(t, 'POST', `${mrPath(t, iid)}/notes`, { body });
    const mr = await gitlabApi<GlMergeRequest>(t, 'GET', mrPath(t, iid)).catch(() => null);
    return mr ? `${mr.web_url}#note_${note.id}` : `https://${t.host}/${t.path}/-/merge_requests/${iid}#note_${note.id}`;
  },
};
