import { describe, expect, it } from 'vitest';
import { authorKey, continuesPrevious, layoutThread } from './threadGroups';

const now = new Date('2026-11-12T15:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const msg = (id: string, minutesAgo: number, author: { id: string } | null, extra: Record<string, unknown> = {}) => ({ id, createdAt: at(minutesAgo), authorName: author?.id ?? 'x', author, authorSession: null, agent: null, ...extra });

describe('groupes de messages', () => {
  it('distingue les auteurs par agent, personne, session puis nom', () => {
    expect(authorKey(msg('a', 1, { id: 'u1' }))).toBe('user:u1');
    expect(authorKey(msg('a', 1, null, { agent: { id: 'ag' } }))).toBe('agent:ag');
    expect(authorKey(msg('a', 1, null, { authorSession: { id: 's1' } }))).toBe('session:s1');
    expect(authorKey(msg('a', 1, null, { authorName: 'Quelqu’un' }))).toBe('name:Quelqu’un');
  });

  it('continue le précédent à moins de cinq minutes, même auteur, sans fil ouvert', () => {
    const a = msg('a', 4, { id: 'u1' });
    expect(continuesPrevious(a, msg('b', 2, { id: 'u1' }))).toBe(true);
    expect(continuesPrevious(a, msg('b', 2, { id: 'u2' }))).toBe(false);
    expect(continuesPrevious(msg('a', 10, { id: 'u1' }), msg('b', 2, { id: 'u1' }))).toBe(false);
    expect(continuesPrevious(a, msg('b', 2, { id: 'u1' }), 3)).toBe(false);
    expect(continuesPrevious(null, msg('b', 2, { id: 'u1' }))).toBe(false);
  });
});

describe('disposition du fil', () => {
  it('sépare les jours, repère les nouveaux messages des autres et groupe le reste', () => {
    const roots = [msg('old', 60 * 30, { id: 'u2' }), msg('a', 5, { id: 'u1' }), msg('b', 4, { id: 'u1' }), msg('c', 3, { id: 'u2' }), msg('d', 2, { id: 'u2' })];
    const items = layoutThread(roots, () => 0, { lastReadAt: at(4.5), viewerId: 'u1', now });
    expect(items.map((i) => (i.kind === 'message' ? `${i.message.id}${i.continued ? '+' : ''}` : i.kind === 'day' ? `day:${i.label}` : 'new'))).toEqual(['day:Hier', 'old', "day:Aujourd'hui", 'a', 'b+', 'new', 'c', 'd+']);
  });

  it('ne met pas de repère sans dernière lecture, ni pour ses propres messages', () => {
    const roots = [msg('a', 5, { id: 'u1' }), msg('b', 1, { id: 'u1' })];
    expect(layoutThread(roots, () => 0, { lastReadAt: null, viewerId: 'u1', now }).some((i) => i.kind === 'new')).toBe(false);
    expect(layoutThread(roots, () => 0, { lastReadAt: at(3), viewerId: 'u1', now }).some((i) => i.kind === 'new')).toBe(false);
  });

  it('un fil de réponses sous le précédent rompt le groupe', () => {
    const roots = [msg('a', 3, { id: 'u1' }), msg('b', 2, { id: 'u1' })];
    const items = layoutThread(roots, (r) => (r.id === 'a' ? 2 : 0), { now });
    expect(items.filter((i) => i.kind === 'message').map((i) => (i.kind === 'message' ? i.continued : null))).toEqual([false, false]);
  });
});
