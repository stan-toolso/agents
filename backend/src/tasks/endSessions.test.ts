import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './types.js';

const endForTask = vi.hoisted(() => vi.fn(async () => 'ended' as const));
const listForSession = vi.hoisted(() => vi.fn(async (_id: string): Promise<Task[]> => []));
vi.mock('../sessions/service.js', () => ({ sessionService: { endForTask } }));
vi.mock('./repository.js', () => ({ taskRepository: { listForSession } }));
vi.mock('./service.js', () => ({ taskService: { onTaskChanged: vi.fn() } }));
const { endSessionsOfClosedTask } = await import('./endSessions.js');

const task = (over: Partial<Task> = {}): Task => ({ id: 't1', title: 'Corriger le bug', status: 'in_progress', sessionIds: ['s1', 's2'], ...over }) as Task;
const updated = (before: Partial<Task>, after: Partial<Task>) => ({ kind: 'updated', addedAttachments: [], before: task(before), task: task(after), actor: null }) as never;

beforeEach(() => {
  endForTask.mockClear();
  listForSession.mockReset();
  listForSession.mockResolvedValue([]);
});

describe('fin des sessions d’une tâche fermée', () => {
  it('termine chaque session en charge quand la tâche passe à terminée ou annulée', async () => {
    await endSessionsOfClosedTask(updated({}, { status: 'done' }));
    expect(endForTask.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['s1', 's2']);
    expect(String((endForTask.mock.calls[0] as unknown[])[1])).toContain('« Corriger le bug » est terminée');
    endForTask.mockClear();
    await endSessionsOfClosedTask(updated({}, { status: 'cancelled' }));
    expect(endForTask).toHaveBeenCalledTimes(2);
  });

  it('rien si la tâche était déjà fermée, reste ouverte, ou n’a pas de session en charge', async () => {
    await endSessionsOfClosedTask(updated({ status: 'done' }, { status: 'done' }));
    await endSessionsOfClosedTask(updated({ status: 'todo' }, { status: 'in_progress' }));
    await endSessionsOfClosedTask(updated({}, { status: 'done', sessionIds: [] }));
    expect(endForTask).not.toHaveBeenCalled();
  });

  it('laisse tourner une session encore en charge d’une autre tâche ouverte', async () => {
    listForSession.mockImplementation(async (id: string) => (id === 's1' ? [task({ id: 't2', status: 'in_progress', sessionIds: ['s1'] })] : [task({ id: 't3', status: 'done', sessionIds: ['s2'] }), task({ id: 't4', status: 'todo', sessionIds: [] })]));
    await endSessionsOfClosedTask(updated({}, { status: 'done' }));
    expect(endForTask.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['s2']);
  });

  it('une erreur sur une session n’empêche pas les autres', async () => {
    endForTask.mockRejectedValueOnce(new Error('instance injoignable') as never);
    await endSessionsOfClosedTask(updated({}, { status: 'done' }));
    expect(endForTask).toHaveBeenCalledTimes(2);
  });
});
