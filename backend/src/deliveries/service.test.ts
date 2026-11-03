import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery, DeliveryStep, DeployConfig } from './types.js';

// Livraisons : dépôt en mémoire, git, forge, coffre et SSH simulés.
const m = vi.hoisted(() => ({
  deliveries: [] as Delivery[],
  config: null as DeployConfig | null,
  seq: 0,
  operation: null as string | null,
  changes: [] as string[],
  openPrs: [] as Array<{ number: number; headRefName: string; isCrossRepository: boolean }>,
  prStates: [] as Array<Record<string, unknown>>,
  ciStates: [] as Array<{ state: string | null; checks: Array<{ name: string; state: string; url: null }> }>,
  merged: [] as Array<{ userId: string; number: number }>,
  opened: 0,
  conflicts: [] as Array<{ delivery?: boolean }>,
  commands: [] as string[],
  exitCode: 0,
  events: [] as Array<[string, string]>,
  busy: false,
}));

const unique = () => Object.assign(new Error('duplicate key'), { code: '23505' });
vi.mock('./repository.js', () => {
  const active = (d: Delivery) => d.status === 'queued' || d.status === 'running';
  const repo = {
    create: async (d: Partial<Delivery> & { projectId: string; kind: Delivery['kind']; status: Delivery['status'] }) => {
      if (d.kind === 'deploy' && m.deliveries.some((x) => x.projectId === d.projectId && x.kind === 'deploy' && x.status === d.status && (d.status === 'queued' || d.status === 'running'))) throw unique();
      if (d.kind === 'merge' && m.deliveries.some((x) => x.kind === 'merge' && x.worksessionId === d.worksessionId && active(x))) throw unique();
      const row: Delivery = {
        id: `d${++m.seq}`,
        projectId: d.projectId,
        kind: d.kind,
        status: d.status,
        requestedById: d.requestedById ?? null,
        joinedByIds: [],
        sessionId: d.sessionId ?? null,
        worksessionId: d.worksessionId ?? null,
        taskId: d.taskId ?? null,
        branch: d.branch ?? null,
        prNumber: null,
        prUrl: null,
        sha: null,
        steps: d.steps ?? [],
        output: null,
        error: null,
        instanceId: d.instanceId ?? null,
        createdAt: new Date(),
        startedAt: d.status === 'running' ? new Date() : null,
        finishedAt: null,
      };
      m.deliveries.push(row);
      return { ...row };
    },
    get: async (id: string) => {
      const d = m.deliveries.find((x) => x.id === id);
      return d ? { ...d, steps: [...d.steps] } : null;
    },
    list: async () => [...m.deliveries],
    updateActive: async (id: string, patch: Partial<Delivery>) => {
      const d = m.deliveries.find((x) => x.id === id);
      if (!d || !active(d)) return null;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (d as unknown as Record<string, unknown>)[k] = v;
      return { ...d };
    },
    appendStep: async (id: string, step: DeliveryStep) => {
      m.deliveries.find((x) => x.id === id)?.steps.push(step);
    },
    queuedDeploy: async (projectId: string) => m.deliveries.find((x) => x.projectId === projectId && x.kind === 'deploy' && x.status === 'queued') ?? null,
    runningDeploy: async (projectId: string) => m.deliveries.find((x) => x.projectId === projectId && x.kind === 'deploy' && x.status === 'running') ?? null,
    join: async (id: string, userId: string) => {
      const d = m.deliveries.find((x) => x.id === id && x.status === 'queued');
      if (!d) return null;
      if (d.requestedById !== userId && !d.joinedByIds.includes(userId)) d.joinedByIds.push(userId);
      return { ...d };
    },
    startQueuedDeploy: async (projectId: string, instanceId: string) => {
      if (m.deliveries.some((x) => x.projectId === projectId && x.kind === 'deploy' && x.status === 'running')) return null;
      const d = m.deliveries.find((x) => x.projectId === projectId && x.kind === 'deploy' && x.status === 'queued');
      if (!d) return null;
      Object.assign(d, { status: 'running', startedAt: new Date(), instanceId });
      return { ...d };
    },
    finish: async (id: string, status: Delivery['status'], patch: Partial<Delivery> = {}) => repo.updateActive(id, { ...patch, status, finishedAt: new Date() }),
    failOrphans: async (live: string[], message: string) => {
      const orphans = m.deliveries.filter((x) => x.status === 'running' && !live.includes(x.instanceId ?? ''));
      for (const o of orphans) Object.assign(o, { status: 'failed', error: message });
      return orphans.map((o) => ({ id: o.id, projectId: o.projectId, kind: o.kind, sessionId: o.sessionId }));
    },
    projectsWithQueuedDeploy: async () => [...new Set(m.deliveries.filter((x) => x.kind === 'deploy' && x.status === 'queued').map((x) => x.projectId))],
    getConfig: async () => m.config,
    setConfig: async () => m.config,
    deleteConfig: async () => undefined,
  };
  return { deliveryRepository: repo, isUniqueViolation: (err: unknown) => (err as { code?: string }).code === '23505' };
});

