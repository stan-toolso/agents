import { describe, expect, it } from 'vitest';
import { nextStep, stateText, requestInstruction, requestSummary, type NextStepPr } from './pullRequestNextStep';

const session = { id: 's1', name: 'Ma session', status: 'RUNNING', activity: 'IDLE' };
const pr = (over: Partial<NextStepPr> = {}): NextStepPr => ({
  number: 42,
  repo: 'o/r',
  foreignRepo: false,
  headBranch: 'feat/x',
  baseBranch: 'main',
  title: 'Ma PR',
  stage: 'TO_MERGE',
  status: 'OPEN',
  mergeable: 'MERGEABLE',
  checksState: 'SUCCESS',
  reviewDecision: null,
  url: 'https://github.com/o/r/pull/42',
  localCommits: null,
  localChanges: null,
  task: { id: 't1', title: 'Ma tâche' },
  session,
  ...over,
});

describe('prochaine étape d’une PR', () => {
  it('une PR prête attend la décision de la personne', () => {
    const s = nextStep(pr());
    expect(s).toMatchObject({ label: 'Prête à fusionner', tone: 'you', requests: ['merge', 'close'] });
    expect(s.detail).toContain('CI verte');
  });

  it('ce qui bloque passe d’abord', () => {
    expect(nextStep(pr({ mergeable: 'CONFLICTING', checksState: 'FAILURE' }))).toMatchObject({ label: 'En conflit', tone: 'blocked', requests: ['resolveConflicts', 'fixCi', 'merge', 'close'] });
    expect(nextStep(pr({ checksState: 'ERROR' }))).toMatchObject({ label: 'CI en échec', requests: ['fixCi', 'merge', 'close'] });
    expect(nextStep(pr({ checksState: 'PENDING' }))).toMatchObject({ label: 'CI en cours', tone: 'wait' });
    expect(nextStep(pr({ reviewDecision: 'CHANGES_REQUESTED' })).tone).toBe('blocked');
  });

  it('sans session, aucune demande n’est proposée', () => {
    const s = nextStep(pr({ session: null }));
    expect(s.tone).toBe('orphan');
    expect(s.requests).toEqual([]);
    expect(s.detail).toContain('Aucune session');
  });

  it('une branche en préparation est à ouvrir, sauf si l’agent y travaille', () => {
    const pending = { stage: 'PENDING' as const, status: 'PENDING' as const, number: null, url: '', localCommits: 3, localChanges: 1 };
    expect(nextStep(pr(pending))).toMatchObject({ label: 'À ouvrir', tone: 'you', requests: ['open'] });
    expect(nextStep(pr(pending)).detail).toContain('3 commits, 1 fichier non commité');
    expect(nextStep(pr({ ...pending, session: { ...session, activity: 'BUSY' } }))).toMatchObject({ label: 'En cours', tone: 'agent' });
    expect(nextStep(pr({ ...pending, session: null }))).toMatchObject({ tone: 'orphan', requests: [] });
  });

  it('un brouillon est chez l’agent ; une PR terminée n’attend rien', () => {
    expect(nextStep(pr({ stage: 'DRAFT' }))).toMatchObject({ tone: 'agent', requests: ['close'] });
    expect(nextStep(pr({ stage: 'MERGED', status: 'MERGED' }))).toMatchObject({ tone: 'done', requests: [] });
    expect(nextStep(pr({ stage: 'CANCELLED', status: 'CLOSED' }))).toMatchObject({ tone: 'done', requests: [] });
  });

  it('écrit l’instruction envoyée à la session', () => {
    expect(requestInstruction('merge', pr())).toContain('tasks.pr_merge');
    const open = requestInstruction('open', pr({ stage: 'PENDING', number: null }));
    expect(open).toContain('tasks.pr_open');
    expect(open).toContain('« Ma tâche » (t1)');
    expect(requestInstruction('open', pr({ stage: 'PENDING', number: null, task: null }))).toContain('crée-la si besoin');
    expect(requestSummary('merge', pr())).toContain('#42 dans main');
  });

  it('décrit l’état en mots', () => {
    expect(stateText(pr())).toBe('CI verte · sans conflit');
    expect(stateText(pr({ checksState: null, mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' }))).toBe('pas de CI signalée · en conflit avec main · revue approuvée');
  });
});
