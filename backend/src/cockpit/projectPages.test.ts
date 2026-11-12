import { describe, expect, it } from 'vitest';
import { PROJECT_TAB_KEYS, parseIcon, parseSlug, parseTabs, parseTitle, slugOf } from './projectPages.js';

describe('pages personnalisées', () => {
  it('dérive un slug lisible du titre', () => {
    expect(slugOf('Reporting client — Été 2026')).toBe('reporting-client-ete-2026');
    expect(slugOf('   ')).toBe('page');
    expect(slugOf('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
  it('valide titre, icône et slug', () => {
    expect(parseTitle('  Ma   page ')).toBe('Ma page');
    expect(() => parseTitle('')).toThrow(/obligatoire/);
    expect(parseIcon(undefined)).toBeNull();
    expect(parseIcon('bi-graph-up')).toBe('bi-graph-up');
    expect(() => parseIcon('<script>')).toThrow(/Icône invalide/);
    expect(parseSlug('Reporting')).toBe('reporting');
    expect(() => parseSlug('a b')).toThrow(/invalide/);
  });
  it('valide les onglets : clés connues, aperçu et réglages jamais masqués, pages dans l’ordre', () => {
    expect(parseTabs(null, [])).toEqual({ hidden: [], order: [] });
    expect(parseTabs({ hidden: ['repo', 'pullRequests', 'repo'], order: ['overview', 'page:reporting', 'tasks', 'page:absente', 'zzz'] }, ['reporting'])).toEqual({ hidden: ['repo', 'pullRequests'], order: ['overview', 'page:reporting', 'tasks'] });
    expect(() => parseTabs({ hidden: ['overview'] }, [])).toThrow(/ne se masque pas/);
    expect(() => parseTabs({ hidden: ['nope'] }, [])).toThrow(/Onglet inconnu/);
    expect(() => parseTabs([], [])).toThrow(/objet/);
    expect(PROJECT_TAB_KEYS).toContain('settings');
  });
});
