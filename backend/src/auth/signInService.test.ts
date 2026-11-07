import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalIdentity, User, UserIdentity } from '../users/types.js';

// Base et SMTP simulés : le dépôt des utilisateurs tient en mémoire.
const state = vi.hoisted(() => ({
  users: [] as User[],
  hashes: new Map<string, string | null>(),
  identities: [] as UserIdentity[],
  tokens: new Map<string, { userId: string; used: boolean; expiresAt: Date; createdBy: string | null; createdAt: Date }>(),
  sent: [] as { to: string; subject: string; text: string }[],
  smtp: true,
  deletedSessions: [] as { userId: string; except: string | null }[],
}));

vi.mock('../users/repository.js', () => {
  const find = (id: string) => state.users.find((u) => u.id === id) ?? null;
  return {
    userRepository: {
      findById: async (id: string) => find(id),
      findByEmail: async (email: string) => state.users.find((u) => u.email === email.toLowerCase()) ?? null,
      findIdentity: async (provider: string, subject: string) => state.identities.find((i) => i.provider === provider && i.subject === subject) ?? null,
      listIdentities: async (userId: string) => state.identities.filter((i) => i.userId === userId),
      linkIdentity: async (i: { provider: string; subject: string; userId: string; email: string | null }) => {
        state.identities = state.identities.filter((x) => !(x.userId === i.userId && x.provider === i.provider));
        state.identities.push({ ...i, createdAt: new Date(), lastUsedAt: new Date() });
      },
      unlinkIdentity: async () => true,
      unlinkGoogle: async (id: string) => find(id),
      touchLogin: async (id: string) => ({ ...find(id)!, lastLoginAt: new Date() }),
      passwordHash: async (id: string) => state.hashes.get(id) ?? null,
      setPasswordHash: async (id: string, hash: string | null) => {
        state.hashes.set(id, hash);
        const u = find(id)!;
        u.passwordSetAt = hash ? new Date() : null;
        return u;
      },
      createPasswordToken: async (h: string, userId: string, expiresAt: Date, createdBy: string | null) => void state.tokens.set(h, { userId, used: false, expiresAt, createdBy, createdAt: new Date() }),
      findPasswordTokenUser: async (h: string) => {
        const t = state.tokens.get(h);
        return t && !t.used && t.expiresAt > new Date() ? find(t.userId) : null;
      },
      consumePasswordToken: async (h: string) => {
        const t = state.tokens.get(h);
        if (!t || t.used) return false;
        t.used = true;
        return true;
      },
      revokePasswordTokens: async (userId: string) => {
        for (const t of state.tokens.values()) if (t.userId === userId) t.used = true;
      },
      lastSelfServiceTokenAt: async (userId: string) => [...state.tokens.values()].filter((t) => t.userId === userId && !t.createdBy).map((t) => t.createdAt).sort((a, b) => +b - +a)[0] ?? null,
      deleteUserSessions: async (userId: string, except: string | null = null) => void state.deletedSessions.push({ userId, except }),
      deleteExpiredPasswordTokens: async () => 0,
    },
  };
});
vi.mock('../notifications/smtp.js', () => ({
  smtpService: { configured: async () => state.smtp, send: async (m: { to: string; subject: string; text: string }) => void state.sent.push(m) },
}));

const { signInService } = await import('./signInService.js');
const { hashPassword, loginThrottle } = await import('./password.js');

const person = (id: string, email: string, extra: Partial<User> = {}): User => ({
  id, email, name: id, kind: 'person', avatarUrl: null, googleSub: null, isAdmin: false, isSuperAdmin: false, isGuest: false, createdAt: new Date(), lastLoginAt: null, passwordSetAt: null, ...extra,
});
const github = (extra: Partial<ExternalIdentity> = {}): ExternalIdentity => ({ provider: 'github', subject: '42', verifiedEmails: ['alice@example.com'], email: 'alice@example.com', name: 'Alice', avatarUrl: null, ...extra });

beforeEach(() => {
  state.users = [person('alice', 'alice@example.com'), person('bob', 'bob@example.com'), person('ben', 'ben@agents.local', { kind: 'agent' })];
  state.hashes.clear();
  state.identities = [];
  state.tokens.clear();
  state.sent = [];
  state.smtp = true;
  state.deletedSessions = [];
  loginThrottle.reset();
});

