import { describe, expect, it } from 'vitest';
import { alertInstruction, describeAlert, describeCondition, evaluateAlert, nextAlertState, parseAlerts, selectValues, type AlertConfig, type AlertInput, type AlertState } from './alerts.js';

const SOURCES = [
  { name: 'stats', kind: 'sql' as const },
  { name: 'commandes', kind: 'script' as const },
  { name: 'vivante', kind: 'graphql' as const },
];
const parse = (a: Partial<AlertInput>) => parseAlerts([{ name: 'a', source: 'stats', op: '>', value: 5, ...a } as AlertInput], SOURCES)[0]!;
const cfg = (a: Partial<AlertInput>): AlertConfig => parse(a).config;
const ok = (data: unknown) => ({ status: 'ok' as const, data });
const sql = (rows: Record<string, unknown>[]) => ({ columns: Object.keys(rows[0] ?? {}), rows });

describe('parseAlerts', () => {
  it('normalise une règle avec ses défauts', () => {
    expect(parse({ path: ' rows.0.taux ' })).toEqual({
      name: 'a',
      source: 'stats',
      config: { path: 'rows.0.taux', op: '>', value: 5, match: 'any', for: 1, notify: 'owner', notifyResolved: true, prompt: null, agent: null, message: null },
    });
  });

  it('refuse les règles mal formées, avec un message lisible', () => {
    expect(() => parse({ name: 'Taux' })).toThrow(/nom/);
    expect(() => parse({ source: 'inconnue' })).toThrow(/source « inconnue » inconnue \(stats, commandes, vivante\)/);
    expect(() => parse({ source: 'vivante' })).toThrow(/graphql/);
    expect(() => parse({ op: '~' })).toThrow(/op doit/);
    expect(() => parse({ value: undefined })).toThrow(/value est obligatoire/);
    expect(() => parse({ value: 'beaucoup' })).toThrow(/compare des nombres/);
    expect(() => parse({ value: { a: 1 } })).toThrow(/nombre, un texte/);
    expect(() => parse({ path: 'rows..x' })).toThrow(/chemin invalide/);
    expect(() => parse({ path: 'rows[0]' })).toThrow(/chemin invalide/);
    expect(() => parse({ for: 0 })).toThrow(/for/);
    expect(() => parse({ for: 11 })).toThrow(/for/);
    expect(() => parse({ notify: 'none' })).toThrow(/aucune action/);
    expect(() => parseAlerts([{ name: 'a', source: 'stats', op: 'failed' }, { name: 'a', source: 'stats', op: 'failed' }], SOURCES)).toThrow(/en double/);
  });

  it('accepte les opérateurs sans valeur et les actions de session', () => {
    expect(cfg({ op: 'changed', value: undefined }).value).toBeNull();
    expect(cfg({ op: 'failed', notify: 'none', agent: ' Ben ' })).toMatchObject({ notify: 'none', agent: 'Ben', prompt: null });
    expect(cfg({ op: '==', value: '5' }).value).toBe('5');
    expect(cfg({ op: '>', value: '5' }).value).toBe('5');
  });
});

describe('selectValues', () => {
  const data = sql([
    { id: 1, status: 'ok', n: 3 },
    { id: 2, status: 'ko', n: 7 },
  ]);
  it('suit les clés, les indices, * et length', () => {
    expect(selectValues(data, 'rows.1.status').map((s) => s.value)).toEqual(['ko']);
    expect(selectValues(data, 'rows.*.n').map((s) => s.value)).toEqual([3, 7]);
    expect(selectValues(data, 'rows.length').map((s) => s.value)).toEqual([2]);
    expect(selectValues(data, '').map((s) => s.value)).toEqual([data]);
    expect(selectValues({ a: { x: 1, y: 2 } }, 'a.*').map((s) => s.value)).toEqual([1, 2]);
  });
  it('ne sélectionne rien sur un chemin absent', () => {
    expect(selectValues(data, 'rows.5.status')).toEqual([]);
    expect(selectValues(data, 'total')).toEqual([]);
    expect(selectValues(null, 'a')).toEqual([]);
    expect(selectValues({ a: 'texte' }, 'a.length')).toEqual([]);
  });
  it('donne la ligne qui contient la valeur', () => {
    expect(selectValues(data, 'rows.*.status')[1]!.parent).toEqual({ id: 2, status: 'ko', n: 7 });
  });
});

