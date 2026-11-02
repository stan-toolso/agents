import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupFromLimit, lastContextLimit, limitFromCleanup, limitLabel, rememberContextLimit, validLimit } from './contextLimit';

describe('limite de contexte', () => {
  // Environnement node : un localStorage en mémoire suffit.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });

  it('se lit depuis les réglages de nettoyage, « fresh » et l’absence de seuil ne sont pas des limites', () => {
    expect(limitFromCleanup({ contextAction: 'compact', contextMaxTokens: 120_000 })).toEqual({ action: 'compact', maxK: 120 });
    expect(limitFromCleanup({ contextAction: 'fresh', contextMaxTokens: null }).action).toBe('');
    expect(limitFromCleanup(null).action).toBe('');
  });

  it('s’envoie au backend, objet vide sans limite', () => {
    expect(cleanupFromLimit({ action: 'reset', maxK: 80 })).toEqual({ contextAction: 'reset', contextMaxTokens: 80_000 });
    expect(cleanupFromLimit({ action: '', maxK: 80 })).toEqual({});
  });

  it('refuse un seuil sous 10 k et décrit le choix', () => {
    expect(validLimit({ action: 'compact', maxK: 5 })).toBe(false);
    expect(validLimit({ action: '', maxK: 0 })).toBe(true);
    expect(limitLabel({ action: 'compact', maxK: 100 })).toBe('compacter au-delà de 100 k');
    expect(limitLabel({ action: '', maxK: 100 }, 150)).toBe('me proposer au-delà de 150 k');
  });

  it('est mémorisée par projet', () => {
    expect(lastContextLimit('p1')).toBeNull();
    rememberContextLimit('p1', { action: 'compact', maxK: 90 });
    expect(lastContextLimit('p1')).toEqual({ action: 'compact', maxK: 90 });
    expect(lastContextLimit('p2')).toBeNull();
  });
});
