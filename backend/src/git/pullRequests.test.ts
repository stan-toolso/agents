import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Base, git et GitHub sont simulés : on vérifie l'enchaînement fusion → nettoyage.
const m = vi.hoisted(() => ({
  git: vi.fn(async (_args: string[], _cwd?: string): Promise<string> => ''),
  worksessions: [] as Array<{ id: string; projectId: string; name: string; branch: string }>,
  running: [] as Array<{ id: string }>,
  tasks: [] as Array<{ id: string; projectId: string; title: string; status: string; branch: string | null }>,
  stop: vi.fn(async () => undefined),
  deleteWorksession: vi.fn(async (_id: string, _deleteBranch?: boolean) => true),
  updateTask: vi.fn(async () => undefined),
  fetch: vi.fn(),
  gitUrl: 'https://github.com/acme/app.git' as string | null,
  /** Propriétaires de dépôt pour lesquels un jeton a été demandé. */
  tokenOwners: [] as Array<string | null>,
  /** Jeton GitLab de la personne (null : pas de compte sur l'instance). */
  gitlabToken: 'glpat_test' as string | null,
}));

vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, slug: id, gitUrl: m.gitUrl, gitBranch: 'main' }) } }));
vi.mock('../projects/workspace.js', () => ({ git: m.git, workspacePath: () => '/ws/main', gitAuthFor: async () => [] }));
vi.mock('../files/service.js', () => ({ resolveRoot: async () => '/ws/wt' }));
vi.mock('../settings/github.js', () => ({ githubService: { token: async (_u: string, owner?: string | null) => { m.tokenOwners.push(owner ?? null); return 'ghp_test'; } }, githubOwnerOf: () => 'acme' }));
vi.mock('./service.js', () => ({ gitService: { push: vi.fn(async () => '') } }));
vi.mock('../settings/gitlab.js', () => ({
  refreshKnownGitlabHosts: async () => [],
  projectGitlabRepo: (url: string | null) => {
    const g = url?.match(/^https:\/\/gitlab\.example\.fr\/(.+?)(?:\.git)?$/);
    return g ? { host: 'gitlab.example.fr', namespace: g[1].split('/')[0], path: g[1] } : null;
  },
  gitlabService: { apiToken: async () => m.gitlabToken },
  gitlabFetch: (host: string, path: string, init: RequestInit & { token?: string } = {}) => m.fetch(`https://${host}${path}`, init),
}));
vi.mock('../sessions/service.js', () => ({ sessionService: { list: async () => m.running, stop: m.stop } }));
vi.mock('../terminals/service.js', () => ({ terminalService: { listByProject: async () => [], delete: vi.fn() } }));
vi.mock('../worksessions/repository.js', () => ({ worksessionRepository: { listByProject: async () => m.worksessions } }));
vi.mock('../worksessions/service.js', () => ({ worksessionService: { delete: m.deleteWorksession } }));
// La suppression de la work session passe par le nettoyage (sessions archivées avec le souvenir de la work session) : ici on vérifie seulement qu'il est appelé avec la branche à supprimer.
vi.mock('../projects/cleanup.js', () => ({ removeWorksessionKeepingSessions: async (id: string, opts: { deleteBranch?: boolean }) => { await m.deleteWorksession(id, opts.deleteBranch ?? false); return { archivedSessionIds: [] }; } }));
vi.mock('../tasks/repository.js', () => ({ taskRepository: { list: async () => m.tasks } }));
vi.mock('../tasks/service.js', () => ({ taskService: { update: m.updateTask } }));
vi.stubGlobal('fetch', m.fetch);

const { buildDraftText, clearPullRequestCache, parseGithubRepo, parseRepoFullName, pullRequestService, STALE_TTL_MS } = await import('./pullRequests.js');

