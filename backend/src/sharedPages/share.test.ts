import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../users/types.js';

const state = vi.hoisted(() => ({
  users: [] as User[],
  members: new Map<string, { message: string | null }>(),
  sent: [] as { to: string; subject: string; text: string; replyTo?: string }[],
  notified: [] as { userId: string; message: string }[],
  links: [] as { userId: string; nextPath: string }[],
  smtp: true,
}));

const page = { id: 'p1', ownerId: 'stan', title: 'Offre 2027', description: null, linkAccess: false, version: 1 };
vi.mock('./repository.js', () => ({
  sharedPageRepository: {
    findById: async () => page,
    isMember: async () => false,
    addMember: async (_p: string, userId: string, _by: string, message: string | null) => {
      const had = state.members.has(userId);
      state.members.set(userId, { message: message ?? state.members.get(userId)?.message ?? null });
      return !had;
    },
  },
}));
vi.mock('../users/repository.js', () => ({ userRepository: { findByEmail: async (e: string) => state.users.find((u) => u.email === e) ?? null } }));
vi.mock('../users/service.js', () => ({
  userService: {
    findOrCreateGuest: async (email: string) => {
      const user = person(email.split('@')[0], email, { isGuest: true });
      state.users.push(user);
      return { user, created: true };
    },
  },
}));
vi.mock('../notifications/mail.js', () => ({ mailService: { configured: async () => state.smtp, send: async (m: (typeof state.sent)[number]) => void state.sent.push(m) } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: { userId: string; message: string }) => void state.notified.push({ userId: n.userId, message: n.message }) } }));
vi.mock('../auth/signInService.js', () => ({
  SHARE_LOGIN_LINK_DAYS: 30,
  signInService: { createLoginLink: async (u: User, nextPath: string) => (state.links.push({ userId: u.id, nextPath }), `https://app/auth/link/tok-${u.id}`) },
}));

const { sharedPageService } = await import('./service.js');

function person(id: string, email: string, extra: Partial<User> = {}): User {
  return { id, email, name: id, kind: 'person', avatarUrl: null, googleSub: null, isAdmin: false, isSuperAdmin: false, isCto: false, isGuest: false, createdAt: new Date(), lastLoginAt: new Date(), passwordSetAt: null, ...extra };
}
const stan = person('stan', 'stan@toolso.io', { name: 'Stan Giraudet' });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  state.users = [stan, person('alice', 'alice@toolso.io')];
  state.members.clear();
  state.sent = [];
  state.notified = [];
  state.links = [];
  state.smtp = true;
});

describe('partage d’une page avec un message', () => {
  it('invite une adresse inconnue : compte invité, e-mail avec lien de connexion directe et message', async () => {
    await expect(sharedPageService.addMember(stan, 'p1', 'claire@client.fr', { message: 'Voici notre offre.' })).rejects.toMatchObject({ code: 'NO_ACCOUNT' });
    await sharedPageService.addMember(stan, 'p1', 'claire@client.fr', { invite: true, message: '  Voici notre offre.\r\n\r\n\r\nBonne lecture  ' });
    await flush();
    expect(state.members.get('claire')).toEqual({ message: 'Voici notre offre.\n\nBonne lecture' });
    expect(state.links).toEqual([{ userId: 'claire', nextPath: '/shared/p1' }]);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ to: 'claire@client.fr', replyTo: 'stan@toolso.io', subject: 'Stan Giraudet vous invite à consulter « Offre 2027 »' });
    expect(state.sent[0].text).toContain('https://app/auth/link/tok-claire');
    expect(state.sent[0].text).toContain('> Voici notre offre.');
    expect(state.notified[0].message).toContain('Voici notre offre.');
  });

  it("une personne de Skipper reçoit le lien de la page, sans lien de connexion directe ; notify: false n'envoie rien", async () => {
    await sharedPageService.addMember(stan, 'p1', 'alice@toolso.io', {});
    await flush();
    expect(state.links).toEqual([]);
    expect(state.sent[0].text).toMatch(/\/shared\/p1/);
    state.sent = [];
    await sharedPageService.addMember(stan, 'p1', 'alice@toolso.io', { notify: false, message: 'Nouvelle version' });
    await flush();
    expect(state.sent).toEqual([]);
    expect(state.members.get('alice')).toEqual({ message: 'Nouvelle version' });
  });

  it('refuse un message trop long', async () => {
    await expect(sharedPageService.addMember(stan, 'p1', 'alice@toolso.io', { message: 'x'.repeat(2001) })).rejects.toThrow(/2000/);
  });
});
