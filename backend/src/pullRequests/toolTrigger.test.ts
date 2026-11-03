import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('./service.js', () => ({
  trackedPullRequestService: {
    sync: async (projectId: string, userId: string | null, opts: { force?: boolean }) => {
      calls.push(`sync:${projectId}:${userId}:${opts.force}`);
      return [];
    },
    refreshPending: async (project: { id: string }) => {
      calls.push(`local:${project.id}`);
    },
  },
}));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, gitUrl: 'https://github.com/acme/app' }) } }));
vi.mock('../log.js', () => ({ log: { error: () => undefined } }));

const { pullRequestImpact, syncAfterTool, pendingToolSyncs } = await import('./toolTrigger.js');

describe('pullRequestImpact', () => {
  it('reconnaît ce qui touche GitHub, ce qui ne touche que le travail local, et ignore le reste', () => {
    expect(pullRequestImpact('Bash', { command: 'git push -u origin HEAD' })).toBe('github');
    expect(pullRequestImpact('Bash', { command: 'cd x && git -C sub push' })).toBe('github');
    expect(pullRequestImpact('Bash', { command: 'gh pr merge 12 --squash' })).toBe('github');
    expect(pullRequestImpact('Bash', { command: 'git commit -qm "x"' })).toBe('local');
    expect(pullRequestImpact('Bash', { command: 'git status && git log --oneline' })).toBeNull();
    expect(pullRequestImpact('Bash', { command: 'npm test' })).toBeNull();
    expect(pullRequestImpact('Edit', { file_path: 'a.ts' })).toBe('local');
    expect(pullRequestImpact('Read', { file_path: 'a.ts' })).toBeNull();
    expect(pullRequestImpact('mcp__tasks__pr_open', {})).toBe('github');
    expect(pullRequestImpact('mcp__tasks__list', {})).toBeNull();
    expect(pullRequestImpact('mcp__vault__http_request', { url: 'https://api.github.com/repos/acme/app/pulls/12/merge', method: 'PUT' })).toBe('github');
    expect(pullRequestImpact('mcp__vault__http_request', { url: 'https://example.com/pulls' })).toBeNull();
  });
});

describe('syncAfterTool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('regroupe une rafale par projet et ne relit GitHub que si un appel le demande', async () => {
    syncAfterTool('p', 'u1', 'Edit', {});
    syncAfterTool('p', 'u1', 'Write', {});
    expect(pendingToolSyncs().get('p')).toEqual({ impact: 'local', userId: 'u1' });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(calls).toEqual(['local:p']);
    syncAfterTool('p', 'u1', 'Edit', {});
    syncAfterTool('p', 'u1', 'Bash', { command: 'git push' });
    syncAfterTool('q', null, 'Read', {});
    await vi.advanceTimersByTimeAsync(3_100);
    expect(calls).toEqual(['local:p', 'sync:p:u1:true']);
    expect(pendingToolSyncs().size).toBe(0);
  });

  it('ne repousse pas indéfiniment : relit au plus tard 15 s après le premier appel', async () => {
    for (let i = 0; i < 10; i++) {
      syncAfterTool('r', 'u1', 'Edit', {});
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(calls).toEqual(['local:r']);
  });
});