describe('evaluateAlert', () => {
  it('seuil numérique, nombres en texte compris', () => {
    const c = cfg({ path: 'rows.0.taux', op: '>', value: 5 });
    expect(evaluateAlert(c, ok(sql([{ taux: 7.5 }])), undefined)).toMatchObject({ matched: true, value: 7.5 });
    expect(evaluateAlert(c, ok(sql([{ taux: '4' }])), undefined).matched).toBe(false);
    expect(evaluateAlert(c, ok(sql([{ taux: '12' }])), undefined).matched).toBe(true);
    expect(evaluateAlert(c, ok(sql([{ taux: null }])), undefined).matched).toBe(false);
    expect(evaluateAlert(c, ok(sql([{ taux: 'n/a' }])), undefined).matched).toBe(false);
  });

  it('une ligne en défaut (any) ou toutes (all), avec les lignes en cause', () => {
    const data = sql([
      { id: 1, status: 'ok' },
      { id: 2, status: 'ko' },
    ]);
    const any = evaluateAlert(cfg({ path: 'rows.*.status', op: '==', value: 'ko' }), ok(data), undefined);
    expect(any).toMatchObject({ matched: true, value: 'ko', offending: [{ id: 2, status: 'ko' }] });
    expect(evaluateAlert(cfg({ path: 'rows.*.status', op: '==', value: 'ko', match: 'all' }), ok(data), undefined).matched).toBe(false);
    // Aucune ligne : ni any ni all (pas de vérité par vacuité).
    expect(evaluateAlert(cfg({ path: 'rows.*.status', op: '==', value: 'ko', match: 'all' }), ok(sql([])), undefined).matched).toBe(false);
  });

  it('égalité, différence et contenu', () => {
    expect(evaluateAlert(cfg({ path: 'etat', op: '==', value: 'ko' }), ok({ etat: 'ko' }), undefined).matched).toBe(true);
    expect(evaluateAlert(cfg({ path: 'n', op: '==', value: 3 }), ok({ n: '3' }), undefined).matched).toBe(true);
    expect(evaluateAlert(cfg({ path: 'etat', op: '!=', value: 'ok' }), ok({ etat: 'ok' }), undefined).matched).toBe(false);
    expect(evaluateAlert(cfg({ path: 'actif', op: '==', value: false }), ok({ actif: false }), undefined).matched).toBe(true);
    expect(evaluateAlert(cfg({ path: 'msg', op: 'contains', value: 'timeout' }), ok({ msg: 'erreur: timeout' }), undefined).matched).toBe(true);
    expect(evaluateAlert(cfg({ path: 'tags', op: 'contains', value: 'urgent' }), ok({ tags: ['a', 'urgent'] }), undefined).matched).toBe(true);
    expect(evaluateAlert(cfg({ path: 'tags', op: 'not_contains', value: 'urgent' }), ok({ tags: ['a'] }), undefined).matched).toBe(true);
  });

  it('vide / non vide', () => {
    const empty = cfg({ path: 'rows', op: 'empty', value: undefined });
    expect(evaluateAlert(empty, ok(sql([])), undefined).matched).toBe(true);
    expect(evaluateAlert(empty, ok(sql([{ a: 1 }])), undefined).matched).toBe(false);
    expect(evaluateAlert(empty, ok({}), undefined).matched).toBe(true);
    expect(evaluateAlert(cfg({ path: 'rows', op: 'not_empty', value: undefined }), ok(sql([{ a: 1 }])), undefined).matched).toBe(true);
  });

  it('changed : pas au premier passage, puis à chaque différence', () => {
    const c = cfg({ path: 'total', op: 'changed', value: undefined });
    expect(evaluateAlert(c, ok({ total: 10 }), undefined)).toMatchObject({ matched: false, value: 10 });
    expect(evaluateAlert(c, ok({ total: 10 }), 10).matched).toBe(false);
    expect(evaluateAlert(c, ok({ total: 11 }), 10).matched).toBe(true);
    expect(evaluateAlert(c, ok({}), 10).matched).toBe(true);
  });

  it('source en échec : failed se déclenche, les autres règles ne sont pas évaluées', () => {
    const failed = cfg({ op: 'failed', value: undefined });
    expect(evaluateAlert(failed, { status: 'error', data: null, error: 'relation inexistante' }, undefined)).toMatchObject({ matched: true, value: 'relation inexistante' });
    expect(evaluateAlert(failed, ok([]), undefined).matched).toBe(false);
    expect(evaluateAlert(failed, { status: 'skipped', data: null }, undefined).matched).toBeNull();
    const seuil = evaluateAlert(cfg({ path: 'n', op: '>', value: 1 }), { status: 'error', data: { n: 5 } }, 3);
    expect(seuil).toMatchObject({ matched: null, value: 3 });
    expect(seuil.note).toMatch(/en erreur/);
  });

  it('signale un chemin introuvable', () => {
    expect(evaluateAlert(cfg({ path: 'rows.0.taux', op: '>', value: 5 }), ok(sql([])), undefined)).toMatchObject({ matched: false, note: expect.stringMatching(/introuvable/) });
  });
});

