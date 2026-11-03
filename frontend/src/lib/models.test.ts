import { describe, expect, it } from 'vitest';
import { cleanTaskModels, isOpus, projectModelForTask, shortModel } from './models';

describe('models', () => {
  it('libellé court', () => {
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5');
    expect(shortModel('claude-opus-4-1-20250805')).toBe('opus 4.1');
    expect(shortModel('sonnet')).toBe('sonnet');
    expect(shortModel(null)).toBeNull();
  });
  it('famille Opus', () => {
    expect(isOpus('opus')).toBe(true);
    expect(isOpus('claude-opus-5-5')).toBe(true);
    expect(isOpus('sonnet')).toBe(false);
    expect(isOpus(null)).toBe(false);
  });
  it('modèle proposé pour une tâche : priorité, puis projet', () => {
    const project = { defaultModel: 'opus', taskModels: { low: 'sonnet' } };
    expect(projectModelForTask(project, 'LOW')).toBe('sonnet');
    expect(projectModelForTask(project, 'HIGH')).toBe('opus');
    expect(projectModelForTask({ defaultModel: null, taskModels: null }, 'LOW')).toBeNull();
    expect(projectModelForTask(null, 'LOW')).toBeNull();
  });
  it('nettoyage des modèles par priorité', () => {
    expect(cleanTaskModels({ low: 'sonnet', high: '' })).toEqual({ low: 'sonnet' });
    expect(cleanTaskModels({ low: '' })).toBeNull();
  });
});
