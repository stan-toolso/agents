import { describe, expect, it } from 'vitest';
import { isGoneError } from './gone';

describe('isGoneError', () => {
  it('reconnaît un élément supprimé ou inaccessible', () => {
    expect(isGoneError({ graphQLErrors: [{ extensions: { code: 'NOT_FOUND' } }] })).toBe(true);
    expect(isGoneError({ graphQLErrors: [{ extensions: { code: 'FORBIDDEN' } }] })).toBe(true);
  });

  it('ignore les autres erreurs', () => {
    expect(isGoneError({ graphQLErrors: [{ extensions: { code: 'BAD_REQUEST' } }] })).toBe(false);
    expect(isGoneError({ graphQLErrors: [] })).toBe(false);
    expect(isGoneError(new Error('réseau'))).toBe(false);
    expect(isGoneError(null)).toBe(false);
    expect(isGoneError(undefined)).toBe(false);
  });
});
