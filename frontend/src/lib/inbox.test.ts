import { describe, expect, it } from 'vitest';
import { buildInboxItems, filterInboxItems, inboxProjects, sessionReason } from './inbox';

const req = (id: string, createdAt: string, project = 'p1') => ({ id, createdAt, session: { id: `s-${id}`, name: 'S', project: { id: project, name: project.toUpperCase() } } }) as any;
const ses = (id: string, status: string, updatedAt: string, project = 'p1') => ({ id, status, updatedAt, endedAt: null, project: { id: project, name: project.toUpperCase() } }) as any;
const pr = (id: string, isDraft: boolean, openedAt: string, project = 'p1') => ({ id, isDraft, openedAt, project: { id: project, name: project.toUpperCase() } }) as any;

describe('file À traiter', () => {
  const items = buildInboxItems({
    requests: [req('r2', '2026-01-02T00:00:00Z'), req('r1', '2026-01-01T00:00:00Z', 'p2')],
    sessions: [ses('fail', 'FAILED', '2026-01-03T00:00:00Z'), ses('int', 'INTERRUPTED', '2026-01-02T00:00:00Z', 'p2')],
    pullRequests: [pr('draft', true, '2025-12-01T00:00:00Z'), pr('merge', false, '2025-12-02T00:00:00Z')],
  });

  it('trie par urgence puis par ancienneté', () => {
    expect(items.map((i) => i.key)).toEqual(['request:r1', 'request:r2', 'session:int', 'session:fail', 'pr:merge', 'pr:draft']);
  });

  it('déduit la raison d\'une session', () => {
    expect(sessionReason({ status: 'FAILED' })).toBe('failed');
    expect(sessionReason({ status: 'INTERRUPTED' })).toBe('interrupted');
  });

  it('filtre par projet et par nature', () => {
    expect(filterInboxItems(items, { projectId: 'p2' }).map((i) => i.key)).toEqual(['request:r1', 'session:int']);
    expect(filterInboxItems(items, { kind: 'pullRequest' })).toHaveLength(2);
    expect(filterInboxItems(items, { projectId: 'p2', kind: 'pullRequest' })).toHaveLength(0);
    expect(filterInboxItems(items, { projectId: '', kind: '' })).toHaveLength(6);
  });

  it('range une tâche « agent arrêté » après les sessions à reprendre et avant les PR', () => {
    const withTasks = buildInboxItems({
      requests: [],
      sessions: [ses('int', 'INTERRUPTED', '2026-01-02T00:00:00Z')],
      tasks: [{ id: 't1', stalledSince: '2026-01-01T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z', project: { id: 'p3', name: 'P3' } } as any],
      pullRequests: [pr('merge', false, '2025-12-02T00:00:00Z')],
    });
    expect(withTasks.map((i) => i.key)).toEqual(['session:int', 'task:t1', 'pr:merge']);
    expect(filterInboxItems(withTasks, { kind: 'task' }).map((i) => i.projectId)).toEqual(['p3']);
  });

  it('compte les éléments par projet', () => {
    expect(inboxProjects(items)).toEqual([
      { id: 'p1', name: 'P1', count: 4 },
      { id: 'p2', name: 'P2', count: 2 },
    ]);
  });
});
