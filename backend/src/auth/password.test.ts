import { describe, expect, it } from 'vitest';
import { hashPassword, loginThrottle, passwordProblem, verifyPassword } from './password.js';

describe('mots de passe', () => {
  it('vérifie une empreinte scrypt et refuse un autre mot de passe', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
  });

  it('deux empreintes du même mot de passe diffèrent (sel)', async () => {
    expect(await hashPassword('même mot de passe')).not.toBe(await hashPassword('même mot de passe'));
  });

  it('refuse une empreinte absente ou illisible', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$abc')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$sel$')).toBe(false);
  });

  it('juge la force du mot de passe', () => {
    expect(passwordProblem('court')).toMatch(/au moins 10/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/répétitif/);
    expect(passwordProblem('alice.martin', 'alice.martin@example.com')).toMatch(/adresse/);
    expect(passwordProblem('un vrai mot de passe', 'alice@example.com')).toBeNull();
  });

  it('freine les essais répétés par adresse, puis libère après une réussite', () => {
    loginThrottle.reset();
    const now = Date.now();
    for (let i = 0; i < 8; i++) loginThrottle.fail('a@x.fr', '1.2.3.4', now);
    expect(loginThrottle.blocked('a@x.fr', null, now)).toBe(true);
    expect(loginThrottle.blocked('b@x.fr', '5.6.7.8', now)).toBe(false);
    expect(loginThrottle.blocked('a@x.fr', null, now + 16 * 60 * 1000)).toBe(false);
    loginThrottle.succeed('a@x.fr');
    expect(loginThrottle.blocked('a@x.fr', null, now)).toBe(false);
  });
});
