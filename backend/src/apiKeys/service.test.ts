import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));
const { normalizeScopes, DEFAULT_SCOPES } = await import('./service.js');

describe('normalizeScopes', () => {
  it("donne l'API des tâches par défaut", () => {
    expect(normalizeScopes(undefined)).toEqual(DEFAULT_SCOPES);
    expect(normalizeScopes(null)).toEqual(['tasks:read', 'tasks:write']);
  });
  it('dédoublonne et ordonne', () => {
    expect(normalizeScopes(['inbound:triage', 'inbound:task', 'inbound:triage'])).toEqual(['inbound:task', 'inbound:triage']);
  });
  it('refuse une portée inconnue ou une liste vide', () => {
    expect(() => normalizeScopes(['admin'])).toThrow(/Portée inconnue/);
    expect(() => normalizeScopes([])).toThrow(/au moins une portée/);
  });
});
