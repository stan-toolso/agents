import { describe, expect, it } from 'vitest';
import { assertDataSize, countRows, describeSource, normalizeSqlResult, parseRefreshMinutes, parseScriptOutput, parseSources, scriptCommand } from './dataSources.js';
import { injectDataScript, jsonForScript } from './inject.js';

describe('parseSources', () => {
  it('normalise une source SQL (nom d’élément en minuscules, point-virgule final retiré)', () => {
    const [s] = parseSources([{ name: 'ventes', type: 'sql', item: 'Base', query: 'SELECT 1;  ' }]);
    expect(s).toEqual({ name: 'ventes', kind: 'sql', config: { item: 'base', database: null, query: 'SELECT 1' } });
  });

  it('donne un interpréteur et un délai par défaut au script', () => {
    const [s] = parseSources([{ name: 'cpu', type: 'script', code: 'console.log("[]")' }]);
    expect(s.config).toEqual({ interpreter: 'node', code: 'console.log("[]")', timeoutSeconds: 60 });
  });

  it('refuse un nom invalide, un doublon, un type inconnu, une source incomplète', () => {
    expect(() => parseSources([{ name: 'Ventes', type: 'sql', item: 'b', query: 'x' }])).toThrow(/minuscule/);
    expect(() => parseSources([{ name: 'a', type: 'sql', item: 'b', query: 'x' }, { name: 'a', type: 'sql', item: 'b', query: 'y' }])).toThrow(/double/);
    expect(() => parseSources([{ name: 'a', type: 'csv' }])).toThrow(/sql », « script » ou « graphql/);
    expect(() => parseSources([{ name: 'a', type: 'sql', query: 'x' }])).toThrow(/item/);
    expect(() => parseSources([{ name: 'a', type: 'script', interpreter: 'ruby', code: 'x' }])).toThrow(/interpreter/);
    expect(() => parseSources(Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, type: 'script', code: 'x' })))).toThrow(/12 sources/);
  });
});

describe('parseRefreshMinutes', () => {
  it('accepte null, 0 (à la demande) et un entier borné', () => {
    expect(parseRefreshMinutes(null)).toBeNull();
    expect(parseRefreshMinutes(0)).toBeNull();
    expect(parseRefreshMinutes(60)).toBe(60);
    expect(() => parseRefreshMinutes(2)).toThrow(/5 minutes/);
    expect(() => parseRefreshMinutes(7.5)).toThrow();
  });
});

describe('normalizeSqlResult', () => {
  it('convertit les colonnes numériques rendues en texte, garde les codes à zéro en tête, met les dates en ISO', () => {
    const r = normalizeSqlResult(['jour', 'n', 'cp', 'total'], [
      { jour: new Date('2026-11-01T00:00:00Z'), n: '12', cp: '01000', total: '3.50' },
      { jour: new Date('2026-11-02T00:00:00Z'), n: null, cp: '75001', total: 4 },
    ]);
    expect(r.columns).toEqual(['jour', 'n', 'cp', 'total']);
    expect(r.rows[0]).toEqual({ jour: '2026-11-01T00:00:00.000Z', n: 12, cp: '01000', total: 3.5 });
    expect(r.rows[1].n).toBeNull();
    expect(r.rows[1].total).toBe(4);
  });
});

describe('parseScriptOutput', () => {
  it('lit du JSON, éventuellement précédé de lignes de journal', () => {
    expect(parseScriptOutput('[1,2]')).toEqual([1, 2]);
    expect(parseScriptOutput('démarrage…\nfini\n{"a":1}\n')).toEqual({ a: 1 });
    expect(() => parseScriptOutput('')).toThrow(/rien écrit/);
    expect(() => parseScriptOutput('pas du json')).toThrow(/JSON valide/);
  });
});

describe('utilitaires', () => {
  it('compte les lignes, borne la taille, nomme le script', () => {
    expect(countRows([1, 2, 3])).toBe(3);
    expect(countRows({ columns: [], rows: [{}] })).toBe(1);
    expect(countRows({ a: 1 })).toBeNull();
    expect(() => assertDataSize('x'.repeat(2 * 1024 * 1024 + 10))).toThrow(/volumineux/);
    expect(scriptCommand('python')).toEqual({ file: 'source.py', command: ['python3', 'source.py'] });
  });

  it('décrit une source en une ligne', () => {
    const line = describeSource({ name: 'ventes', kind: 'sql', config: { item: 'base', database: null, query: 'x' }, status: 'error', error: 'boom', rowCount: null, refreshedAt: null });
    expect(line).toBe('ventes · SQL sur « base » · erreur : boom');
  });
});

describe('injectDataScript', () => {
  it('injecte window.Skipper après <head>, une seule fois, sans </script> possible', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script>console.log(Skipper.data.v.rows.length)</script></head><body></body></html>';
    const out = injectDataScript(html, { data: { v: { columns: ['t'], rows: [{ t: '</script><b>' }] } }, meta: { refreshedAt: null, sources: [] } });
    expect(out.indexOf('data-skipper-data')).toBeLessThan(out.indexOf('<meta'));
    expect(out).not.toContain('</script><b>');
    expect(out).toContain('\\u003c/script>');
    expect(injectDataScript(out, { data: {}, meta: {} })).toBe(out);
  });

  it('se met tout au début sans <head>', () => {
    expect(injectDataScript('<p>x</p>', { data: {}, meta: {} }).startsWith('<script data-skipper-data>')).toBe(true);
  });

  it('échappe les séparateurs de ligne Unicode', () => {
    expect(jsonForScript('a\u2028b')).toBe('"a\\u2028b"');
  });
});
