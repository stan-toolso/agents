import { describe, expect, it } from 'vitest';
import { namesFromText, uniqueName, uniqueNameAndBranch } from './names.js';

describe('namesFromText', () => {
  it('prend la première ligne comme libellé et un slug de ses premiers mots comme dossier', () => {
    expect(namesFromText('Corriger l’export CSV des factures\navec les détails')).toEqual({ label: 'Corriger l’export CSV des factures', name: 'corriger-l-export-csv-des-factures' });
  });
  it('limite le slug à six mots et 40 caractères', () => {
    const { name } = namesFromText('un deux trois quatre cinq six sept huit');
    expect(name).toBe('un-deux-trois-quatre-cinq-six');
    expect(namesFromText('a'.repeat(80)).name.length).toBeLessThanOrEqual(40);
  });
  it('ajoute le préfixe et retombe sur « travail » sans texte utilisable', () => {
    expect(namesFromText('   ', 'task-').name).toBe('task-travail');
    expect(namesFromText('Export', 'task-').name).toBe('task-export');
  });
});

describe('uniqueName', () => {
  it('ajoute un suffixe numérique quand le nom est pris', () => {
    expect(uniqueName([{ name: 'export' }, { name: 'export-2' }], 'export')).toBe('export-3');
    expect(uniqueName([], 'export')).toBe('export');
  });
});

describe('uniqueNameAndBranch', () => {
  it('garde les noms quand dossier et branche sont libres', () => {
    expect(uniqueNameAndBranch('export', 'export', ['autre'], ['main'])).toEqual({ name: 'export', branch: 'export' });
  });
  it('suffixe dossier et branche ensemble quand la branche existe déjà', () => {
    expect(uniqueNameAndBranch('export', 'export', [], ['main', 'export'])).toEqual({ name: 'export-2', branch: 'export-2' });
  });
  it('saute les suffixes pris par un dossier ou une branche', () => {
    expect(uniqueNameAndBranch('task-x', 'task/x', ['task-x', 'task-x-2'], ['task/x', 'task/x-3'])).toEqual({ name: 'task-x-4', branch: 'task/x-4' });
  });
});
