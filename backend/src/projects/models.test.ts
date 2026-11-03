import { describe, expect, it } from 'vitest';
import { normalizeModel, normalizeTaskModels, projectModelFor } from './models.js';

describe('normalizeModel', () => {
  it('garde un alias ou un identifiant, vide = null', () => {
    expect(normalizeModel(' sonnet ')).toBe('sonnet');
    expect(normalizeModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(normalizeModel('opus[1m]')).toBe('opus[1m]');
    expect(normalizeModel('')).toBeNull();
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel(undefined)).toBeNull();
  });
  it('refuse un nom invalide', () => {
    expect(() => normalizeModel('rm -rf /')).toThrow();
    expect(() => normalizeModel(42)).toThrow();
  });
});

describe('normalizeTaskModels', () => {
  it('retire les priorités vides, null quand rien', () => {
    expect(normalizeTaskModels({ low: 'sonnet', medium: '', high: null })).toEqual({ low: 'sonnet' });
    expect(normalizeTaskModels({ low: ' ' })).toBeNull();
    expect(normalizeTaskModels(null)).toBeNull();
  });
  it('refuse une priorité inconnue', () => {
    expect(() => normalizeTaskModels({ basse: 'sonnet' })).toThrow();
    expect(() => normalizeTaskModels(['sonnet'])).toThrow();
  });
});

describe('projectModelFor', () => {
  const project = { defaultModel: 'sonnet', taskModels: { low: 'haiku' as const } as Record<string, string> };
  it('priorité de la tâche, puis défaut du projet, puis rien', () => {
    expect(projectModelFor(project, 'low')).toBe('haiku');
    expect(projectModelFor(project, 'high')).toBe('sonnet');
    expect(projectModelFor(project)).toBe('sonnet');
    expect(projectModelFor({ defaultModel: null, taskModels: null }, 'low')).toBeNull();
    expect(projectModelFor({ defaultModel: null, taskModels: { urgent: 'opus' } }, 'urgent')).toBe('opus');
  });
});
