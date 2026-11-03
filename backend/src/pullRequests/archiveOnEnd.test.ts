import { beforeEach, describe, expect, it, vi } from 'vitest';

const archiveWhenDone = vi.fn(async () => true);
const list = vi.fn();
vi.mock('../sessions/service.js', () => ({ sessionService: { list: (...a: unknown[]) => list(...a), archiveWhenDone: (...a: unknown[]) => archiveWhenDone(...(a as [])) } }));
vi.mock('../agents/service.js', () => ({ agentService: { forUser: async (id: string | null) => (id === 'ben' ? { id: 'ben' } : null) } }));
vi.mock('../worksessions/repository.js', () => ({
  worksessionRepository: { listByProject: async () => [{ id: 'w1', branch: 'feature' }, { id: 'w2', branch: 'other' }] },
}));
import { archiveAgentSessionsOfPullRequest, archivedOnPullRequestEnd } from './archiveOnEnd.js';
import { archivePromptSummary } from '../sessions/mcp.js';
import type { Session } from '../sessions/types.js';
import type { TrackedPullRequest } from './types.js';

vi.mock('../worksessions/service.js', () => ({ worksessionService: {} }));
vi.mock('../projects/service.js', () => ({ projectService: {} }));

const session = (over: Partial<Session> = {}) =>
  ({ id: 's1', ownerId: 'ben', archivedAt: null, takenOverById: null, parentSessionId: null, kind: 'session', config: {}, ...over }) as Session;
const pr = { projectId: 'p1', worksessionId: null, headBranch: 'feature', number: 160, status: 'merged' } as unknown as TrackedPullRequest;

describe('sessions d’agent rangées à la fin de leur PR', () => {
  beforeEach(() => {
    archiveWhenDone.mockClear();
    list.mockReset();
  });

  it('ne range que les sessions d’agent non prises en main', () => {
    expect(archivedOnPullRequestEnd(session(), true)).toBe(true);
    expect(archivedOnPullRequestEnd(session(), false)).toBe(false);
    expect(archivedOnPullRequestEnd(session({ takenOverById: 'u1' }), true)).toBe(false);
    expect(archivedOnPullRequestEnd(session({ parentSessionId: 's0' }), true)).toBe(false);
    expect(archivedOnPullRequestEnd(session({ config: { review: { pullRequestId: 'x' } } }), true)).toBe(false);
  });

  it('archive (de force) les sessions d’agent du dossier de la PR fusionnée', async () => {
    list.mockImplementation(async ({ worksessionId }: { worksessionId: string }) =>
      worksessionId === 'w1' ? [session(), session({ id: 's2', ownerId: 'stan' })] : [session({ id: 's3' })],
    );
    expect(await archiveAgentSessionsOfPullRequest(pr)).toBe(1);
    expect(archiveWhenDone).toHaveBeenCalledWith('s1', 'PR #160 fusionnée', { force: true });
  });

  it('le prompt d’un agent ne compte plus « PR ouverte » comme travail rendu', () => {
    expect(archivePromptSummary({ agent: true })).toContain("n'est plus ouverte");
    expect(archivePromptSummary({ agent: true, auto: true })).toContain('tant que la PR de ton dossier est ouverte');
  });
});
