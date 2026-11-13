import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryPolicy } from './policy.js';

const m = vi.hoisted(() => ({
  policy: null as DeliveryPolicy | null,
  saved: [] as Array<{ rules: unknown; userId: string }>,
  deleted: 0,
  prs: [] as Array<Record<string, unknown>>,
  tasks: {} as Record<string, { id: string; tags: string[] }>,
  sessions: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<{ status: string }>,
  role: 'admin' as string | null,
  head: 'abc' as string | null,
  reviewsRequested: [] as Array<{ target: unknown; userId: string; opts: unknown }>,
  delivered: [] as Array<Record<string, unknown>>,
  deliverError: null as string | null,
  notified: [] as Array<{ type: string }>,
}));

vi.mock('../git/service.js', () => ({ headCommitOf: async () => m.head }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: { type: string }) => void m.notified.push(n) } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async () => ({ id: 'p', name: 'Curso', slug: 'curso', gitUrl: 'https://github.com/acme/app.git' }) } }));
vi.mock('../pullRequests/service.js', () => ({
  projectRepoName: () => 'acme/app',
  foreignRepoOf: (pr: { repo: string }, repo: string) => (pr.repo.toLowerCase() === repo ? null : { owner: 'x', name: 'y' }),
  trackedPullRequestService: { list: async () => m.prs },
}));
vi.mock('../reviews/service.js', () => ({
  reviewService: {
    onReported: () => undefined,
    request: async (target: unknown, userId: string, opts: unknown) => {
      m.reviewsRequested.push({ target, userId, opts });
      return { id: 'rs-new' };
    },
  },
}));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { list: async () => m.sessions } }));
vi.mock('../tasks/repository.js', () => ({ taskRepository: { findById: async (id: string) => m.tasks[id] ?? null } }));
vi.mock('../users/service.js', () => ({ userService: { memberRoleFor: async () => m.role } }));
vi.mock('../worksessions/repository.js', () => ({
  worksessionRepository: { findById: async (id: string) => ({ id, name: 'feature', branch: 'feature', archivedAt: null }), findByBranch: async () => null },
}));
vi.mock('../worksessions/service.js', () => ({ worksessionPath: () => '/ws/feature' }));
vi.mock('./repository.js', () => ({
  deliveryRepository: {
    getPolicy: async () => m.policy,
    autoMergeProjects: async () => (m.policy ? [m.policy] : []),
    setPolicy: async (projectId: string, rules: unknown, userId: string) => {
      m.saved.push({ rules, userId });
      return { projectId, rules, mergeUserId: userId, updatedAt: new Date() };
    },
    deletePolicy: async () => void (m.deleted += 1),
    list: async () => m.deliveries,
  },
}));
vi.mock('./service.js', () => ({
  deliveryService: {
    deliver: async (input: Record<string, unknown>) => {
      if (m.deliverError) throw new Error(m.deliverError);
      m.delivered.push(input);
      return { id: 'd1' };
    },
  },
}));

const { deliveryPolicyService } = await import('./autoMerge.js');

const pr = (over: Record<string, unknown> = {}) => ({ id: 'pr1', projectId: 'p', repo: 'acme/app', number: 12, headBranch: 'feature', status: 'open', isDraft: false, checksState: 'SUCCESS', taskId: 't1', worksessionId: 'ws1', ...over });
const reviewSession = (review: Record<string, unknown>) => ({ id: 'rs1', status: 'completed', activity: null, archivedAt: null, config: { review: { reportedAt: '2026-11-13T10:00:00Z', headSha: 'abc', verdict: 'approved', auto: true, ...review } } });

beforeEach(() => {
  m.policy = { projectId: 'p', rules: [{ tag: 'auto', mode: 'auto_merge' }], mergeUserId: 'admin1', updatedAt: new Date() };
  m.prs = [pr()];
  m.tasks = { t1: { id: 't1', tags: ['auto', 'backend'] } };
  m.sessions = [];
  m.deliveries = [];
  m.role = 'admin';
  m.head = 'abc';
});
afterEach(() => {
  m.saved = [];
  m.deleted = 0;
  m.reviewsRequested = [];
  m.delivered = [];
  m.deliverError = null;
  m.notified = [];
});

describe('deliveryPolicyService.set', () => {
  it("enregistre la politique avec la personne qui l'active comme compte de fusion ; liste vide : retirée", async () => {
    await deliveryPolicyService.set('p', [{ tag: ' auto ', mode: 'AUTO_MERGE' }], 'admin2');
    expect(m.saved).toEqual([{ rules: [{ tag: 'auto', mode: 'auto_merge' }], userId: 'admin2' }]);
    expect(await deliveryPolicyService.set('p', [], 'admin2')).toBeNull();
    expect(m.deleted).toBe(1);
    await expect(deliveryPolicyService.set('p', [{ tag: 'x', mode: 'yolo' }], 'admin2')).rejects.toThrow(/inconnue/);
  });
});

describe('fusion automatique', () => {
  it('demande une relecture du commit courant avec le compte de fusion', async () => {
    await deliveryPolicyService.tick();
    expect(m.reviewsRequested).toEqual([{ target: { projectId: 'p', pullRequestId: 'pr1' }, userId: 'admin1', opts: { auto: true } }]);
    expect(m.delivered).toEqual([]);
  });

  it('livre (sans déploiement) avec le compte de fusion quand la relecture est favorable et la CI verte', async () => {
    m.sessions = [reviewSession({})];
    await deliveryPolicyService.tick();
    expect(m.reviewsRequested).toEqual([]);
    expect(m.delivered).toEqual([{ worksessionId: 'ws1', taskId: 't1', userId: 'admin1', deploy: false, auto: { tag: 'auto', reviewSessionId: 'rs1', prNumber: 12 } }]);
  });

  it("ne fait rien pour une tâche sans l'étiquette, ou aussi étiquetée en manuel", async () => {
    m.sessions = [reviewSession({})];
    m.tasks.t1.tags = ['backend'];
    await deliveryPolicyService.tick();
    m.tasks.t1.tags = ['auto', 'securite'];
    m.policy!.rules.push({ tag: 'securite', mode: 'manual' });
    await deliveryPolicyService.tick();
    expect(m.delivered).toEqual([]);
    expect(m.reviewsRequested).toEqual([]);
  });

  it("ne fusionne pas si le compte de fusion n'est plus administrateur du projet (une notification)", async () => {
    m.sessions = [reviewSession({})];
    m.role = 'member';
    await deliveryPolicyService.tick();
    await deliveryPolicyService.tick();
    expect(m.delivered).toEqual([]);
    expect(m.notified).toHaveLength(1);
  });

  it('ignore les PR sans tâche, d’un autre dépôt, et un refus de livraison immédiat ne remonte pas', async () => {
    m.sessions = [reviewSession({})];
    m.prs = [pr({ taskId: null }), pr({ id: 'pr2', repo: 'other/lib' })];
    await deliveryPolicyService.tick();
    expect(m.delivered).toEqual([]);
    m.prs = [pr()];
    m.deliverError = '2 fichier(s) non commité(s)';
    await expect(deliveryPolicyService.tick()).resolves.toBeUndefined();
  });

  it("n'agit pas sans règle de fusion automatique", async () => {
    m.policy = { projectId: 'p', rules: [{ tag: 'auto', mode: 'manual' }], mergeUserId: 'admin1', updatedAt: new Date() };
    await deliveryPolicyService.evaluateProject('p');
    expect(m.reviewsRequested).toEqual([]);
  });
});
