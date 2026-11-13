import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../db/pool.js', () => ({ pool: { query } }));
vi.mock('../pullRequests/service.js', () => ({ trackedPullRequestService: { countPending: vi.fn(async () => ({ open: 2, pending: 5 })), list: vi.fn(async () => []) } }));
vi.mock('../requests/service.js', () => ({ requestService: { list: vi.fn(async () => []) } }));
const listTasks = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../tasks/repository.js', () => ({ ATTENTION_JOIN: '', taskRepository: { list: listTasks } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: vi.fn(async (id: string) => ({ id })) } }));

import { inboxService, totalOf } from './service.js';

describe('file « À traiter »', () => {
  beforeEach(() => query.mockReset());

  it('additionne les demandes, sessions, tâches à l’agent arrêté et PR ouvertes (les PR en préparation ne comptent pas)', async () => {
    query.mockResolvedValueOnce({ rows: [{ requests: '3', failed: '2', interrupted: '1', stalled: '2', waiting: '4' }] });
    const counts = await inboxService.counts(['p1']);
    // Les tâches en attente sont comptées à part, hors du total.
    expect(counts).toEqual({ requests: 3, failedSessions: 2, interruptedSessions: 1, stalledTasks: 2, pullRequests: 2, total: 10, waitingTasks: 4 });
  });

  it('ne compte ni ne liste les sessions qui attendent simplement des instructions', async () => {
    query.mockResolvedValue({ rows: [{ requests: '0', failed: '0', interrupted: '0' }] });
    await inboxService.build(['p1']);
    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).not.toMatch(/status = 'running'/);
  });

  it('ne touche pas la base sans projet', async () => {
    expect((await inboxService.counts([])).total).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect((await inboxService.build([])).sessions).toEqual([]);
  });

  it('charge les sessions à reprendre', async () => {
    query.mockResolvedValue({ rows: [{ requests: '0', failed: '1', interrupted: '0', id: 's1' }] });
    const inbox = await inboxService.build(['p1']);
    expect(inbox.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(totalOf({ requests: 1, failedSessions: 1, interruptedSessions: 1, stalledTasks: 1, pullRequests: 1 })).toBe(5);
  });

  it('liste les tâches « agent arrêté », la plus anciennement arrêtée d’abord', async () => {
    query.mockResolvedValue({ rows: [{ requests: '0', failed: '0', interrupted: '0', stalled: '2' }] });
    listTasks.mockResolvedValueOnce([
      { id: 't2', stalledSince: new Date('2026-11-02T10:00:00Z') },
      { id: 't1', stalledSince: new Date('2026-11-01T10:00:00Z') },
    ]);
    const inbox = await inboxService.build(['p1']);
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['p1'], status: ['in_progress'], stalled: true }));
    expect(inbox.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('liste à part les tâches en attente, le réveil le plus proche d’abord, puis celles sans date', async () => {
    query.mockResolvedValue({ rows: [{ requests: '0', failed: '0', interrupted: '0', stalled: '0', waiting: '3' }] });
    listTasks.mockImplementation(async (f: { waiting?: boolean }) =>
      f.waiting
        ? [
            { id: 'sans-date', wakeAt: null, waitingSince: new Date('2026-11-01T10:00:00Z') },
            { id: 'tard', wakeAt: new Date('2026-11-20T08:00:00Z'), waitingSince: new Date('2026-11-01T10:00:00Z') },
            { id: 'tot', wakeAt: new Date('2026-11-14T08:00:00Z'), waitingSince: new Date('2026-11-02T10:00:00Z') },
          ]
        : [],
    );
    const inbox = await inboxService.build(['p1']);
    expect(inbox.waitingTasks.map((t) => t.id)).toEqual(['tot', 'tard', 'sans-date']);
    expect(inbox.tasks).toEqual([]);
    expect(inbox.counts.total).toBe(2); // les 2 PR ouvertes du simulacre, pas les 3 tâches en attente
    listTasks.mockReset();
    listTasks.mockResolvedValue([]);
  });
});
