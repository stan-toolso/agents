import { describe, expect, it } from 'vitest';
import { decodeJwtPayload, MICROSOFT_CONSUMER_TENANT, microsoftIdentityFromClaims } from './providers.js';

const ORG = '11111111-2222-3333-4444-555555555555';

describe('identité Microsoft', () => {
  it('compte personnel : adresse vérifiée', () => {
    const id = microsoftIdentityFromClaims({ tid: MICROSOFT_CONSUMER_TENANT, oid: 'o1', email: 'Alice@Outlook.com', name: 'Alice' }, 'common');
    expect(id).toMatchObject({ provider: 'microsoft', subject: `${MICROSOFT_CONSUMER_TENANT}:o1`, verifiedEmails: ['alice@outlook.com'], name: 'Alice' });
  });

  it("compte d'un annuaire quelconque : adresse non garantie (nOAuth)", () => {
    const id = microsoftIdentityFromClaims({ tid: ORG, oid: 'o2', email: 'stan@toolso.io' }, 'common');
    expect(id.verifiedEmails).toEqual([]);
    expect(id.email).toBe('stan@toolso.io');
  });

  it('annuaire imposé par MICROSOFT_TENANT, ou domaine prouvé (xms_edov) : adresse retenue', () => {
    expect(microsoftIdentityFromClaims({ tid: ORG, oid: 'o3', preferred_username: 'bob@corp.fr' }, ORG).verifiedEmails).toEqual(['bob@corp.fr']);
    expect(microsoftIdentityFromClaims({ tid: ORG, oid: 'o4', email: 'eve@corp.fr', xms_edov: true }, 'common').verifiedEmails).toEqual(['eve@corp.fr']);
  });

  it("refuse un compte d'un autre annuaire que celui imposé, et un profil incomplet", () => {
    expect(() => microsoftIdentityFromClaims({ tid: MICROSOFT_CONSUMER_TENANT, oid: 'o5' }, ORG)).toThrow(/annuaire/);
    expect(() => microsoftIdentityFromClaims({ oid: 'o6' }, 'common')).toThrow(/incomplet/);
  });

  it('lit le contenu d’un JWT', () => {
    const token = `x.${Buffer.from(JSON.stringify({ aud: 'app', tid: 't' })).toString('base64url')}.sig`;
    expect(decodeJwtPayload(token)).toEqual({ aud: 'app', tid: 't' });
  });
});
