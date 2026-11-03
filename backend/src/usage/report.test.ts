import { describe, expect, it } from 'vitest';
import { dayKey, fillDays, periodStart, weekOf, weeksOf } from './report.js';

// Calculs purs du relevé de consommation : période, jours complétés, semaines (lundi).
describe('relevé de consommation', () => {
  const now = new Date(2026, 10, 3, 15, 30); // mardi 3 novembre 2026

  it('fait commencer la période à minuit, aujourd’hui compris', () => {
    expect(periodStart(1, now)).toEqual(new Date(2026, 10, 3));
    expect(periodStart(7, now)).toEqual(new Date(2026, 9, 28));
  });

  it('complète les jours sans consommation', () => {
    const days = fillDays([{ day: '2026-11-02', usd: 3, turns: 2 }], periodStart(4, now), now);
    expect(days.map((d) => d.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    expect(days.map((d) => d.usd)).toEqual([0, 0, 3, 0]);
  });

  it('range un jour dans la semaine de son lundi', () => {
    expect(weekOf('2026-11-02')).toBe('2026-11-02'); // lundi
    expect(weekOf('2026-11-08')).toBe('2026-11-02'); // dimanche
    expect(weekOf('2026-11-09')).toBe('2026-11-09');
    expect(weekOf('2026-01-01')).toBe('2025-12-29'); // à cheval sur deux années
  });

  it('additionne les jours par semaine sans rien perdre', () => {
    const days = fillDays(
      [
        { day: '2026-10-30', usd: 1.5, turns: 1 },
        { day: '2026-11-01', usd: 2, turns: 3 },
        { day: '2026-11-02', usd: 4, turns: 5 },
      ],
      periodStart(10, now),
      now,
    );
    const weeks = weeksOf(days);
    expect(weeks).toEqual([
      { day: '2026-10-19', usd: 0, turns: 0 },
      { day: '2026-10-26', usd: 3.5, turns: 4 },
      { day: '2026-11-02', usd: 4, turns: 5 },
    ]);
    const sum = (xs: { usd: number }[]) => xs.reduce((a, x) => a + x.usd, 0);
    expect(sum(weeks)).toBe(sum(days));
  });

  it('formate un jour dans le fuseau du processus', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