const gqlPr = (state = 'OPEN') => ({
  number: 7,
  title: 'Ma PR',
  body: '',
  url: 'https://github.com/acme/app/pull/7',
  state,
  isDraft: false,
  createdAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
  mergedAt: null,
  closedAt: null,
  author: { login: 'stan', avatarUrl: '' },
  headRefName: 'task/ma-tache',
  baseRefName: 'main',
  isCrossRepository: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: { totalCount: 1, nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null }] } } } }] },
  latestReviews: { nodes: [] },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseGithubRepo', () => {
  it('reconnaît les URL https, ssh et les alias ssh', () => {
    expect(parseGithubRepo('https://github.com/stan-toolso/skipper.git')).toEqual({ owner: 'stan-toolso', name: 'skipper' });
    expect(parseGithubRepo('https://github.com/stan-toolso/skipper')).toEqual({ owner: 'stan-toolso', name: 'skipper' });
    expect(parseGithubRepo('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
    expect(parseGithubRepo('git@github-curso:stan-toolso/Curso.git')).toEqual({ owner: 'stan-toolso', name: 'Curso' });
    expect(parseGithubRepo('ssh://git@github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
  });
  it('refuse les autres hébergeurs', () => {
    expect(parseGithubRepo('https://gitlab.com/acme/app.git')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
  });
  it('lit un « owner/name » ou une URL (parseRepoFullName)', () => {
    expect(parseRepoFullName('autre/depot')).toEqual({ owner: 'autre', name: 'depot' });
    expect(parseRepoFullName('https://github.com/autre/depot.git')).toEqual({ owner: 'autre', name: 'depot' });
    expect(parseRepoFullName('pas un dépôt')).toBeNull();
    expect(parseRepoFullName('')).toBeNull();
  });
});

describe('pullRequestService.get', () => {
  beforeEach(() => {
    m.fetch.mockReset();
    m.tokenOwners = [];
  });

  it("lit une PR d'un autre dépôt dans ce dépôt, avec le compte GitHub qui sert ce dépôt", async () => {
    m.fetch.mockImplementation(async () => json({ data: { repository: { pullRequest: { ...gqlPr(), url: 'https://github.com/autre/depot/pull/7' } } } }));
    const pr = await pullRequestService.get('p1', 'u1', 7, { owner: 'autre', name: 'depot' });
    expect(pr.repo).toBe('autre/depot');
    expect(m.tokenOwners).toEqual(['autre']);
    const body = JSON.parse((m.fetch.mock.calls[0][1] as RequestInit).body as string) as { variables: Record<string, unknown> };
    expect(body.variables).toMatchObject({ owner: 'autre', name: 'depot', number: 7 });
    // Sans dépôt : celui du projet, avec le compte qui le sert.
    const own = await pullRequestService.get('p1', 'u1', 7);
    expect(own.repo).toBe('acme/app');
    expect(m.tokenOwners).toEqual(['autre', 'acme']);
  });
});

describe('buildDraftText', () => {
  it('prend le titre de la tâche et liste les commits du plus ancien au plus récent', () => {
    const d = buildDraftText('task/x', [{ subject: 'deux' }, { subject: 'un' }], 'Ma tâche');
    expect(d.title).toBe('Ma tâche');
    expect(d.body).toBe('Tâche : Ma tâche\n\n## Commits\n\n- un\n- deux');
  });
  it('sans tâche : commit unique, sinon nom de branche', () => {
    expect(buildDraftText('feat/a', [{ subject: 'Ajoute A' }]).title).toBe('Ajoute A');
    expect(buildDraftText('task/pull-requests-github', [{ subject: 'a' }, { subject: 'b' }]).title).toBe('Pull requests github');
  });
});

describe('pullRequestService.list', () => {
  beforeEach(() => m.fetch.mockReset());
  afterEach(() => {
    m.gitUrl = 'https://github.com/acme/app.git';
  });

  it("renvoie une liste vide, sans erreur ni appel à GitHub, pour un projet sans dépôt git", async () => {
    m.gitUrl = null;
    await expect(pullRequestService.list('p1', 'u1')).resolves.toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("refuse un dépôt qui n'est ni sur GitHub ni sur GitLab", async () => {
    m.gitUrl = 'https://git.example.org/acme/app.git';
    await expect(pullRequestService.list('p1', 'u1')).rejects.toThrow(/ni sur GitHub ni sur GitLab/);
  });
});

describe('pullRequestService.forBranch', () => {
  const listed = (state: string) => json({ data: { repository: { pullRequests: { nodes: [gqlPr(state)] } } } });
  beforeEach(() => {
    clearPullRequestCache();
    m.fetch.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it("sert la dernière liste connue sans attendre GitHub, puis la rafraîchit en arrière-plan", async () => {
    m.fetch.mockResolvedValueOnce(listed('OPEN'));
    expect((await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache'))?.state).toBe('OPEN');
    expect(m.fetch).toHaveBeenCalledTimes(1);

    // Cache court encore valide : aucun appel.
    vi.advanceTimersByTime(10_000);
    await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache');
    expect(m.fetch).toHaveBeenCalledTimes(1);

    // Cache court expiré : réponse immédiate avec l'ancienne liste, un seul rafraîchissement lancé.
    vi.advanceTimersByTime(60_000);
    let release!: (r: Response) => void;
    m.fetch.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    expect((await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache'))?.state).toBe('OPEN');
    expect((await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache'))?.state).toBe('OPEN');
    expect(m.fetch).toHaveBeenCalledTimes(2);
    release(listed('MERGED'));
    await vi.waitFor(async () => expect((await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache'))?.state).toBe('MERGED'));
    expect(m.fetch).toHaveBeenCalledTimes(2);
  });

  it("attend GitHub quand la liste connue est trop ancienne, et list() sans stale reste fraîche", async () => {
    m.fetch.mockResolvedValueOnce(listed('OPEN'));
    await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache');
    vi.advanceTimersByTime(30_000);
    m.fetch.mockResolvedValueOnce(listed('MERGED'));
    expect((await pullRequestService.list('p1', 'u1', 'ALL', 100))[0].state).toBe('MERGED');

    vi.advanceTimersByTime(STALE_TTL_MS + 1);
    m.fetch.mockResolvedValueOnce(listed('CLOSED'));
    expect((await pullRequestService.forBranch('p1', 'u1', 'task/ma-tache'))?.state).toBe('CLOSED');
    expect(m.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('pullRequestService.merge', () => {
  beforeEach(() => {
    m.fetch.mockReset();
    m.git.mockClear();
    m.stop.mockClear();
    m.deleteWorksession.mockClear();
    m.updateTask.mockClear();
    m.worksessions = [{ id: 'wt1', projectId: 'p1', name: 'task-ma-tache', branch: 'task/ma-tache' }];
    m.running = [];
    m.tasks = [{ id: 't1', projectId: 'p1', title: 'Ma tâche', status: 'in_progress', branch: 'task/ma-tache' }];
    m.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/graphql')) return json({ data: { repository: { pullRequest: gqlPr(m.fetch.mock.calls.some(([, i]) => (i as RequestInit).method === 'PUT') ? 'MERGED' : 'OPEN') } } });
      if (init.method === 'PUT') return json({ sha: 'abc123', merged: true, message: 'ok' });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ message: 'inattendu' }, 500);
    });
  });

  it('fusionne en squash puis supprime branche distante, worksession et termine la tâche', async () => {
    const res = await pullRequestService.merge('p1', 'u1', 7, 'SQUASH', { deleteRemoteBranch: true, deleteWorksession: true, completeTasks: true });
    const put = m.fetch.mock.calls.find(([, i]) => (i as RequestInit).method === 'PUT')!;
    expect(put[0]).toBe('https://api.github.com/repos/acme/app/pulls/7/merge');
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ merge_method: 'squash' });
    const del = m.fetch.mock.calls.find(([, i]) => (i as RequestInit).method === 'DELETE')!;
    expect(del[0]).toBe('https://api.github.com/repos/acme/app/git/refs/heads/task/ma-tache');
    expect(m.deleteWorksession).toHaveBeenCalledWith('wt1', true);
    expect(m.updateTask).toHaveBeenCalledWith('t1', { status: 'done' });
    expect(res).toMatchObject({ sha: 'abc123', deletedWorksessionIds: ['wt1'], completedTaskIds: ['t1'], warnings: [] });
    expect(res.pullRequest.state).toBe('MERGED');
  });

  it('conserve la work session si des sessions y tournent, sauf demande de les arrêter', async () => {
    m.running = [{ id: 's1' }];
    const kept = await pullRequestService.merge('p1', 'u1', 7, 'MERGE', { deleteWorksession: true });
    expect(m.deleteWorksession).not.toHaveBeenCalled();
    expect(kept.warnings[0]).toMatch(/task-ma-tache conservé/);
    m.fetch.mockClear(); // la PR redevient ouverte pour la seconde fusion

    const removed = await pullRequestService.merge('p1', 'u1', 7, 'MERGE', { deleteWorksession: true, stopSessions: true });
    expect(m.stop).toHaveBeenCalledWith('s1');
    expect(removed.deletedWorksessionIds).toEqual(['wt1']);
  });

  it('traduit un refus de fusion de GitHub', async () => {
    m.fetch.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith('/graphql') ? json({ data: { repository: { pullRequest: gqlPr() } } }) : init.method === 'PUT' ? json({ message: 'Pull Request is not mergeable' }, 405) : json({}, 500),
    );
    await expect(pullRequestService.merge('p1', 'u1', 7)).rejects.toThrow(/Fusion refusée par GitHub : Pull Request is not mergeable/);
  });
});

describe('merge requests GitLab', () => {
  const API = 'https://gitlab.example.fr/api/v4/projects/equipe%2Fweb%2Fapp';
  const glMr = (state = 'opened', over: Record<string, unknown> = {}) => ({
    iid: 12,
    title: 'Ma MR',
    description: 'desc',
    state,
    draft: false,
    web_url: 'https://gitlab.example.fr/equipe/web/app/-/merge_requests/12',
    author: { username: 'stan', avatar_url: null },
    source_branch: 'task/ma-tache',
    target_branch: 'main',
    source_project_id: 1,
    target_project_id: 1,
    has_conflicts: false,
    detailed_merge_status: 'mergeable',
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T11:00:00Z',
    merged_at: state === 'merged' ? '2026-11-01T12:00:00Z' : null,
    closed_at: null,
    ...over,
  });
  let merged = false;
  beforeEach(() => {
    clearPullRequestCache();
    merged = false;
    m.gitUrl = 'https://gitlab.example.fr/equipe/web/app.git';
    m.gitlabToken = 'glpat_test';
    m.fetch.mockReset();
    m.deleteWorksession.mockClear();
    m.updateTask.mockClear();
    m.worksessions = [{ id: 'wt1', projectId: 'p1', name: 'task-ma-tache', branch: 'task/ma-tache' }];
    m.running = [];
    m.tasks = [{ id: 't1', projectId: 'p1', title: 'Ma tâche', status: 'in_progress', branch: 'task/ma-tache' }];
    m.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.startsWith(`${API}/merge_requests?`)) return json([glMr(), glMr('merged', { iid: 11 })]);
      if (method === 'GET' && url === `${API}/merge_requests/12`) return json(glMr(merged ? 'merged' : 'opened', { changes_count: '3', head_pipeline: { id: 99, status: 'failed', web_url: 'https://gitlab.example.fr/p/99' } }));
      if (method === 'GET' && url.startsWith(`${API}/pipelines/99/jobs`)) return json([{ name: 'test', status: 'failed', web_url: 'https://j/1' }, { name: 'lint', status: 'failed', allow_failure: true }]);
      if (method === 'GET' && url === `${API}/merge_requests/12/approvals`) return json({ approvals_left: 0, approved_by: [{ user: { username: 'alice' } }] });
      if (method === 'GET' && url.startsWith(`${API}/merge_requests/12/commits`)) return json([{}, {}]);
      if (method === 'GET' && url.startsWith(`${API}/merge_requests/12/diffs`)) return json([{ diff: '@@\n+a\n+b\n-c\n' }]);
      if (method === 'PUT' && url === `${API}/merge_requests/12/merge`) {
        merged = true;
        return json(glMr('merged', { merge_commit_sha: 'def456' }));
      }
      if (method === 'DELETE' && url === `${API}/repository/branches/task%2Fma-tache`) return new Response(null, { status: 204 });
      return json({ message: `inattendu ${method} ${url}` }, 500);
    });
  });
  afterEach(() => {
    m.gitUrl = 'https://github.com/acme/app.git';
  });

  it('liste les MR du projet, avec pipeline, jobs et approbations des MR ouvertes', async () => {
    const list = await pullRequestService.list('p1', 'u1', 'ALL', 100);
    expect(list.map((p) => [p.number, p.state])).toEqual([
      [12, 'OPEN'],
      [11, 'MERGED'],
    ]);
    expect(list[0]).toMatchObject({
      repo: 'equipe/web/app',
      forge: 'gitlab',
      headRefName: 'task/ma-tache',
      checksState: 'FAILURE',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      reviewDecision: 'APPROVED',
      reviews: [{ author: 'alice', state: 'APPROVED' }],
      changedFiles: 3,
    });
    expect(list[0].checks).toEqual([
      { name: 'test', state: 'FAILURE', url: 'https://j/1' },
      { name: 'lint', state: 'NEUTRAL', url: null },
    ]);
    // Les MR fermées ou fusionnées ne sont pas détaillées.
    expect(m.fetch.mock.calls.some(([u]) => String(u).includes('/merge_requests/11'))).toBe(false);
  });

  it('lit une MR en détail (commits et lignes modifiées)', async () => {
    const pr = await pullRequestService.get('p1', 'u1', 12);
    expect(pr).toMatchObject({ number: 12, commitCount: 2, additions: 2, deletions: 1, changedFiles: 1, url: 'https://gitlab.example.fr/equipe/web/app/-/merge_requests/12' });
  });

  it('fusionne en squash puis supprime la branche source, le dossier de travail et termine la tâche', async () => {
    const res = await pullRequestService.merge('p1', 'u1', 12, 'SQUASH', { deleteRemoteBranch: true, deleteWorksession: true, completeTasks: true });
    const put = m.fetch.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ squash: true });
    expect(m.fetch.mock.calls.some(([u, i]) => (i as RequestInit | undefined)?.method === 'DELETE' && String(u).endsWith('/repository/branches/task%2Fma-tache'))).toBe(true);
    expect(res).toMatchObject({ sha: 'def456', deletedWorksessionIds: ['wt1'], completedTaskIds: ['t1'], warnings: [] });
    expect(res.pullRequest.state).toBe('MERGED');
  });

  it('refuse le rebase, et demande un compte GitLab sur l’instance', async () => {
    await expect(pullRequestService.merge('p1', 'u1', 12, 'REBASE')).rejects.toThrow(/rebase/);
    m.gitlabToken = null;
    await expect(pullRequestService.list('p1', 'u1')).rejects.toThrow(/GitLab non connecté : connectez un compte gitlab.example.fr/);
  });
});
