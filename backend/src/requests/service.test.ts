import { beforeEach, describe, expect, it, vi } from 'vitest';

type Stored = { id: string; sessionId: string; type: string; status: string; response: Record<string, unknown> | null; answeredById: string | null };
const m = vi.hoisted(() => ({ stored: null as unknown as Stored, published: 0 }));
vi.mock('./repository.js', () => ({
  requestRepository: {
    create: async () => ({ ...m.stored }),
    findById: async () => ({ ...m.stored }),
    // Comme la requête SQL : seule une demande en attente change d'état.
    settle: async (_id: string, status: string, response: Record<string, unknown> | null, by: string | null) => {
      if (m.stored.status !== 'pending') return null;
      m.stored = { ...m.stored, status, response, answeredById: by };
      return { ...m.stored };
    },
  },
}));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async (id: string) => ({ id, name: 'Stan', email: 'stan@x' }) } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: () => void m.published++ } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { markReadForRequests: async () => undefined } }));

const { ANSWERED_BY, REQUEST_SETTLED, requestService, sameResponse } = await import('./service.js');

beforeEach(() => {
  m.stored = { id: 'r1', sessionId: 's1', type: 'permission', status: 'pending', response: null, answeredById: null };
  m.published = 0;
});

describe('requestService', () => {
  it("remet à l'agent qui attend la réponse et la personne qui l'a donnée", async () => {
    const waiting = requestService.ask('s1', { type: 'permission', title: 'Fusionner ?' });
    await new Promise((r) => setTimeout(r, 0));
    await requestService.answer('r1', { decision: 'allow' }, 'stan');
    expect(await waiting).toEqual({ decision: 'allow', [ANSWERED_BY]: 'stan' });
  });

  it('accepte sans erreur la même réponse envoyée deux fois (double clic, Entrée répété, deux onglets)', async () => {
    const first = await requestService.answerOnce('r1', { decision: 'allow', scope: 'session', rules: ['Bash(npm:*)'] }, 'stan');
    const again = await requestService.answerOnce('r1', { rules: ['Bash(npm:*)'], scope: 'session', decision: 'allow' }, 'lea');
    expect(first.settled).toBe(true);
    expect(again.settled).toBe(false);
    expect(again.request.answeredById).toBe('stan');
    expect(m.published).toBe(1);
  });

  it('refuse une réponse différente en disant qui a déjà traité la demande', async () => {
    await requestService.answer('r1', { decision: 'allow' }, 'stan');
    await expect(requestService.answer('r1', { decision: 'deny' }, 'lea')).rejects.toMatchObject({ code: REQUEST_SETTLED, message: 'Cette demande a déjà été traitée par Stan' });
  });

  it('refuse une réponse à une demande ignorée', async () => {
    await requestService.cancel('r1', 'stan');
    await expect(requestService.answer('r1', { decision: 'allow' }, 'lea')).rejects.toMatchObject({ code: REQUEST_SETTLED, message: 'Cette demande a déjà été ignorée par Stan' });
  });

  it("ne règle une annulation qu'une fois", async () => {
    expect((await requestService.cancelOnce('r1', 'stan')).settled).toBe(true);
    expect((await requestService.cancelOnce('r1', 'stan')).settled).toBe(false);
  });

  it("compare les réponses sans tenir compte de l'ordre des clés ni des champs indéfinis", () => {
    expect(sameResponse({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1, d: undefined })).toBe(true);
    expect(sameResponse({ decision: 'deny' }, { decision: 'deny', message: 'non' })).toBe(false);
  });
});
