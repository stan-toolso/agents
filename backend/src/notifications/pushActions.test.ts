import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.SKIPPER_SECRET_KEY = 'ab'.repeat(32);
});

const { ACTION_TOKEN_TTL_SECONDS, signActionToken, verifyActionToken } = await import('./pushActions.js');

describe('jeton des boutons de notification', () => {
  it('désigne la demande et la personne', () => {
    const token = signActionToken('req-1', 'user-1', 1_000_000);
    expect(verifyActionToken(token, 1_000_000)).toEqual({ requestId: 'req-1', userId: 'user-1' });
  });

  it('expire avec la notification', () => {
    const token = signActionToken('req-1', 'user-1', 0);
    expect(verifyActionToken(token, (ACTION_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  it('refuse un jeton modifié', () => {
    const [body, sig] = signActionToken('req-1', 'user-1').split('.');
    const forged = Buffer.from(JSON.stringify({ r: 'req-1', u: 'user-2', e: 9e9 })).toString('base64url');
    expect(verifyActionToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyActionToken(`${body}.${sig}x`)).toBeNull();
    expect(verifyActionToken('n-importe-quoi')).toBeNull();
  });
});