vi.mock('../instances/registry.js', () => ({ instanceRegistry: { id: 'i1', draining: false } }));
vi.mock('../log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../audit/service.js', () => ({ auditService: { record: async () => undefined } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, slug: 'app', gitUrl: 'https://github.com/acme/app.git', gitBranch: 'main' }) } }));
vi.mock('../worksessions/service.js', () => ({
  worksessionPath: () => '/tmp/ws',
  worksessionService: { get: async (id: string) => ({ id, name: 'ws', branch: 'task/x', projectId: 'p' }) },
}));
vi.mock('../worksessions/repository.js', () => ({ worksessionRepository: { listByProject: async () => [{ id: 'ws1', branch: 'task/x' }] } }));
vi.mock('../sessions/service.js', () => ({
  sessionService: { get: async (id: string) => ({ id, projectId: 'p', worksessionId: 'ws1', status: 'running', activity: m.busy ? 'busy' : 'idle' }) },
}));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { list: async () => [{ id: 's1', config: {} }] } }));
vi.mock('../sessions/events.js', () => ({
  traceSessionEvent: async (sessionId: string, _type: string, payload: { message: string }) => {
    m.events.push([sessionId, payload.message]);
  },
}));
vi.mock('../reviews/types.js', () => ({ reviewOf: () => null }));
vi.mock('../tasks/service.js', () => ({ taskService: { get: async (id: string) => ({ id, projectId: 'p', branch: 'task/x' }), list: async () => [{ id: 't1', branch: 'task/x' }] } }));
vi.mock('../git/service.js', () => ({
  gitService: {
    status: async () => ({ branch: 'task/x', operation: m.operation, changes: m.changes.map((p) => ({ path: p })) }),
    mergeBase: async () => undefined,
    invalidate: () => undefined,
    push: async () => '',
  },
  headCommitOf: async () => 'abc1234def',
  operationOf: async () => m.operation,
}));
vi.mock('../git/conflicts.js', () => ({
  requestGitConflictResolution: async (_ref: unknown, _owner: string, opts: { delivery?: boolean }) => {
    m.conflicts.push(opts);
    return { id: 's1' };
  },
}));
vi.mock('../git/pullRequests.js', () => {
  const base = { number: 42, url: 'https://github.com/acme/app/pull/42', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', checksState: 'PENDING', checks: [], headRefName: 'task/x', isCrossRepository: false };
  return {
    pullRequestService: {
      hasPullRequests: async () => true,
      list: async () => m.openPrs,
      draft: async () => ({ title: 'Titre', body: 'Corps' }),
      get: async () => ({ ...base, ...(m.prStates.length > 1 ? m.prStates.shift() : m.prStates[0]) }),
      merge: async (_p: string, userId: string, number: number) => {
        m.merged.push({ userId, number });
        return { pullRequest: { ...base, state: 'MERGED' }, sha: 'feedbeef00', warnings: [], deletedWorksessionIds: [], completedTaskIds: [] };
      },
      ciStatus: async (_p: string, _u: string, ref: string) => {
        const s = m.ciStates.length > 1 ? m.ciStates.shift()! : m.ciStates[0];
        return { ref, sha: '0123456789abcdef', ...s };
      },
    },
  };
});
vi.mock('../pullRequests/service.js', () => ({
  trackedPullRequestService: {
    recordGithub: async () => ({}),
    open: async () => {
      m.opened++;
      return { number: 42 };
    },
    markMerged: async () => ({}),
  },
}));
vi.mock('../vault/service.js', () => ({
  vaultService: {
    agentItemByName: async (_p: string, _u: string, name: string) => ({ id: 'v1', name, kind: 'ssh', hostKey: null, commandAllowlist: [] }),
    assertCommandAllowed: () => undefined,
    sshCredentials: () => ({}),
    rememberHostKey: async () => undefined,
    audit: async () => undefined,
  },
}));
vi.mock('../vault/ssh.js', () => ({
  connect: async () => ({ hostKey: 'k', close: () => undefined }),
  exec: async (_s: unknown, command: string) => {
    m.commands.push(command);
    return { stdout: 'déployé', stderr: '', exitCode: m.exitCode, signal: null, truncated: false, durationMs: 1000 };
  },
}));

const { checksAction, deliveryService, normalizeDeployConfig, renderDeployCommand, setDeliveryTimingsForTests } = await import('./service.js');

const pr = (over: Record<string, unknown> = {}) => ({ state: 'OPEN' as const, isDraft: false, checksState: 'SUCCESS', checks: [], mergeable: 'MERGEABLE', ...over });
const ok = { state: 'SUCCESS', checks: [{ name: 'Tests', state: 'SUCCESS', url: null }] };
const pending = { state: 'PENDING', checks: [{ name: 'Tests', state: 'PENDING', url: null }] };
const red = { state: 'FAILURE', checks: [{ name: 'Tests', state: 'FAILURE', url: null }] };

beforeEach(() => {
  Object.assign(m, { deliveries: [], config: null, seq: 0, operation: null, changes: [], openPrs: [], prStates: [{ checksState: 'SUCCESS' }], ciStates: [ok], merged: [], opened: 0, conflicts: [], commands: [], exitCode: 0, events: [], busy: false });
  setDeliveryTimingsForTests({ pollMs: 1, graceMs: 20 });
});

describe('checksAction', () => {
  it('fusionne sur CI verte, attend une CI en cours, refuse une CI rouge', () => {
    expect(checksAction(pr(), 0)).toEqual({ action: 'merge' });
    expect(checksAction(pr({ checksState: 'PENDING' }), 0)).toEqual({ action: 'wait' });
    expect(checksAction(pr({ checksState: 'EXPECTED' }), 0)).toEqual({ action: 'wait' });
    const fail = checksAction(pr({ checksState: 'FAILURE', checks: [{ name: 'Tests', state: 'FAILURE', url: null }] }), 0);
    expect(fail).toMatchObject({ action: 'fail' });
    expect((fail as { reason: string }).reason).toContain('Tests');
  });
  it("sans check : attend le délai de grâce, puis fusionne en le signalant", () => {
    expect(checksAction(pr({ checksState: null }), 1000, 5000)).toEqual({ action: 'wait' });
    expect(checksAction(pr({ checksState: null }), 6000, 5000)).toEqual({ action: 'merge', note: 'aucun check sur ce commit' });
    // Checks présents mais état agrégé pas encore calculé : en cours.
    expect(checksAction(pr({ checksState: null, checks: [{ name: 'Tests', state: 'PENDING', url: null }] }), 6000, 5000)).toEqual({ action: 'wait' });
  });
  it('brouillon, fermée, déjà fusionnée, en conflit', () => {
    expect(checksAction(pr({ isDraft: true }), 0)).toMatchObject({ action: 'fail' });
    expect(checksAction(pr({ state: 'CLOSED' }), 0)).toMatchObject({ action: 'fail' });
    expect(checksAction(pr({ state: 'MERGED' }), 0)).toMatchObject({ action: 'done' });
    expect(checksAction(pr({ mergeable: 'CONFLICTING' }), 0)).toEqual({ action: 'rebase' });
  });
});

describe('commande de déploiement', () => {
  it('remplace {sha} et {branch}, refuse les valeurs douteuses', () => {
    expect(renderDeployCommand('deploy.sh --ref {sha} # {branch}', { sha: 'abcdef1', branch: 'main' })).toBe('deploy.sh --ref abcdef1 # main');
    expect(() => renderDeployCommand('x {sha}', { sha: '$(rm -rf /)', branch: 'main' })).toThrow();
    expect(() => renderDeployCommand('x {branch}', { sha: 'abcdef1', branch: 'main; rm' })).toThrow();
  });
  it('valide la configuration', () => {
    expect(normalizeDeployConfig({ vaultItem: ' Skipper-1 ', command: ' deploy.sh ', branch: '' })).toEqual({ vaultItem: 'skipper-1', command: 'deploy.sh', branch: null, timeoutMinutes: 30 });
    expect(() => normalizeDeployConfig({ vaultItem: '', command: 'x' })).toThrow();
    expect(() => normalizeDeployConfig({ vaultItem: 'a', command: ' ' })).toThrow();
    expect(() => normalizeDeployConfig({ vaultItem: 'a', command: 'x', timeoutMinutes: 500 })).toThrow();
  });
});

describe('Livrer', () => {
  it('fusionne la base, pousse, ouvre la PR, attend la CI verte puis fusionne avec le compte de la personne', async () => {
    m.prStates = [{ checksState: 'PENDING', checks: [{ name: 'Tests', state: 'PENDING', url: null }] }, { checksState: 'SUCCESS' }];
    const d = await deliveryService.deliver({ sessionId: 's1', userId: 'u1' });
    expect(d.status).toBe('running');
    await deliveryService.settle();
    const done = m.deliveries[0];
    expect(done.status).toBe('succeeded');
    expect(m.opened).toBe(1);
    expect(m.merged).toEqual([{ userId: 'u1', number: 42 }]);
    expect(done.sha).toBe('feedbeef00');
    expect(done.prNumber).toBe(42);
    expect(done.taskId).toBe('t1');
    // Chaque étape apparaît dans le transcript de la session.
    expect(m.events.map(([, msg]) => msg).join('\n')).toMatch(/fusion de la branche de base[\s\S]*push[\s\S]*ouverte[\s\S]*checks verts[\s\S]*fusionnée/);
  });

  it('reprend une PR déjà ouverte au lieu d’en ouvrir une autre', async () => {
    m.openPrs = [{ number: 42, headRefName: 'task/x', isCrossRepository: false }];
    await deliveryService.deliver({ sessionId: 's1', userId: 'u1' });
    await deliveryService.settle();
    expect(m.opened).toBe(0);
    expect(m.deliveries[0].status).toBe('succeeded');
  });

  it('ne fusionne jamais sur une CI rouge', async () => {
    m.prStates = [{ checksState: 'FAILURE', checks: [{ name: 'Tests', state: 'FAILURE', url: null }] }];
    await deliveryService.deliver({ sessionId: 's1', userId: 'u1' });
    await deliveryService.settle();
    expect(m.merged).toEqual([]);
    expect(m.deliveries[0].status).toBe('failed');
    expect(m.deliveries[0].error).toContain('Tests');
  });

  it("confie un conflit à l'agent de la session", async () => {
    // Pas d'opération au moment du clic, conflit après la fusion de la base.
    const status = await import('../git/service.js');
    const spy = vi.spyOn(status.gitService, 'mergeBase').mockImplementation(async () => {
      m.operation = 'merge';
    });
    await deliveryService.deliver({ sessionId: 's1', userId: 'u1' });
    await deliveryService.settle();
    spy.mockRestore();
    expect(m.deliveries[0].status).toBe('conflict');
    expect(m.conflicts).toEqual([{ delivery: true }]);
    expect(m.merged).toEqual([]);
  });

  it('refuse tout de suite : fichiers non commités, agent au travail, livraison déjà en cours', async () => {
    m.changes = ['a.ts'];
    await expect(deliveryService.deliver({ sessionId: 's1', userId: 'u1' })).rejects.toThrow(/non commité/);
    m.changes = [];
    m.busy = true;
    await expect(deliveryService.deliver({ sessionId: 's1', userId: 'u1' })).rejects.toThrow(/au travail/);
    m.busy = false;
    m.prStates = [{ checksState: 'PENDING', checks: [{ name: 'Tests', state: 'PENDING', url: null }] }];
    await deliveryService.deliver({ sessionId: 's1', userId: 'u1' });
    await expect(deliveryService.deliver({ sessionId: 's1', userId: 'u2' })).rejects.toThrow(/déjà en cours/);
    await deliveryService.cancel(m.deliveries[0].id, 'u1');
    await deliveryService.settle();
    expect(m.deliveries[0].status).toBe('cancelled');
    expect(m.merged).toEqual([]);
  });

  it('demande le déploiement une fois fusionnée', async () => {
    m.config = { projectId: 'p', vaultItem: 'skipper-1', command: 'deploy.sh --ref {sha}', branch: null, timeoutMinutes: 30, updatedById: null, updatedAt: new Date() };
    await deliveryService.deliver({ sessionId: 's1', userId: 'u1', deploy: true });
    await deliveryService.settle();
    const deploy = m.deliveries.find((d) => d.kind === 'deploy');
    expect(deploy?.status).toBe('succeeded');
    expect(m.commands).toEqual(['deploy.sh --ref 0123456789abcdef']);
  });
});

describe('Déploiement', () => {
  const config = (): DeployConfig => ({ projectId: 'p', vaultItem: 'skipper-1', command: 'deploy.sh --ref {sha}', branch: null, timeoutMinutes: 30, updatedById: null, updatedAt: new Date() });

  it('refuse sans configuration', async () => {
    await expect(deliveryService.requestDeploy('p', 'u1')).rejects.toThrow(/configuré/);
  });

  it('attend la CI en cours, puis déploie le commit vérifié', async () => {
    m.config = config();
    m.ciStates = [pending, pending, ok];
    await deliveryService.requestDeploy('p', 'u1');
    await deliveryService.settle();
    expect(m.commands).toEqual(['deploy.sh --ref 0123456789abcdef']);
    const d = m.deliveries[0];
    expect(d.status).toBe('succeeded');
    expect(d.sha).toBe('0123456789abcdef');
    expect(d.output).toContain('déployé');
  });

  it('ne déploie jamais une CI rouge', async () => {
    m.config = config();
    m.ciStates = [red];
    await deliveryService.requestDeploy('p', 'u1');
    await deliveryService.settle();
    expect(m.commands).toEqual([]);
    expect(m.deliveries[0].status).toBe('failed');
  });

  it("regroupe les demandes faites pendant un déploiement : un seul déploiement de plus, jamais deux à la fois", async () => {
    m.config = config();
    m.ciStates = [pending, pending, pending, ok];
    await deliveryService.requestDeploy('p', 'u1');
    // Pendant le premier (CI en cours), deux autres demandes : un seul lot en attente.
    const second = await deliveryService.requestDeploy('p', 'u2');
    const third = await deliveryService.requestDeploy('p', 'u3');
    expect(second.id).toBe(third.id);
    expect(m.deliveries.filter((d) => d.status === 'running')).toHaveLength(1);
    await deliveryService.settle();
    expect(m.deliveries).toHaveLength(2);
    expect(m.deliveries[1].joinedByIds).toEqual(['u3']);
    expect(m.deliveries.every((d) => d.status === 'succeeded')).toBe(true);
    expect(m.commands).toHaveLength(2);
  });

  it('marque en échec un déploiement dont la commande échoue', async () => {
    m.config = config();
    m.exitCode = 1;
    await deliveryService.requestDeploy('p', 'u1');
    await deliveryService.settle();
    expect(m.deliveries[0].status).toBe('failed');
    expect(m.deliveries[0].error).toContain('code 1');
  });

  it("une commande lancée ne s'annule plus ; une livraison d'une instance disparue passe en échec", async () => {
    m.deliveries.push({ id: 'old', projectId: 'p', kind: 'deploy', status: 'running', requestedById: 'u1', joinedByIds: [], sessionId: null, worksessionId: null, taskId: null, branch: 'main', prNumber: null, prUrl: null, sha: null, steps: [{ at: '', message: 'commande', level: 'info', phase: 'command' }], output: null, error: null, instanceId: 'gone', createdAt: new Date(), startedAt: new Date(), finishedAt: null });
    await expect(deliveryService.cancel('old', 'u1')).rejects.toThrow(/ne peut plus/);
    await deliveryService.recover(['i1']);
    expect(m.deliveries[0].status).toBe('failed');
  });
});
