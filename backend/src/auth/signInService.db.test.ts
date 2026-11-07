import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Connexion sans Google sur une base PostgreSQL jetable (TEST_DATABASE_URL) : comptes externes reliés, mot de passe,
 * liens à usage unique et fermeture des sessions de connexion (requêtes du dépôt des utilisateurs).
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe.skipIf(!adminUrl)('modes de connexion (PostgreSQL)', () => {
  const name = `skipper_test_signin_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let svc: typeof import('./signInService.js')['signInService'];
  let repo: typeof import('../users/repository.js')['userRepository'];
  let alice: import('../users/types.js').User;
  let bob: import('../users/types.js').User;

  beforeAll(async () => {
    process.env.SKIPPER_SECRET_KEY = 'cd'.repeat(32);
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    repo = (await import('../users/repository.js')).userRepository;
    svc = (await import('./signInService.js')).signInService;
    alice = await repo.create({ email: 'alice@example.com', name: 'alice' });
    bob = await repo.create({ email: 'bob@example.com', name: 'bob' });
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('relie un compte GitHub à la première connexion, le reconnaît ensuite, un seul par fournisseur', async () => {
    const id = { provider: 'github' as const, subject: '1', verifiedEmails: ['alice@example.com'], email: 'alice@example.com', name: 'Alice Martin', avatarUrl: 'https://a/x.png' };
    const user = await svc.loginWithIdentity(id);
    expect(user).toMatchObject({ id: alice.id, name: 'Alice Martin', avatarUrl: 'https://a/x.png' });
    expect(user.lastLoginAt).not.toBeNull();
    expect((await svc.loginWithIdentity({ ...id, verifiedEmails: [], name: 'Autre' })).name).toBe('Alice Martin');
    await svc.linkIdentity(user, { ...id, subject: '2', email: 'alice@perso.fr' });
    expect((await repo.listIdentities(alice.id)).map((i) => [i.subject, i.email])).toEqual([['2', 'alice@perso.fr']]);
    await expect(svc.linkIdentity(bob, { ...id, subject: '2' })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    expect((await svc.unlinkIdentity(user, 'github')).identities).toEqual([]);
  });

  it('mot de passe : lien, choix, connexion, sessions fermées', async () => {
    await repo.createSession('s-a', alice.id, new Date(Date.now() + 3600_000));
    await repo.createSession('s-b', alice.id, new Date(Date.now() + 3600_000));
    const { url } = await svc.createPasswordLink(alice, bob, false);
    const token = new URL(url).searchParams.get('token')!;
    expect((await svc.userOfToken(token))?.id).toBe(alice.id);
    const after = await svc.resetPassword(token, 'une phrase de passe');
    expect(after.passwordSetAt).not.toBeNull();
    expect(await repo.findSessionUser('s-a')).toBeNull();
    expect(await svc.userOfToken(token)).toBeNull();
    expect((await svc.loginWithPassword('alice@example.com', 'une phrase de passe', null)).id).toBe(alice.id);

    await repo.createSession('s-c', alice.id, new Date(Date.now() + 3600_000));
    await repo.createSession('s-d', alice.id, new Date(Date.now() + 3600_000));
    const view = await svc.setPassword(after, 'une phrase de passe', 'une autre phrase', 's-c');
    expect(view.hasPassword).toBe(true);
    expect(await repo.findSessionUser('s-c')).not.toBeNull();
    expect(await repo.findSessionUser('s-d')).toBeNull();
    expect((await svc.removePassword(after)).hasPassword).toBe(false);
    await expect(svc.loginWithPassword('alice@example.com', 'une autre phrase', null)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await svc.purgeExpiredTokens()).toBe(0);
  });
});
