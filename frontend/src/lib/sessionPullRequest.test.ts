import { describe, expect, it } from 'vitest';
import { pullRequestCardActions, pullRequestCardStatus, pullRequestInstruction, showsPullRequestCard } from './sessionPullRequest';

const pr = (over: Record<string, unknown> = {}) =>
  ({ number: 42, repo: 'o/r', foreignRepo: false, headBranch: 'feat/x', baseBranch: 'main', title: 'Ma PR', stage: 'TO_MERGE', mergeable: 'MERGEABLE', checksState: 'SUCCESS', url: 'https://github.com/o/r/pull/42', ...over }) as Parameters<typeof pullRequestCardActions>[0];

describe('carte de PR de la session', () => {
  it('ne se montre que pour une PR à fusionner', () => {
    expect(showsPullRequestCard(pr())).toBe(true);
    expect(showsPullRequestCard(pr({ stage: 'DRAFT' }))).toBe(false);
    expect(showsPullRequestCard(pr({ stage: 'PENDING', number: null }))).toBe(false);
    expect(showsPullRequestCard(pr({ stage: 'MERGED' }))).toBe(false);
    expect(showsPullRequestCard(null)).toBe(false);
  });

  it('propose d’abord ce qui débloque la fusion', () => {
    expect(pullRequestCardActions(pr())).toEqual(['merge', 'close']);
    expect(pullRequestCardActions(pr({ mergeable: 'CONFLICTING', checksState: 'FAILURE' }))).toEqual(['resolveConflicts', 'fixCi', 'merge', 'close']);
    expect(pullRequestCardStatus(pr({ mergeable: 'CONFLICTING' })).tone).toBe('bad');
    expect(pullRequestCardStatus(pr({ checksState: 'PENDING' })).text).toBe('CI en cours');
  });

  it('écrit des instructions qui nomment la PR et l’outil à utiliser', () => {
    expect(pullRequestInstruction('merge', pr())).toContain('#42 « Ma PR »');
    expect(pullRequestInstruction('merge', pr())).toContain('tasks.pr_merge');
    expect(pullRequestInstruction('close', pr(), ' plus utile ')).toContain('tasks.pr_close, avec ce commentaire : « plus utile »');
    expect(pullRequestInstruction('close', pr())).not.toContain('commentaire');
    expect(pullRequestInstruction('resolveConflicts', pr())).toMatch(/^La pull request #42.*origin\/main dans feat\/x/);
    expect(pullRequestInstruction('fixCi', pr({ foreignRepo: true }))).toContain('o/r#42');
  });
});