describe('nextAlertState (franchissement et anti-rebond)', () => {
  type S = { state: AlertState; streak: number };
  const run = (results: (boolean | null)[], c: Pick<AlertConfig, 'for' | 'op'> = { for: 1, op: '>' }, start: S = { state: 'unknown', streak: 0 }) => {
    let s = start;
    return results.map((m) => {
      const n = nextAlertState(s, m, c);
      s = { state: n.state, streak: n.streak };
      return n.event ?? n.state;
    });
  };

  it('ne réagit qu’au franchissement, pas à chaque évaluation', () => {
    expect(run([false, true, true, true, false, false, true])).toEqual(['ok', 'triggered', 'firing', 'firing', 'resolved', 'ok', 'triggered']);
  });

  it('se déclenche dès la première évaluation positive, sans événement si tout va bien', () => {
    expect(run([true])).toEqual(['triggered']);
    expect(run([false])).toEqual(['ok']);
  });

  it('anti-rebond : N évaluations de suite dans un sens comme dans l’autre', () => {
    const c = { for: 3, op: '>' as const };
    expect(run([true, true, false, true, true, true, true], c)).toEqual(['unknown', 'unknown', 'ok', 'ok', 'ok', 'triggered', 'firing']);
    expect(run([false, false, true, false, false, false], c, { state: 'firing', streak: 0 })).toEqual(['firing', 'firing', 'firing', 'firing', 'firing', 'resolved']);
  });

  it('une évaluation impossible (source en échec) ne change rien', () => {
    expect(nextAlertState({ state: 'firing', streak: 1 }, null, { for: 2, op: '>' })).toEqual({ state: 'firing', streak: 1, event: null });
    expect(run([true, null, true], { for: 2, op: '>' })).toEqual(['unknown', 'unknown', 'triggered']);
  });

  it('changed : chaque changement déclenche, le calme revient sans notification', () => {
    expect(run([false, true, true, false], { for: 1, op: 'changed' })).toEqual(['ok', 'triggered', 'triggered', 'ok']);
  });
});

describe('textes', () => {
  const alert = parse({ name: 'ko', source: 'commandes', path: 'rows.*.status', op: '==', value: 'ko', for: 2, message: 'Commande en échec', agent: 'Ben' });
  it('décrit la condition et l’état', () => {
    expect(describeCondition(alert)).toBe('commandes.rows.*.status = "ko" (au moins une valeur), 2 fois de suite');
    expect(describeCondition(parse({ op: 'failed', value: undefined }))).toBe('source stats en erreur');
    expect(describeAlert({ ...alert, state: 'firing', lastValue: 'ko', triggeredAt: new Date('2026-11-13T10:00:00Z'), error: null })).toBe(
      'ko · si commandes.rows.*.status = "ko" (au moins une valeur), 2 fois de suite · notifie le propriétaire, convoque Ben · DÉCLENCHÉE depuis 2026-11-13T10:00:00.000Z · valeur ko',
    );
  });
  it('donne le contexte de l’alerte à la session', () => {
    const t = alertInstruction({ id: 'p1', title: 'Commandes' }, alert, { value: 'ko', offending: [{ id: 2, status: 'ko' }] }, 'https://x/shared/p1');
    expect(t).toContain('Alerte « ko » déclenchée sur l\'artefact de données « Commandes » (p1, https://x/shared/p1)');
    expect(t).toContain('Message : Commande en échec');
    expect(t).toContain('- {"id":2,"status":"ko"}');
    expect(t).toContain('pages.data');
  });
});
