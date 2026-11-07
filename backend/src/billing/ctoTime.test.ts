import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } }));

const { CTO_TRACKED, ctoTimeService, slotStart, withCtoTime } = await import('./ctoTime.js');

describe('suivi du temps CTO', () => {
  it('ne suit que des mutations du schéma', () => {
    const schema = readFileSync(new URL('../graphql/schema.graphql', import.meta.url), 'utf8');
    for (const name of Object.keys(CTO_TRACKED)) expect(schema, name).toMatch(new RegExp(`^\\s+${name}\\(`, 'm'));
  });

  it('cale une intervention sur le début de sa tranche de 10 minutes', () => {
    expect(slotStart(new Date('2026-11-07T09:19:59.999Z')).toISOString()).toBe('2026-11-07T09:10:00.000Z');
    expect(slotStart(new Date('2026-11-07T09:20:00.000Z')).toISOString()).toBe('2026-11-07T09:20:00.000Z');
  });

  it("n'inscrit que les interventions réussies d'un CTO", async () => {
    const record = vi.spyOn(ctoTimeService, 'record').mockResolvedValue(true);
    type R = (parent: unknown, args: Record<string, unknown>, ctx: unknown) => Promise<string>;
    const ok: R = async () => 'ok';
    const fail: R = async () => {
      throw new Error('refusé');
    };
    const wrapped = withCtoTime({ sendSessionMessage: ok, updateProject: ok, postMessage: fail });
    await wrapped.sendSessionMessage(null, { id: 's1' }, { user: { id: 'u1', isCto: false } });
    await wrapped.updateProject(null, { id: 'p1' }, { user: { id: 'u1', isCto: true } });
    await expect(wrapped.postMessage(null, { conversationId: 'c1' }, { user: { id: 'u1', isCto: true } })).rejects.toThrow('refusé');
    expect(record).not.toHaveBeenCalled();
    await wrapped.sendSessionMessage(null, { id: 's1' }, { user: { id: 'u1', isCto: true } });
    expect(record).toHaveBeenCalledWith({ id: 'u1', isCto: true }, { action: 'sendSessionMessage', targetType: 'session', targetId: 's1' });
  });
});
