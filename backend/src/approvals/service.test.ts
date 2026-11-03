import { beforeEach, describe, expect, it, vi } from 'vitest';

// Services voisins simulés : on exerce la décision « accord implicite ou demande », la notification des administrateurs,
// la réponse réservée aux administrateurs et le message posté dans le fil (qui relance la session).
const m = vi.hoisted(() => ({
  roles: {} as Record<string, 'admin' | 'member' | 'viewer'>,
  users: {} as Record<string, { id: string; name: string; email: string; kind: 'person' | 'agent' }>,
  session: { id: 's1', name: 'Release', projectId: 'p', ownerId: 'agent', requestedById: 'stan' as string | null, takenOverById: null as string | null },
  pending: [] as Array<Record<string, unknown>>,
  stored: null as Record<string, unknown> | null,
  comments: [] as Array<{ body: string; actor: Record<string, unknown> }>,
  notified: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  cancelled: [] as string[],
  answered: [] as Array<[string, Record<string, unknown>, string]>,
}));

vi.mock('../config.js', () => ({ config: { appUrl: 'https://skipper.test' } }));
vi.mock('../log.js', () => ({ log: { warn: () => undefined, info: () => undefined, error: () => undefined } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: () => undefined } }));
vi.mock('../audit/service.js', () => ({ auditService: { record: async (e: Record<string, unknown>) => void m.audits.push(e) } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: Record<string, unknown>) => (m.notified.push(n), null) } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: async () => m.session } }));
vi.mock('../tasks/service.js', () => ({
  taskService: {
    get: async (id: string) => ({ id, projectId: 'p', title: 'Release du jour' }),
    addComment: async (_id: string, body: string, actor: Record<string, unknown>) => (m.comments.push({ body, actor }), { id: 'c' }),
    onTaskChanged: () => undefined,
  },
}));
vi.mock('../users/service.js', () => ({
  userService: {
    get: async (id: string) => {
      const u = m.users[id];
      if (!u) throw new Error('introuvable');
      return u;
    },
    roleFor: async (id: string) => m.roles[id] ?? null,
    members: async () => Object.entries(m.roles).map(([userId, role]) => ({ userId, role })),
  },
}));
vi.mock('../requests/repository.js', () => ({
  requestRepository: {
    list: async () => m.pending,
    create: async (sessionId: string, input: Record<string, unknown>) => (m.stored = { id: 'r1', sessionId, status: 'pending', ...input }),
    pendingApprovalsForTask: async () => m.pending,
  },
}));
vi.mock('../requests/service.js', () => ({
  requestService: {
    get: async () => m.stored,
    cancel: async (id: string, by?: string) => (m.cancelled.push(id), { ...m.stored, status: 'cancelled', answeredById: by ?? null }),
    cancelOnce: async (id: string, by?: string) => (m.cancelled.push(id), { request: { ...m.stored, status: 'cancelled', answeredById: by ?? null }, settled: true }),
    answerOnce: async (id: string, response: Record<string, unknown>, by: string) => (m.answered.push([id, response, by]), { request: { ...m.stored, status: 'answered', response, answeredById: by }, settled: true }),
  },
}));

const { approvalService, sessionRequester } = await import('./service.js');
const actor = { type: 'agent' as const, sessionId: 's1', name: 'Chris' };

beforeEach(() => {
  m.users = {
    stan: { id: 'stan', name: 'Stan', email: 'stan@x', kind: 'person' },
    lea: { id: 'lea', name: 'Léa', email: 'lea@x', kind: 'person' },
    agent: { id: 'agent', name: 'Chris', email: 'chris@agents', kind: 'agent' },
  };
  m.roles = { stan: 'admin', lea: 'member', agent: 'member' };
  m.session = { id: 's1', name: 'Release', projectId: 'p', ownerId: 'agent', requestedById: 'stan', takenOverById: null };
  m.pending = [];
  m.stored = null;
  m.comments = [];
  m.notified = [];
  m.audits = [];
  m.cancelled = [];
  m.answered = [];
});

