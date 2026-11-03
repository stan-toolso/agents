import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; name: string; kind: string }>,
  roles: {} as Record<string, string | null>,
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

const { askMergeApproval } = await import('./mergeApproval.js');
const { ANSWERED_BY, RequestCancelledError } = await import('../requests/service.js');

const approval = { projectId: 'p', ref: '#161', title: 'Titres de session', url: 'https://github.com/acme/app/pull/161', method: 'MERGE', input: { id: '#161' } };

beforeEach(() => {
  m.users = { stan: { id: 'stan', name: 'Stan', kind: 'person' }, lea: { id: 'lea', name: 'Léa', kind: 'person' }, ben: { id: 'ben', name: 'Ben', kind: 'agent' } };
  m.roles = { stan: 'admin', lea: 'viewer', ben: 'member' };
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
