import { describe, expect, it } from 'vitest';
import { pickTaskPerBranch } from './repository.js';
import type { Task } from './types.js';

const task = (id: string, createdAt: string, status = 'done', branch = 'b', projectId = 'p') => ({ id, createdAt: new Date(createdAt), status, branch, projectId }) as unknown as Task;

describe('pickTaskPerBranch (tâche d’une branche)', () => {
  it('branche réutilisée : la tâche la plus récente, pas celle déjà livrée d’avant', () => {
    const found = pickTaskPerBranch([task('ancienne', '2026-11-03'), task('nouvelle', '2026-11-12')]);
    expect(found.get('p\u0000b')?.id).toBe('nouvelle');
  });
  it('l’ordre de lecture ne change rien', () => {
    expect(pickTaskPerBranch([task('nouvelle', '2026-11-12'), task('ancienne', '2026-11-03')]).get('p\u0000b')?.id).toBe('nouvelle');
  });
  it('une tâche annulée cède la place, même plus récente', () => {
    expect(pickTaskPerBranch([task('vivante', '2026-11-03'), task('annulée', '2026-11-12', 'cancelled')]).get('p\u0000b')?.id).toBe('vivante');
  });
  it('une clé par projet et branche ; sans branche, ignorée', () => {
    const found = pickTaskPerBranch([task('a', '2026-11-03', 'done', 'b', 'p1'), task('c', '2026-11-04', 'done', 'b', 'p2'), task('d', '2026-11-05', 'done', null as unknown as string)]);
    expect([...found.values()].map((t) => t.id).sort()).toEqual(['a', 'c']);
  });
});
