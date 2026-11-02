import { describe, expect, it } from 'vitest';
import { attributeCosts } from './cost.js';

const d = (s: string) => new Date(`2026-11-0${s}T10:00:00Z`);

describe('attributeCosts', () => {
  it('attribue le tour à la seule tâche reliée', () => {
    const r = attributeCosts([{ sessionId: 's1', recordedAt: d('2'), costUsd: 2 }], [{ taskId: 't1', sessionId: 's1', linkedAt: d('1') }]);
    expect(r.get('t1')?.totalUsd).toBe(2);
    expect(r.get('t1')?.bySession.get('s1')).toBe(2);
  });

  it('répartit à parts égales entre les tâches d\'une même session', () => {
    const r = attributeCosts(
      [{ sessionId: 's1', recordedAt: d('3'), costUsd: 3 }],
      [
        { taskId: 't1', sessionId: 's1', linkedAt: d('1') },
        { taskId: 't2', sessionId: 's1', linkedAt: d('2') },
      ],
    );
    expect(r.get('t1')?.totalUsd).toBe(1.5);
    expect(r.get('t2')?.totalUsd).toBe(1.5);
  });

  it('ignore les tours antérieurs à la liaison', () => {
    const r = attributeCosts(
      [
        { sessionId: 's1', recordedAt: d('1'), costUsd: 4 },
        { sessionId: 's1', recordedAt: d('3'), costUsd: 1 },
      ],
      [
        { taskId: 't1', sessionId: 's1', linkedAt: d('2') },
      ],
    );
    expect(r.get('t1')?.totalUsd).toBe(1);
  });

  it('le total des tâches ne dépasse jamais celui des tours', () => {
    const entries = [1, 2, 3].map((n) => ({ sessionId: 's1', recordedAt: d(String(n)), costUsd: n * 0.7 }));
    const links = [
      { taskId: 'a', sessionId: 's1', linkedAt: d('1') },
      { taskId: 'b', sessionId: 's1', linkedAt: d('2') },
      { taskId: 'c', sessionId: 's1', linkedAt: d('3') },
    ];
    const total = [...attributeCosts(entries, links).values()].reduce((s, c) => s + c.totalUsd, 0);
    expect(total).toBeCloseTo(entries.reduce((s, e) => s + e.costUsd, 0));
  });
});
