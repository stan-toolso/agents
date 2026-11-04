import { describe, expect, it } from 'vitest';
import { runSessionName, validArchive } from './archive.js';

describe('validArchive', () => {
  it('laisse inchangé quand rien n’est demandé', () => {
    expect(validArchive({})).toBeUndefined();
    expect(validArchive({ archivePolicy: null })).toBeUndefined();
  });

  it('accepte les valeurs GraphQL (majuscules) et ignore le délai hors after_delay', () => {
    expect(validArchive({ archivePolicy: 'ON_FINISH' as never, archiveAfterMinutes: 30 })).toEqual({ policy: 'on_finish', afterMinutes: null });
    expect(validArchive({ archivePolicy: 'previous_on_run' })).toEqual({ policy: 'previous_on_run', afterMinutes: null });
    expect(validArchive({ archivePolicy: 'NEVER' as never })).toEqual({ policy: 'never', afterMinutes: null });
  });

  it('exige un délai valable pour after_delay', () => {
    expect(validArchive({ archivePolicy: 'AFTER_DELAY' as never, archiveAfterMinutes: 1440 })).toEqual({ policy: 'after_delay', afterMinutes: 1440 });
    expect(() => validArchive({ archivePolicy: 'after_delay' })).toThrow(/combien de temps/);
    expect(() => validArchive({ archivePolicy: 'after_delay', archiveAfterMinutes: 0 })).toThrow(/combien de temps/);
    expect(() => validArchive({ archivePolicy: 'after_delay', archiveAfterMinutes: 91 * 1440 })).toThrow(/90 jours/);
  });

  it('refuse une valeur inconnue', () => {
    expect(() => validArchive({ archivePolicy: 'bientot' as never })).toThrow(/inconnu/);
  });
});

describe('runSessionName', () => {
  it('ajoute la date dans le fuseau de la planification', () => {
    expect(runSessionName('Revue', new Date('2026-11-04T08:00:00Z'), 'Europe/Paris')).toBe('Revue · 04/11 09:00');
  });

  it('tient dans 120 caractères et survit à un fuseau inconnu', () => {
    expect(runSessionName('x'.repeat(200), new Date(), 'UTC').length).toBe(120);
    expect(runSessionName('Revue', new Date('2026-11-04T08:00:00Z'), 'Pas/Un_Fuseau')).toBe('Revue · 2026-11-04 08:00');
  });
});
