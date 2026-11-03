import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../db/pool.js', () => ({ pool: { query } }));
vi.mock('../pullRequests/service.js', () => ({ trackedPullRequestService: { countPending: vi.fn(async () => ({ open: 2, pending: 5 })), list: vi.fn(async () => []) } }));
vi.mock('../requests/service.js', () => ({ requestService: { list: vi.fn(async () => []) } }));
const listTasks = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../tasks/repository.js', () => ({ STALLED_SINCE_SQL: '(stalled)', taskRepository: { list: listTasks } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: vi.fn(async (id: string) => ({ id })) } }));

import { inboxService, totalOf } from './service.js';

describe('file « À traiter »', () => {
  beforeEach(() => query.mockReset());

  it('additionne les demandes, sessions, tâches à l’agent arrêté et PR ouvertes (les PR en préparation ne comptent pas)', async () => {
    query.mockResolvedValueOnce({ rows: [{ requests: '3', idle: '1', failed: '2', interrupted: '1', stalled: '2' }] });
    const counts = await inboxService.counts(['p1']);
    expect(counts).toEqual({ requests: 3, idleSessions: 1, failedSessions: 2, interruptedSessions: 1, stalledTasks: 2, pullRequests: 2, total: 11 });
  });

  it('ne touche pas la base sans projet', async () => {
    expect((await inboxService.counts([])).total).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect((await inboxService.build([])).sessions).toEqual([]);
  });

  it('charge les sessions à reprendre', async () => {
    query.mockResolvedValue({ rows: [{ requests: '0', idle: '1', failed: '0', interrupted: '0', id: 's1' }] });
    const inbox = await inboxService.build(['p1']);
    expect(inbox.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(totalOf({ requests: 1, idleSessions: 1, failedSessions: 1, interruptedSessions: 1, stalledTasks: 1, pullRequests: 1 })).toBe(6);
  });

  it('liste les tâches « agent arrêté », la plus anciennement arrêtée d’abord', async () => {
    query.mockResolvedValue({ rows: [{ requests: '0', idle: '0', failed: '0', interrupted: '0', stalled: '2' }] });
    listTasks.mockResolvedValueOnce([
      { id: 't2', stalledSince: new Date('2026-11-02T10:00:00Z') },
      { id: 't1', stalledSince: new Date('2026-11-01T10:00:00Z') },
    ]);
    const inbox = await inboxService.build(['p1']);
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['p1'], status: ['in_progress'], stalled: true }));
    expect(inbox.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
