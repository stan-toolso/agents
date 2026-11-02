import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../db/pool.js', () => ({ pool: { query } }));
vi.mock('../pullRequests/service.js', () => ({ trackedPullRequestService: { countPending: vi.fn(async () => ({ open: 2, pending: 5 })), list: vi.fn(async () => []) } }));
vi.mock('../requests/service.js', () => ({ requestService: { list: vi.fn(async () => []) } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: vi.fn(async (id: string) => ({ id })) } }));

import { inboxService, totalOf } from './service.js';

describe('file « À traiter »', () => {
  beforeEach(() => query.mockReset());

  it('additionne les demandes, sessions et PR ouvertes (les PR en préparation ne comptent pas)', async () => {
    query.mockResolvedValueOnce({ rows: [{ requests: '3', idle: '1', failed: '2', interrupted: '1' }] });
    const counts = await inboxService.counts(['p1']);
    expect(counts).toEqual({ requests: 3, idleSessions: 1, failedSessions: 2, interruptedSessions: 1, pullRequests: 2, total: 9 });
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
    expect(totalOf({ requests: 1, idleSessions: 1, failedSessions: 1, interruptedSessions: 1, pullRequests: 1 })).toBe(5);
  });
});
