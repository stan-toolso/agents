import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; name: string; kind: string }>,
  roles: {} as Record<string, string | null>,
  session: null as null | { ownerId: string | null; requestedById: string | null; takenOverById: string | null; config: Record<string, unknown> },
  audit: [] as Array<Record<string, unknown>>,
}));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: async () => m.session } }));
vi.mock('../audit/service.js', () => ({ auditService: { record: async (e: Record<string, unknown>) => void m.audit.push(e) } }));
vi.mock('../approvals/service.js', () => ({
  // Même ordre que le vrai : prise en main, demandeur, propriétaire ; seulement une personne.
  sessionRequester: async (s: { ownerId: string | null; requestedById: string | null; takenOverById: string | null }) => {
    for (const id of [s.takenOverById, s.requestedById, s.ownerId]) if (id && m.users[id]?.kind === 'person') return m.users[id];
    return null;
  },
}));
vi.mock('../users/service.js', () => ({
  userService: {
    get: async (id: string) => {
      const u = m.users[id];
      if (!u) throw new Error('Utilisateur introuvable');
      return u;
    },
    roleFor: async (id: string) => m.roles[id] ?? null,
  },
}));

const { askMergeApproval, implicitMergeApprover, sessionMergeApprover } = await import('./mergeApproval.js');
const { ANSWERED_BY, RequestCancelledError } = await import('../requests/service.js');

const approval = { projectId: 'p', ref: '#161', title: 'Titres de session', url: 'https://github.com/acme/app/pull/161', method: 'MERGE', input: { id: '#161' } };

beforeEach(() => {
  m.users = { stan: { id: 'stan', name: 'Stan', kind: 'person' }, lea: { id: 'lea', name: 'Léa', kind: 'person' }, ben: { id: 'ben', name: 'Ben', kind: 'agent' } };
  m.roles = { stan: 'admin', lea: 'viewer', ben: 'member' };
  m.session = { ownerId: 'stan', requestedById: null, takenOverById: null, config: { permissionMode: 'bypassPermissions' } };
  m.audit = [];
});

describe('askMergeApproval', () => {
  it("renvoie la personne qui accepte, après une demande jamais mémorisable", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const userId = await askMergeApproval(async (input) => (asked.push(input as unknown as Record<string, unknown>), { decision: 'allow', [ANSWERED_BY]: 'stan' }), approval);
    expect(userId).toBe('stan');
    expect(asked[0]).toMatchObject({ type: 'permission', payload: { toolName: 'mcp__tasks__pr_merge', suggestions: [], merge: true } });
    expect(String(asked[0].message)).toContain('avec votre compte');
  });

  it('refuse un refus, une annulation, une réponse anonyme, un lecteur ou un agent', async () => {
    await expect(askMergeApproval(async () => ({ decision: 'deny', message: 'Pas maintenant' }), approval)).rejects.toThrow('Pas maintenant');
    await expect(askMergeApproval(async () => { throw new RequestCancelledError({ id: 'r', status: 'cancelled' } as never); }, approval)).rejects.toThrow('Demande annulée');
    await expect(askMergeApproval(async () => ({ decision: 'allow' }), approval)).rejects.toThrow('sans personne identifiée');
    await expect(askMergeApproval(async () => ({ decision: 'allow', [ANSWERED_BY]: 'lea' }), approval)).rejects.toThrow('rôle membre');
    await expect(askMergeApproval(async () => ({ decision: 'allow', [ANSWERED_BY]: 'ben' }), approval)).rejects.toThrow('Seule une personne');
  });
});

describe('accord implicite (mode « Tout autoriser »)', () => {
  it('accorde à la personne qui pilote la session, au moins membre, seulement en bypassPermissions', async () => {
    expect((await implicitMergeApprover('s', 'p'))?.id).toBe('stan');
    m.session!.config = { permissionMode: 'dontAsk' };
    expect(await implicitMergeApprover('s', 'p')).toBeNull();
    m.session!.config = {};
    expect(await implicitMergeApprover('s', 'p')).toBeNull();
  });

  it("refuse un lecteur et une session d'agent lancée sans personne ; suit la prise en main", async () => {
    m.session = { ownerId: 'lea', requestedById: null, takenOverById: null, config: { permissionMode: 'bypassPermissions' } };
    expect(await implicitMergeApprover('s', 'p')).toBeNull();
    m.session = { ownerId: 'ben', requestedById: null, takenOverById: null, config: { permissionMode: 'bypassPermissions' } };
    expect(await implicitMergeApprover('s', 'p')).toBeNull();
    m.session = { ownerId: 'ben', requestedById: null, takenOverById: 'stan', config: { permissionMode: 'bypassPermissions' } };
    expect((await implicitMergeApprover('s', 'p'))?.id).toBe('stan');
  });

  it('fusionne sans demande et le trace (transcript, journal) ; pose la demande hors de ce mode', async () => {
    const asked: unknown[] = [];
    const emitted: unknown[] = [];
    const ctx = { session: { id: 's' }, ask: async (input: unknown) => (asked.push(input), { decision: 'allow', [ANSWERED_BY]: 'stan' }), emit: async (_t: string, p?: unknown) => void emitted.push(p) };
    expect(await sessionMergeApprover(ctx)(approval)).toBe('stan');
    expect(asked).toHaveLength(0);
    expect(String((emitted[0] as { message: string }).message)).toContain('implicitement');
    expect(m.audit[0]).toMatchObject({ action: 'pull_request.merge_implicit', details: { approvedBy: 'stan' } });

    m.session!.config = { permissionMode: 'default' };
    expect(await sessionMergeApprover(ctx)(approval)).toBe('stan');
    expect(asked).toHaveLength(1);
  });
});
