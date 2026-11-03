/**
 * Expressions cron à cinq champs (minute, heure, jour du mois, mois, jour de la semaine), interprétées
 * dans un fuseau horaire IANA. Sans dépendance : on avance de champ en champ jusqu'à la prochaine
 * échéance, en heure locale du fuseau, puis on convertit en instant UTC.
 */

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Jour du mois non restreint (`*`). */
  anyDay: boolean;
  /** Jour de la semaine non restreint (`*`). */
  anyWeekday: boolean;
  /** Champ des heures commençant par `*` (`*` ou `*` suivi d’un pas) : planification « horaire » au changement d'heure. */
  hourWildcard: boolean;
  source: string;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export class CronError extends Error {}

function parseValue(raw: string, names: Record<string, number> | undefined, label: string): number {
  const lower = raw.toLowerCase();
  if (names && lower in names) return names[lower];
  if (!/^\d+$/.test(raw)) throw new CronError(`Valeur « ${raw} » invalide pour ${label}`);
  return Number(raw);
}

function parseField(field: string, min: number, max: number, label: string, names?: Record<string, number>): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of field.split(',')) {
    if (!part) throw new CronError(`Champ ${label} vide`);
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Pas « ${stepPart} » invalide pour ${label}`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
      if (stepPart === undefined) any = true;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseValue(a, names, label);
      hi = parseValue(b, names, label);
    } else {
      lo = parseValue(rangePart, names, label);
      hi = stepPart === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`Valeur hors limites pour ${label} (${min}-${max}) : « ${part} »`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

/** Analyse une expression cron ; lève CronError si elle est invalide. */
export function parseCron(expression: string): CronSpec {
  const source = expression.trim();
  const expr = ALIASES[source.toLowerCase()] ?? source;
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) throw new CronError('Une expression cron comporte cinq champs : minute heure jour mois jour-de-semaine');
  const minutes = parseField(fields[0], 0, 59, 'les minutes');
  const hours = parseField(fields[1], 0, 23, 'les heures');
  const days = parseField(fields[2], 1, 31, 'le jour du mois');
  const months = parseField(fields[3], 1, 12, 'le mois', MONTH_NAMES);
  const weekdays = parseField(fields[4], 0, 7, 'le jour de la semaine', DAY_NAMES);
  // 7 = dimanche, comme 0.
  if (weekdays.values.has(7)) {
    weekdays.values.delete(7);
    weekdays.values.add(0);
  }
  return { minutes: minutes.values, hours: hours.values, days: days.values, months: months.values, weekdays: weekdays.values, anyDay: days.any, anyWeekday: weekdays.any, hourWildcard: fields[1].startsWith('*'), source };
}

// ---- Fuseaux horaires ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Vérifie qu'un fuseau IANA est connu de Node (`Europe/Paris`, `UTC`...). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Heure locale d'un instant dans le fuseau, exprimée en millisecondes « comme si c'était de l'UTC ». */
function wallClock(instant: Date, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Décalage du fuseau (heure locale − UTC, en ms) à un instant donné. */
function offsetAt(instant: number, timeZone: string): number {
  return wallClock(new Date(instant), timeZone) - instant;
}

/**
 * Instants (ms UTC, croissants) dont l'heure locale dans le fuseau vaut `wall` : aucun pour une heure
 * absente (passage à l'heure d'été), deux pour une heure répétée (retour à l'heure d'hiver), un sinon.
 */
function instantsOf(wall: number, timeZone: string): number[] {
  const out = new Set<number>();
  for (const probe of [wall - DAY, wall, wall + DAY]) {
    const instant = wall - offsetAt(probe, timeZone);
    if (wallClock(new Date(instant), timeZone) === wall) out.add(instant);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Échéance réelle (ms UTC) d'une heure locale `wall` qui satisfait l'expression, si elle est postérieure à `after`.
 * Changements d'heure, comme le cron classique :
 * - heure répétée : une planification à heure fixe ne tourne qu'à la première occurrence ; une planification dont
 *   le champ des heures commence par `*` (toutes les heures, tous les quarts d'heure...) tourne aux deux ;
 * - heure absente : une planification à heure fixe est décalée à la première minute qui existe (2 h 30 → 3 h) ;
 *   une planification dont le champ des heures commence par `*` saute simplement les minutes absentes.
 */
function occurrence(spec: CronSpec, wall: number, timeZone: string, after: number): number | null {
  const instants = instantsOf(wall, timeZone);
  if (instants.length === 0) {
    if (spec.hourWildcard) return null;
    for (let w = wall + MINUTE; w <= wall + 3 * HOUR; w += MINUTE) {
      const next = instantsOf(w, timeZone);
      if (next.length) return next[0] > after ? next[0] : null;
    }
    return null;
  }
  const allowed = spec.hourWildcard ? instants : instants.slice(0, 1);
  return allowed.find((i) => i > after) ?? null;
}

// ---- Prochaine échéance ---------------------------------------------------------------------------

function dayMatches(spec: CronSpec, d: Date): boolean {
  const domOk = spec.days.has(d.getUTCDate());
  const dowOk = spec.weekdays.has(d.getUTCDay());
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return dowOk;
  if (spec.anyWeekday) return domOk;
  return domOk || dowOk; // sémantique cron classique : les deux champs restreints s'additionnent
}

/**
 * Première échéance strictement postérieure à `after` (null si aucune dans les cinq prochaines années).
 *
 * On parcourt les heures locales de champ en champ. Quand un retour à l'heure d'hiver suit `after` de peu, l'heure
 * répétée a des heures locales antérieures à celle de `after` mais des instants postérieurs : on recule alors le
 * point de départ de la durée du recul (`lookback`), et on garde la plus proche des échéances trouvées dans cette
 * fenêtre, l'ordre des heures locales n'étant plus celui des instants.
 */
export function nextRun(spec: CronSpec, after: Date, timeZone: string): Date | null {
  const afterMs = after.getTime();
  const start = wallClock(after, timeZone);
  const lookback = Math.max(0, offsetAt(afterMs, timeZone) - offsetAt(afterMs + 3 * HOUR, timeZone));
  let t = start - (start % MINUTE) + MINUTE - lookback;
  const limit = start + 5 * 366 * DAY;
  let best: number | null = null;
  let stopAt = Infinity;
  while (t <= limit && t <= stopAt) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    if (!spec.months.has(m + 1)) {
      t = Date.UTC(y, m + 1, 1);
      continue;
    }
    if (!dayMatches(spec, d)) {
      t = Date.UTC(y, m, d.getUTCDate() + 1);
      continue;
    }
    if (!spec.hours.has(d.getUTCHours())) {
      t = Date.UTC(y, m, d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!spec.minutes.has(d.getUTCMinutes())) {
      t += MINUTE;
      continue;
    }
    const instant = occurrence(spec, t, timeZone, afterMs);
    if (instant !== null) {
      if (best === null || instant < best) best = instant;
      if (stopAt === Infinity) stopAt = t + lookback;
    }
    t += MINUTE;
  }
  return best === null ? null : new Date(best);
}

/** Les `count` prochaines échéances après `after`. */
export function nextRuns(spec: CronSpec, after: Date, timeZone: string, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextRun(spec, cursor, timeZone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
