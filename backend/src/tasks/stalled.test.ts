import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../sessions/types.js';
import type { Task } from './types.js';

const notify = vi.hoisted(() => vi.fn(async () => undefined));
const tasksInCharge = vi.hoisted(() => vi.fn(async (_id: string): Promise<Task[]> => []));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: vi.fn(async () => ({ id: 'p1', name: 'Curso' })) } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { onEnded: vi.fn() } }));
vi.mock('./service.js', () => ({ taskService: { tasksInCharge } }));
const { notifyStalledTasks } = await import('./stalled.js');

const session = (over: Partial<Session> = {}) => ({ id: 's1', name: 'Coach', projectId: 'p1', kind: 'session', status: 'stopped', error: null, ...over }) as Session;
const task = (over: Partial<Task> = {}) => ({ id: 't1', projectId: 'p1', title: 'Suivi du coût LLM', status: 'in_progress', stalledSince: new Date(), ...over }) as Task;

beforeEach(() => {
  notify.mockClear();
  tasksInCharge.mockReset();
  tasksInCharge.mockResolvedValue([]);
});

describe('notification « agent arrêté »', () => {
  it('prévient le projet pour chaque tâche en cours laissée sans agent, avec le lien de la session', async () => {
    tasksInCharge.mockResolvedValue([task(), task({ id: 't2', status: 'done', stalledSince: null }), task({ id: 't3', stalledSince: null })]);
    expect(await notifyStalledTasks({ session: session(), quiet: false })).toBe(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.stalled', link: '/sessions/s1', projectId: 'p1', sessionId: 's1', payload: { taskId: 't1' } }));
    expect((notify.mock.calls[0] as unknown as [{ message: string }])[0].message).toContain('arrêtée sans terminer la tâche');
  });

  it('se tait pour une fin silencieuse, une session interrompue ou qui n’est pas une session de travail', async () => {
    tasksInCharge.mockResolvedValue([task()]);
    await notifyStalledTasks({ session: session(), quiet: true });
    await notifyStalledTasks({ session: session({ status: 'interrupted' }), quiet: false });
    await notifyStalledTasks({ session: session({ kind: 'chat' }), quiet: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it('joint l’erreur d’une session en erreur', async () => {
    tasksInCharge.mockResolvedValue([task()]);
    await notifyStalledTasks({ session: session({ status: 'failed', error: 'Code de sortie 137' }), quiet: false });
    expect((notify.mock.calls[0] as unknown as [{ message: string }])[0].message).toContain('en erreur sans terminer la tâche · Curso · Code de sortie 137');
  });
});
