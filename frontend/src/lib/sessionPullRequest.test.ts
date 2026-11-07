import { describe, expect, it } from 'vitest';
import { advancePendingAction, pendingActionStatus, PENDING_START_TIMEOUT_MS, pullRequestCardActions, pullRequestCardStatus, pullRequestInstruction, showsPullRequestCard } from './sessionPullRequest';

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

  it('suit une action en cours d’après l’activité de la session', () => {
    const start = { prId: 'p', action: 'merge' as const, at: 0, sawBusy: false };
    const idle = { busy: false, awaitingApproval: false };
    // Pas encore prise par l'agent : reste en cours, puis abandonnée passé le délai.
    expect(advancePendingAction(start, { ...idle, now: 1000 })).toEqual(start);
    expect(advancePendingAction(start, { ...idle, now: PENDING_START_TIMEOUT_MS + 1 })).toBeNull();
    // L'agent travaille, puis demande l'accord : toujours en cours.
    const working = advancePendingAction(start, { busy: true, awaitingApproval: false, now: 2000 });
    expect(working?.sawBusy).toBe(true);
    expect(advancePendingAction(working, { busy: false, awaitingApproval: true, now: 3000 })).toEqual(working);
    // Fin du tour sans demande en suspens : terminée.
    expect(advancePendingAction(working, { ...idle, now: 4000 })).toBeNull();
    // Envoyée pendant un tour déjà en cours : la fin de ce tour ne la termine pas.
    const queued = { ...start, queued: true };
    expect(advancePendingAction(queued, { busy: true, awaitingApproval: false, now: 1000 })).toEqual(queued);
    const afterQueue = advancePendingAction(queued, { ...idle, now: 5000 });
    expect(afterQueue).toMatchObject({ queued: false, sawBusy: false, at: 5000 });
    expect(pendingActionStatus('merge', true)).toContain('accord');
    expect(pendingActionStatus('merge', false)).toContain('fusionne');
  });
});
