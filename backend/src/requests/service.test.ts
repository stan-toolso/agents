import { describe, expect, it, vi } from 'vitest';

const stored = { id: 'r1', sessionId: 's1', type: 'permission', status: 'pending', response: null as Record<string, unknown> | null, answeredById: null as string | null };
vi.mock('./repository.js', () => ({
  requestRepository: {
    create: async () => ({ ...stored }),
    settle: async (_id: string, status: string, response: Record<string, unknown> | null, by: string | null) => ({ ...stored, status, response, answeredById: by }),
  },
}));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: () => undefined } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { markReadForRequests: async () => undefined } }));

const { ANSWERED_BY, requestService } = await import('./service.js');

describe('requestService', () => {
  it("remet à l'agent qui attend la réponse et la personne qui l'a donnée", async () => {
    const waiting = requestService.ask('s1', { type: 'permission', title: 'Fusionner ?' });
    await new Promise((r) => setTimeout(r, 0));
    await requestService.answer('r1', { decision: 'allow' }, 'stan');
    expect(await waiting).toEqual({ decision: 'allow', [ANSWERED_BY]: 'stan' });
  });
});
