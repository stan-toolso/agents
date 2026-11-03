import { describe, expect, it, vi } from 'vitest';

// Le serveur MCP `sessions` tire le service des sessions (processus, terminaux) : inutile pour le texte du prompt.
vi.mock('./service.js', () => ({ sessionService: {} }));
vi.mock('../worksessions/service.js', () => ({ worksessionService: {} }));
vi.mock('../projects/service.js', () => ({ projectService: {} }));
import { archivesWhenIdle, autoArchiveConfig, withoutAutoArchive } from './autoArchive.js';
import { archivePromptSummary } from './mcp.js';

const base = { config: autoArchiveConfig(), takenOverById: null, parentSessionId: null, archivedAt: null, kind: 'session' as const };

describe('archivage d’office des sessions lancées sans personne', () => {
  it('range une session lancée par un déclencheur', () => {
    expect(archivesWhenIdle(base)).toBe(true);
  });

  it('ne range pas une session sans le drapeau (lancée ou pilotée par une personne)', () => {
    expect(archivesWhenIdle({ ...base, config: {} })).toBe(false);
    expect(archivesWhenIdle({ ...base, config: withoutAutoArchive({ ...autoArchiveConfig(), model: 'sonnet' }) })).toBe(false);
  });

  it('ne range ni une session prise en main, ni une sous-session, ni une session déjà archivée', () => {
    expect(archivesWhenIdle({ ...base, takenOverById: 'u1' })).toBe(false);
    expect(archivesWhenIdle({ ...base, parentSessionId: 's0' })).toBe(false);
    expect(archivesWhenIdle({ ...base, archivedAt: new Date() })).toBe(false);
    expect(archivesWhenIdle({ ...base, kind: 'chat' })).toBe(false);
  });

  it('withoutAutoArchive garde le reste de la configuration', () => {
    expect(withoutAutoArchive({ ...autoArchiveConfig(), model: 'sonnet' })).toEqual({ model: 'sonnet' });
  });

  it('le prompt annonce l’archivage d’office', () => {
    expect(archivePromptSummary({ agent: true, auto: true })).toContain("Skipper l'archive d'office");
    expect(archivePromptSummary({ agent: true })).not.toContain("Skipper l'archive d'office");
  });
});
