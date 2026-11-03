import { describe, expect, it } from 'vitest';
import { statusDateSets } from './repository.js';

describe('statusDateSets (dates de cycle d’une tâche)', () => {
  it('à faire : efface le démarrage, la fin et l’annulation', () => {
    expect(statusDateSets('todo')).toEqual(['started_at = NULL', 'completed_at = NULL', 'cancelled_at = NULL']);
  });
  it('en cours : garde le premier démarrage', () => {
    expect(statusDateSets('in_progress')).toEqual(['started_at = COALESCE(started_at, now())', 'completed_at = NULL', 'cancelled_at = NULL']);
  });
  it('terminée : démarre si besoin et garde la première fin', () => {
    expect(statusDateSets('done')).toEqual(['started_at = COALESCE(started_at, now())', 'completed_at = COALESCE(completed_at, now())', 'cancelled_at = NULL']);
  });
  it('annulée : ne touche pas au démarrage', () => {
    expect(statusDateSets('cancelled')).toEqual(['completed_at = NULL', 'cancelled_at = COALESCE(cancelled_at, now())']);
  });
});
