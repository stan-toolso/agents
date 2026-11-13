import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findTask: vi.fn(),
  claimDueWakes: vi.fn(),
  findSession: vi.fn(),
  forUser: vi.fn(),
  summon: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('./repository.js', () => ({ ACTIVE_SESSION_STATUSES: ['pending', 'queued', 'running'], taskRepository: { findById: m.findTask, claimDueWakes: m.claimDueWakes } }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { findById: m.findSession } }));
vi.mock('../agents/service.js', () => ({ agentService: { forUser: m.forUser, summon: m.summon } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: m.notify } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async () => ({ id: 'p', name: 'Curso' }) } }));

import { parseWakeAt } from './service.js';
import { wakeDueTasks, wakeInstruction, wakeTask } from './wake.js';

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  projectId: 'p',
  title: 'Proxy bloqué',
  status: 'in_progress',
  sessionIds: ['s1'],
  wakeAt: new Date('2026-11-13T07:00:00Z'),
  wakeNote: 'compter les compétitions du 13/11',
  ...over,
});

describe('réveil des tâches en attente', () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockReset();
    m.summon.mockResolvedValue({ id: 's2' });
  });

  it("reconvoque l'agent qui tenait la tâche, avec ce qu'il devait vérifier", async () => {
    m.findTask.mockResolvedValue(task());
    m.findSession.mockResolvedValue({ id: 's1', status: 'stopped', ownerId: 'agent-1' });
    m.forUser.mockResolvedValue({ id: 'agent-1', name: 'Ben', enabled: true, archivedAt: null });
    expect(await wakeTask('t1')).toBe('summoned');
    expect(m.summon).toHaveBeenCalledWith('agent-1', expect.objectContaining({ taskId: 't1', autoArchive: true }));
    expect(m.summon.mock.calls[0][1].text).toContain('compter les compétitions du 13/11');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.woken', link: '/sessions/s2' }));
  });

  it("ne relance pas la session d'une personne : la prévient", async () => {
    m.findTask.mockResolvedValue(task());
    m.findSession.mockResolvedValue({ id: 's1', status: 'stopped', ownerId: 'stan' });
    m.forUser.mockResolvedValue(null);
    expect(await wakeTask('t1')).toBe('notified');
    expect(m.summon).not.toHaveBeenCalled();
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.wake_due', userId: 'stan', link: '/tasks/t1' }));
  });

  it("prévient l'équipe quand l'agent est en pause ou que la convocation échoue", async () => {
    m.findTask.mockResolvedValue(task());
    m.findSession.mockResolvedValue({ id: 's1', status: 'stopped', ownerId: 'agent-1' });
    m.forUser.mockResolvedValue({ id: 'agent-1', name: 'Ben', enabled: true, archivedAt: null });
    m.summon.mockRejectedValue(new Error('dossier introuvable'));
    expect(await wakeTask('t1')).toBe('notified');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.wake_due', userId: null }));
  });

  it('ne fait rien si un agent y travaille déjà ou si la tâche a changé', async () => {
    m.findTask.mockResolvedValue(task());
    m.findSession.mockResolvedValue({ id: 's1', status: 'running', ownerId: 'agent-1' });
    expect(await wakeTask('t1')).toBe('skipped');
    m.findTask.mockResolvedValue(task({ status: 'done' }));
    expect(await wakeTask('t1')).toBe('skipped');
    expect(m.summon).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('traite les réveils échus par lots', async () => {
    m.claimDueWakes.mockResolvedValueOnce(['t1']).mockResolvedValue([]);
    m.findTask.mockResolvedValue(null);
    expect(await wakeDueTasks()).toBe(1);
  });

  it('la consigne se suffit à elle-même', () => {
    const text = wakeInstruction(task({ wakeNote: null }));
    expect(text).toContain('t1');
    expect(text).toContain('tasks.get');
    expect(text).toContain('wake_at');
  });

  it('valide la date de réveil', () => {
    const now = new Date('2026-11-13T10:00:00Z');
    expect(parseWakeAt(undefined, now)).toBeUndefined();
    expect(parseWakeAt('', now)).toBeNull();
    expect(parseWakeAt('2026-11-14T08:00:00+01:00', now)?.toISOString()).toBe('2026-11-14T07:00:00.000Z');
    expect(() => parseWakeAt('2026-11-12T08:00:00Z', now)).toThrow(/futur/);
    expect(() => parseWakeAt('2027-06-01T08:00:00Z', now)).toThrow(/lointaine/);
    expect(() => parseWakeAt('demain', now)).toThrow(/illisible/);
  });
});
