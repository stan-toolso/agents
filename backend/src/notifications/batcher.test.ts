import { describe, expect, it } from 'vitest';
import { createBatcher } from './batcher.js';

/** Horloge et minuteries simulées : on avance le temps à la main. */
function harness(windowMs = 60_000) {
  let t = 0;
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  const sent: { key: string; items: string[] }[] = [];
  const batcher = createBatcher<string>({
    windowMs,
    send: async (key, items) => void sent.push({ key, items }),
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => void ((h as { done: boolean }).done = true),
  });
  const advance = (ms: number) => {
    t += ms;
    for (const timer of timers) if (!timer.done && timer.at <= t) {
      timer.done = true;
      timer.fn();
    }
  };
  return { batcher, sent, advance };
}

describe('anti-rafale des canaux', () => {
  it('envoie la première notification aussitôt, regroupe les suivantes à la fin de la minute', () => {
    const { batcher, sent, advance } = harness();
    batcher.push('c1', 'a');
    expect(sent).toEqual([{ key: 'c1', items: ['a'] }]);
    advance(10_000);
    batcher.push('c1', 'b');
    advance(5_000);
    batcher.push('c1', 'c');
    expect(sent).toHaveLength(1);
    expect(batcher.pendingCount('c1')).toBe(2);
    advance(45_000);
    expect(sent[1]).toEqual({ key: 'c1', items: ['b', 'c'] });
    // Une minute après le lot, la suivante repart aussitôt.
    advance(60_000);
    batcher.push('c1', 'd');
    expect(sent[2]).toEqual({ key: 'c1', items: ['d'] });
  });

  it('une demande urgente part aussitôt, même pendant la fenêtre', () => {
    const { batcher, sent } = harness();
    batcher.push('c1', 'a');
    batcher.push('c1', 'b');
    batcher.push('c1', 'demande', true);
    expect(sent.map((s) => s.items)).toEqual([['a'], ['demande']]);
    expect(batcher.pendingCount('c1')).toBe(1);
  });

  it('les canaux sont indépendants', () => {
    const { batcher, sent } = harness();
    batcher.push('c1', 'a');
    batcher.push('c2', 'b');
    expect(sent).toHaveLength(2);
  });

  it('flushAll envoie ce qui attend', async () => {
    const { batcher, sent } = harness();
    batcher.push('c1', 'a');
    batcher.push('c1', 'b');
    await batcher.flushAll();
    expect(sent[1].items).toEqual(['b']);
    expect(batcher.pendingCount('c1')).toBe(0);
  });
});
