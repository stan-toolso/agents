import { describe, expect, it, vi } from 'vitest';

vi.mock('../apollo', () => ({ apiBaseUrl: 'https://api.example' }));
const { actorFilter, auditCsvUrl, auditDetailSummary, auditTargetLink, periodFilter } = await import('./audit');

describe('auditDetailSummary', () => {
  it('statut de tâche', () => {
    expect(auditDetailSummary({ action: 'task.status', details: { from: 'todo', to: 'done' } })).toBe('À faire → Terminée');
  });
  it('réponse à une demande d’autorisation', () => {
    expect(auditDetailSummary({ action: 'request.answer', details: { decision: 'allow', always: true, scope: 'project', rules: ['Bash(git status *)'] } })).toBe('Autorisé pour le projet : Bash(git status *)');
    expect(auditDetailSummary({ action: 'request.answer', details: { decision: 'deny', message: 'pas en prod' } })).toBe('Refusé (« pas en prod »)');
    expect(auditDetailSummary({ action: 'request.answer', details: { answers: { 'Base ?': 'staging' } } })).toBe('staging');
  });
  it('commit : première ligne du message', () => {
    expect(auditDetailSummary({ action: 'git.commit', details: { message: 'Ajoute le journal\n\ncorps' } })).toBe('« Ajoute le journal »');
  });
  it('par défaut : clé : valeur, vides omis', () => {
    expect(auditDetailSummary({ action: 'vault.update', details: { fields: ['host', 'port'], empty: '', none: null } })).toBe('champs : host, port');
    expect(auditDetailSummary({ action: 'task.create', details: { status: 'todo', priority: 'high' } })).toBe('À faire · priorité haute');
  });
});

describe('auditTargetLink', () => {
  it('pages des cibles, rien pour une suppression', () => {
    expect(auditTargetLink({ targetType: 'session', targetId: 's1', action: 'session.stop' }, 'p1')).toBe('/sessions/s1');
    expect(auditTargetLink({ targetType: 'agent', targetId: 'a1', action: 'agent.update' }, 'p1')).toBe('/projects/p1/agents/a1');
    expect(auditTargetLink({ targetType: 'task', targetId: 't1', action: 'task.delete' }, 'p1')).toBeNull();
    expect(auditTargetLink({ targetType: 'git', targetId: 'w1', action: 'git.push' }, 'p1')).toBeNull();
  });
});

describe('filtres', () => {
  it('acteur', () => {
    expect(actorFilter('')).toEqual({});
    expect(actorFilter('kind:AGENT')).toEqual({ actorKind: 'AGENT' });
    expect(actorFilter('user:u1')).toEqual({ actorUserId: 'u1' });
  });
  it('période : fin incluse jusqu’au lendemain minuit', () => {
    const { from, to } = periodFilter('2026-11-01', '2026-11-03');
    expect(new Date(from!).getDate()).toBe(1);
    expect(new Date(to!).getDate()).toBe(4);
    expect(periodFilter('', '')).toEqual({ from: null, to: null });
  });
  it('URL de l’export', () => {
    expect(auditCsvUrl('p1', {})).toBe('https://api.example/api/projects/p1/audit.csv');
    expect(auditCsvUrl('p1', { actorKind: 'HUMAN', targetType: 'task', action: null })).toBe('https://api.example/api/projects/p1/audit.csv?actorKind=HUMAN&targetType=task');
  });
});
