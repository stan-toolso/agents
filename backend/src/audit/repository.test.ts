import { describe, expect, it } from 'vitest';
import { filterSql } from './repository.js';
import { parseAuditFilter } from './types.js';

describe('filterSql', () => {
  it('projet seul', () => {
    expect(filterSql({ projectId: 'p1' })).toEqual({ where: 'project_id = $1', params: ['p1'] });
  });
  it('tous les filtres, paramètres numérotés dans l’ordre', () => {
    const from = new Date('2026-11-01T00:00:00Z');
    const { where, params } = filterSql({ projectId: 'p1', actorUserId: 'u1', actorKind: 'agent', targetType: 'task', action: 'task.status', from, before: '42' });
    expect(where).toBe('project_id = $1 AND actor_user_id = $2 AND session_id IS NOT NULL AND target_type = $3 AND action = $4 AND created_at >= $5 AND id < $6');
    expect(params).toEqual(['p1', 'u1', 'task', 'task.status', from, '42']);
  });
  it('ignore un curseur invalide', () => {
    expect(filterSql({ projectId: 'p1', before: '1; DROP TABLE x' }).where).toBe('project_id = $1');
  });
});

describe('parseAuditFilter', () => {
  it('normalise le type d’acteur et les dates', () => {
    expect(parseAuditFilter('p1', { actorKind: 'HUMAN', from: '2026-11-01', to: 'pas une date', targetType: '' })).toEqual({
      projectId: 'p1',
      actorUserId: null,
      actorKind: 'human',
      targetType: null,
      action: null,
      from: new Date('2026-11-01'),
      to: null,
    });
  });
});