describe('demandes d’accord', () => {
  it('la personne à l’origine de la session : prise en main, sinon demandeur, sinon propriétaire si c’est une personne', async () => {
    expect((await sessionRequester({ ownerId: 'agent', requestedById: 'lea', takenOverById: 'stan' }))?.id).toBe('stan');
    expect((await sessionRequester({ ownerId: 'agent', requestedById: 'lea', takenOverById: null }))?.id).toBe('lea');
    expect((await sessionRequester({ ownerId: 'stan', requestedById: null, takenOverById: null }))?.id).toBe('stan');
    expect(await sessionRequester({ ownerId: 'agent', requestedById: null, takenOverById: null })).toBeNull();
  });

  it('accord implicite quand la personne qui a demandé le travail est administrateur : aucune demande posée', async () => {
    const out = await approvalService.request({ projectId: 'p', sessionId: 's1', taskId: 't1', action: 'Mettre en production', actor });
    expect(out.implicit).toBe(true);
    expect(m.stored).toBeNull();
    expect(m.notified).toEqual([]);
    expect(m.comments[0].body).toContain('Accord implicite');
    expect(m.audits[0]).toMatchObject({ action: 'approval.implicit', targetId: 't1', details: { approvedBy: 'stan' } });
  });

  it('demandeur non administrateur : demande officielle, notifiée aux administrateurs seulement, annoncée dans le fil', async () => {
    m.session = { ...m.session, requestedById: 'lea' };
    const out = await approvalService.request({ projectId: 'p', sessionId: 's1', taskId: 't1', action: 'Mettre en production', details: 'PR #175 à #178', actor });
    expect(out.implicit).toBe(false);
    expect(m.stored).toMatchObject({ type: 'approval', title: 'Mettre en production', message: 'PR #175 à #178', payload: { taskId: 't1', taskTitle: 'Release du jour' } });
    expect(m.notified.map((n) => n.userId)).toEqual(['stan']);
    expect(m.notified[0]).toMatchObject({ type: 'request.created', payload: { requestType: 'approval', requestId: 'r1' } });
    expect(m.comments[0].body).toContain("Demande d'accord officielle");
    expect(m.comments[0].actor).toBe(actor);
  });

  it('une nouvelle demande remplace celle que la session attendait pour la même tâche', async () => {
    m.session = { ...m.session, requestedById: null };
    m.pending = [{ id: 'old', type: 'approval', payload: { taskId: 't1' } }, { id: 'other', type: 'approval', payload: { taskId: 't2' } }, { id: 'perm', type: 'permission', payload: {} }];
    await approvalService.request({ projectId: 'p', sessionId: 's1', taskId: 't1', action: 'Déployer', actor });
    expect(m.cancelled).toEqual(['old']);
  });

  it('seul un administrateur répond ; la décision est postée en son nom et mentionne la session', async () => {
    m.stored = { id: 'r1', sessionId: 's1', type: 'approval', status: 'pending', title: 'Mettre en production', payload: { taskId: 't1', taskTitle: 'Release' } };
    await expect(approvalService.answer('r1', { decision: 'approve' }, m.users.lea as never)).rejects.toThrow(/administrateur/);
    await expect(approvalService.answer('r1', { decision: 'peut-être' }, m.users.stan as never)).rejects.toThrow(/approve ou deny/);
    await approvalService.answer('r1', { decision: 'approve', message: '  go  ' }, m.users.stan as never);
    expect(m.answered).toEqual([['r1', { decision: 'approve', message: 'go' }, 'stan']]);
    expect(m.comments[0].actor).toMatchObject({ type: 'human', userId: 'stan' });
    expect(m.comments[0].body).toMatch(/^✅ J'accorde : \*\*Mettre en production\*\*\. @session:s1/);
    expect(m.comments[0].body).toContain('go');
    await approvalService.answer('r1', { decision: 'deny' }, m.users.stan as never);
    expect(m.comments[1].body).toMatch(/^❌ Je refuse/);
  });

  it('écarter une demande prévient la session par le fil ; refusé à un non-administrateur', async () => {
    m.stored = { id: 'r1', sessionId: 's1', type: 'approval', status: 'pending', title: 'Déployer', payload: { taskId: 't1' } };
    await expect(approvalService.cancel('r1', m.users.lea as never)).rejects.toThrow(/administrateur/);
    await approvalService.cancel('r1', m.users.stan as never);
    expect(m.comments[0].body).toContain('écartée');
  });

  it('une tâche fermée annule ses demandes d’accord en attente', async () => {
    m.pending = [{ id: 'a' }, { id: 'b' }];
    expect(await approvalService.cancelForTask('t1')).toBe(2);
    expect(m.cancelled).toEqual(['a', 'b']);
  });
});
