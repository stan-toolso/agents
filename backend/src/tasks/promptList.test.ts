import { describe, expect, it } from 'vitest';
import { promptTasks } from './promptList.js';

type T = { id: string; status: 'todo' | 'in_progress'; priority: 'urgent' | 'high' | 'medium' | 'low'; sessionIds: string[] };
const task = (id: string, priority: T['priority'], status: T['status'] = 'todo', sessionIds: string[] = []): T => ({ id, status, priority, sessionIds });

describe('promptTasks', () => {
  it('liste tout sous la limite, les tâches de la session puis en cours puis par priorité', () => {
    const open = [task('a', 'low'), task('b', 'high'), task('c', 'medium', 'in_progress'), task('d', 'low', 'todo', ['s1']), task('e', 'high')];
    const { shown, hidden } = promptTasks(open, 's1');
    expect(shown.map((t) => t.id)).toEqual(['d', 'c', 'b', 'e', 'a']);
    expect(hidden).toEqual([]);
  });

  it('plafonne la liste et renvoie le reste', () => {
    const open = Array.from({ length: 20 }, (_, i) => task(`t${i}`, i < 3 ? 'urgent' : 'low'));
    const { shown, hidden } = promptTasks(open, undefined, 5);
    expect(shown.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(hidden).toHaveLength(15);
  });

  it('garde toujours les tâches de la session, même basses', () => {
    const open = [...Array.from({ length: 10 }, (_, i) => task(`h${i}`, 'urgent')), task('mine', 'low', 'todo', ['s1'])];
    expect(promptTasks(open, 's1', 3).shown.map((t) => t.id)).toEqual(['mine', 'h0', 'h1']);
  });
});