describe('connexion par un compte Microsoft ou GitHub', () => {
  it("retrouve l'invitation par une adresse vérifiée et relie le compte", async () => {
    const user = await signInService.loginWithIdentity(github());
    expect(user.id).toBe('alice');
    expect(state.identities).toMatchObject([{ provider: 'github', subject: '42', userId: 'alice' }]);
  });

  it('reconnaît ensuite le compte relié, même avec une autre adresse', async () => {
    state.identities.push({ provider: 'github', subject: '42', userId: 'bob', email: null, createdAt: new Date(), lastUsedAt: null });
    expect((await signInService.loginWithIdentity(github({ verifiedEmails: [], email: 'autre@ailleurs.fr' }))).id).toBe('bob');
  });

  it('refuse une adresse non vérifiée, une adresse non invitée et un agent', async () => {
    await expect(signInService.loginWithIdentity(github({ verifiedEmails: [] }))).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    await expect(signInService.loginWithIdentity(github({ verifiedEmails: ['inconnu@example.com'] }))).rejects.toMatchObject({ code: 'NOT_INVITED' });
    await expect(signInService.loginWithIdentity(github({ verifiedEmails: ['ben@agents.local'] }))).rejects.toMatchObject({ code: 'NOT_INVITED' });
  });

  it("ne relie pas à soi un compte déjà relié à quelqu'un d'autre", async () => {
    state.identities.push({ provider: 'github', subject: '42', userId: 'bob', email: null, createdAt: new Date(), lastUsedAt: null });
    await expect(signInService.linkIdentity(state.users[0], github())).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  });
});

describe('connexion par mot de passe', () => {
  it('connecte avec le bon mot de passe, refuse sinon avec le même message', async () => {
    state.hashes.set('alice', await hashPassword('mot de passe sûr'));
    expect((await signInService.loginWithPassword(' Alice@Example.com ', 'mot de passe sûr', null)).id).toBe('alice');
    const wrong = await signInService.loginWithPassword('alice@example.com', 'mauvais', null).catch((e) => e);
    const unknown = await signInService.loginWithPassword('personne@example.com', 'mauvais', null).catch((e) => e);
    expect(wrong).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(unknown.message).toBe(wrong.message);
  });

  it("refuse un agent même s'il avait une empreinte", async () => {
    state.hashes.set('ben', await hashPassword('mot de passe sûr'));
    await expect(signInService.loginWithPassword('ben@agents.local', 'mot de passe sûr', null)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('bloque après trop d’échecs', async () => {
    for (let i = 0; i < 8; i++) await signInService.loginWithPassword('alice@example.com', 'x', null).catch(() => undefined);
    await expect(signInService.loginWithPassword('alice@example.com', 'x', null)).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('changer son mot de passe exige le mot de passe actuel et ferme les autres sessions', async () => {
    const alice = state.users[0];
    await signInService.setPassword(alice, null, 'premier mot de passe', 'h1');
    expect(state.deletedSessions).toEqual([]);
    await expect(signInService.setPassword(alice, 'faux', 'second mot de passe', 'h1')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await signInService.setPassword(alice, 'premier mot de passe', 'second mot de passe', 'h1');
    expect(state.deletedSessions).toEqual([{ userId: 'alice', except: 'h1' }]);
  });
});

describe('liens de mot de passe', () => {
  it('« mot de passe oublié » envoie un lien une fois, puis le lien sert une seule fois', async () => {
    await signInService.requestPasswordReset('alice@example.com');
    await signInService.requestPasswordReset('alice@example.com');
    expect(state.sent).toHaveLength(1);
    const token = /token=([\w-]+)/.exec(state.sent[0].text)![1];
    expect((await signInService.userOfToken(token))?.id).toBe('alice');
    expect((await signInService.resetPassword(token, 'nouveau mot de passe')).id).toBe('alice');
    expect(state.deletedSessions).toEqual([{ userId: 'alice', except: null }]);
    await expect(signInService.resetPassword(token, 'encore un autre')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await signInService.loginWithPassword('alice@example.com', 'nouveau mot de passe', null)).id).toBe('alice');
  });

  it("n'envoie rien pour une adresse inconnue, un agent ou sans SMTP", async () => {
    await signInService.requestPasswordReset('inconnu@example.com');
    await signInService.requestPasswordReset('ben@agents.local');
    state.smtp = false;
    await signInService.requestPasswordReset('alice@example.com');
    expect(state.sent).toEqual([]);
  });

  it("lien créé par un administrateur : rendu, envoyé sur demande, jamais pour un agent", async () => {
    const admin = person('root', 'root@example.com', { isAdmin: true });
    const link = await signInService.createPasswordLink(state.users[1], admin, false);
    expect(link.url).toMatch(/\/reset-password\?token=/);
    expect(link.emailed).toBe(false);
    expect((await signInService.createPasswordLink(state.users[1], admin, true)).emailed).toBe(true);
    expect(state.sent[0].to).toBe('bob@example.com');
    await expect(signInService.createPasswordLink(state.users[2], admin, false)).rejects.toThrow(/agent/);
  });

  it('refuse un mot de passe trop faible sans consommer le lien', async () => {
    const { url } = await signInService.createPasswordLink(state.users[0], person('root', 'root@example.com', { isAdmin: true }), false);
    const token = new URL(url).searchParams.get('token')!;
    await expect(signInService.resetPassword(token, 'court')).rejects.toThrow(/au moins/);
    expect((await signInService.resetPassword(token, 'assez long cette fois')).id).toBe('alice');
  });
});
