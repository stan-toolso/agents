import { describe, expect, it } from 'vitest';
import { CronError, isValidTimeZone, nextRun, nextRuns, parseCron } from './cron.js';

const PARIS = 'Europe/Paris';
const iso = (d: Date | null) => d?.toISOString() ?? null;
const next = (expr: string, after: string, tz = 'UTC') => iso(nextRun(parseCron(expr), new Date(after), tz));
const runs = (expr: string, after: string, count: number, tz = 'UTC') => nextRuns(parseCron(expr), new Date(after), tz, count).map(iso);
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('parseCron', () => {
  it('analyse valeurs, listes, intervalles et pas', () => {
    const spec = parseCron('0,30 9-17/4 1,15 */3 1-5');
    expect(sorted(spec.minutes)).toEqual([0, 30]);
    expect(sorted(spec.hours)).toEqual([9, 13, 17]);
    expect(sorted(spec.days)).toEqual([1, 15]);
    expect(sorted(spec.months)).toEqual([1, 4, 7, 10]);
    expect(sorted(spec.weekdays)).toEqual([1, 2, 3, 4, 5]);
    expect(spec.anyDay).toBe(false);
    expect(spec.anyWeekday).toBe(false);
    expect(spec.hourWildcard).toBe(false);
  });

  it('distingue * (non restreint) de */n et repère le champ des heures en *', () => {
    const spec = parseCron('*/15 */2 * * *');
    expect(sorted(spec.minutes)).toEqual([0, 15, 30, 45]);
    expect(spec.hours.size).toBe(12);
    expect(spec.anyDay).toBe(true);
    expect(spec.anyWeekday).toBe(true);
    expect(spec.hourWildcard).toBe(true);
  });

  it('accepte une valeur suivie d’un pas (5/20 = 5, 25, 45)', () => {
    expect(sorted(parseCron('5/20 * * * *').minutes)).toEqual([5, 25, 45]);
  });

  it('accepte les noms de mois et de jours, et 7 pour dimanche', () => {
    const spec = parseCron('0 8 * jan-mar mon,WED,7');
    expect(sorted(spec.months)).toEqual([1, 2, 3]);
    expect(sorted(spec.weekdays)).toEqual([0, 1, 3]);
  });

  it('accepte les alias', () => {
    const daily = parseCron('@daily');
    expect(sorted(daily.minutes)).toEqual([0]);
    expect(sorted(daily.hours)).toEqual([0]);
    expect(daily.source).toBe('@daily');
    expect(sorted(parseCron('@weekly').weekdays)).toEqual([0]);
  });

  it.each([
    ['* * * *', 'cinq champs'],
    ['60 * * * *', 'hors limites'],
    ['* 24 * * *', 'hors limites'],
    ['* * 0 * *', 'hors limites'],
    ['* * * 13 *', 'hors limites'],
    ['* * * * 8', 'hors limites'],
    ['5-1 * * * *', 'hors limites'],
    ['*/0 * * * *', 'Pas'],
    ['a * * * *', 'invalide'],
    ['1,,2 * * * *', 'vide'],
  ])('refuse « %s »', (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe('isValidTimeZone', () => {
  it('reconnaît les fuseaux IANA et refuse le reste', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/Pariss')).toBe(false);
    expect(isValidTimeZone('pas un fuseau')).toBe(false);
  });
});

describe('nextRun hors changement d’heure', () => {
  it('est strictement postérieure à l’instant de départ', () => {
    expect(next('0 * * * *', '2026-06-01T10:00:00Z')).toBe('2026-06-01T11:00:00.000Z');
    expect(next('0 * * * *', '2026-06-01T10:00:30Z')).toBe('2026-06-01T11:00:00.000Z');
    expect(next('* * * * *', '2026-06-01T10:00:30Z')).toBe('2026-06-01T10:01:00.000Z');
  });

  it('applique le fuseau', () => {
    // 7 h à Paris en été = 5 h UTC ; à New York = 11 h UTC.
    expect(next('0 7 * * *', '2026-06-01T12:00:00Z', PARIS)).toBe('2026-06-02T05:00:00.000Z');
    expect(next('0 7 * * *', '2026-06-01T12:00:00Z', 'America/New_York')).toBe('2026-06-02T11:00:00.000Z');
  });

  it('respecte les jours de la semaine (lundi à vendredi)', () => {
    // Vendredi 5 juin 2026 après 7 h : prochaine échéance lundi 8.
    expect(next('0 7 * * 1-5', '2026-06-05T06:00:00Z', PARIS)).toBe('2026-06-08T05:00:00.000Z');
    expect(next('0 0 * * 0', '2026-06-01T00:00:00Z')).toBe('2026-06-07T00:00:00.000Z');
  });

  it('additionne jour du mois et jour de la semaine quand les deux sont restreints', () => {
    // Le 13 ou un vendredi : après le lundi 1er juin 2026, le vendredi 5 vient avant le 13.
    expect(runs('0 0 13 * 5', '2026-06-01T00:00:00Z', 3)).toEqual(['2026-06-05T00:00:00.000Z', '2026-06-12T00:00:00.000Z', '2026-06-13T00:00:00.000Z']);
  });

  it('passe les mois trop courts et trouve le 29 février', () => {
    expect(next('0 0 31 * *', '2026-04-01T00:00:00Z')).toBe('2026-05-31T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('renvoie null sans échéance dans les cinq ans', () => {
    expect(next('0 0 30 2 *', '2026-01-01T00:00:00Z')).toBeNull();
  });

  it('enchaîne les échéances avec nextRuns', () => {
    expect(runs('*/20 9 * * *', '2026-06-01T08:59:00Z', 4)).toEqual([
      '2026-06-01T09:00:00.000Z',
      '2026-06-01T09:20:00.000Z',
      '2026-06-01T09:40:00.000Z',
      '2026-06-02T09:00:00.000Z',
    ]);
  });
});

// Nuit du 24 au 25 octobre 2026 à Paris : à 3 h heure d'été (01:00 UTC), on revient à 2 h heure d'hiver.
// L'heure locale de 2 h à 3 h existe deux fois : 00:00-01:00 UTC puis 01:00-02:00 UTC.
describe('retour à l’heure d’hiver (25/10/2026, Europe/Paris)', () => {
  it('garde les planifications quotidiennes à leur heure', () => {
    expect(next('0 0 * * *', '2026-10-24T12:00:00Z', PARIS)).toBe('2026-10-24T22:00:00.000Z'); // minuit, heure d'été
    expect(next('0 0 * * *', '2026-10-25T12:00:00Z', PARIS)).toBe('2026-10-25T23:00:00.000Z'); // minuit, heure d'hiver
    expect(next('0 7 * * 1-5', '2026-10-24T12:00:00Z', PARIS)).toBe('2026-10-26T06:00:00.000Z'); // lundi 7 h heure d'hiver
  });

  it('ne lance une planification à heure fixe qu’une fois, à la première occurrence', () => {
    expect(runs('30 2 * * *', '2026-10-24T12:00:00Z', 2, PARIS)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    // Depuis l'heure répétée elle-même, pas de seconde exécution.
    expect(next('30 2 * * *', '2026-10-25T01:00:00Z', PARIS)).toBe('2026-10-26T01:30:00.000Z');
  });

  it('parcourt les deux occurrences de l’heure répétée pour une planification fréquente', () => {
    expect(runs('*/15 * * * *', '2026-10-24T23:50:00Z', 10, PARIS)).toEqual([
      '2026-10-25T00:00:00.000Z', // 02:00 heure d'été
      '2026-10-25T00:15:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T00:45:00.000Z',
      '2026-10-25T01:00:00.000Z', // 02:00 heure d'hiver
      '2026-10-25T01:15:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T01:45:00.000Z',
      '2026-10-25T02:00:00.000Z', // 03:00 heure d'hiver
      '2026-10-25T02:15:00.000Z',
    ]);
  });

  it('ne saute pas l’heure répétée depuis la fin de la première occurrence (02:50 heure d’été)', () => {
    expect(next('*/15 * * * *', '2026-10-25T00:50:00Z', PARIS)).toBe('2026-10-25T01:00:00.000Z');
    expect(next('* * * * *', '2026-10-25T00:50:00Z', PARIS)).toBe('2026-10-25T00:51:00.000Z');
    expect(next('0 * * * *', '2026-10-25T00:50:00Z', PARIS)).toBe('2026-10-25T01:00:00.000Z');
  });

  it('continue normalement depuis la seconde occurrence (02:05 heure d’hiver)', () => {
    expect(next('*/15 * * * *', '2026-10-25T01:05:00Z', PARIS)).toBe('2026-10-25T01:15:00.000Z');
  });
});

// Nuit du 27 au 28 mars 2027 à Paris : à 2 h heure d'hiver (01:00 UTC), on passe à 3 h heure d'été.
// L'heure locale de 2 h à 3 h n'existe pas.
describe('passage à l’heure d’été (28/03/2027, Europe/Paris)', () => {
  it('décale une planification à heure fixe à la première minute qui existe (3 h)', () => {
    expect(runs('30 2 * * *', '2027-03-27T20:00:00Z', 2, PARIS)).toEqual(['2027-03-28T01:00:00.000Z', '2027-03-29T00:30:00.000Z']);
  });

  it('ne lance qu’une fois plusieurs heures absentes décalées au même instant', () => {
    expect(runs('0,30 2 * * *', '2027-03-27T20:00:00Z', 2, PARIS)).toEqual(['2027-03-28T01:00:00.000Z', '2027-03-29T00:00:00.000Z']);
  });

  it('saute les minutes absentes d’une planification fréquente', () => {
    expect(runs('*/30 * * * *', '2027-03-28T00:15:00Z', 3, PARIS)).toEqual([
      '2027-03-28T00:30:00.000Z', // 01:30 heure d'hiver
      '2027-03-28T01:00:00.000Z', // 03:00 heure d'été
      '2027-03-28T01:30:00.000Z',
    ]);
  });

  it('garde les planifications quotidiennes à leur heure', () => {
    expect(next('0 0 * * *', '2027-03-27T12:00:00Z', PARIS)).toBe('2027-03-27T23:00:00.000Z');
    expect(next('0 7 * * 1-5', '2027-03-27T12:00:00Z', PARIS)).toBe('2027-03-29T05:00:00.000Z');
  });
});
