import { describe, expect, it, vi } from 'vitest';

// Le module lit les personnes et les sessions en base : on n'en teste ici que les parties pures.
vi.mock('../users/repository.js', () => ({ userRepository: { findById: vi.fn() } }));
vi.mock('./repository.js', () => ({ sessionRepository: { findById: vi.fn() } }));

const { authorHeader, parseAuthor, SYSTEM_AUTHOR } = await import('./instructionAuthor.js');

describe('auteur des instructions', () => {
  it('annonce au modèle la personne ou la session qui écrit', () => {
    expect(authorHeader({ type: 'user', id: 'u1', name: 'Alice Martin', email: 'alice@toolso.io' }, 'Corrige le bug')).toBe('[Message de Alice Martin <alice@toolso.io>]');
    expect(authorHeader({ type: 'user', id: 'u1', name: 'alice@toolso.io', email: 'alice@toolso.io' }, 'Go')).toBe('[Message de alice@toolso.io]');
    expect(authorHeader({ type: 'session', id: 's1', name: 'Refonte' }, 'Go')).toBe("[Message de la session d'agent « Refonte » (@session:s1)]");
  });

  it('ne dit rien pour Skipper ni devant une commande', () => {
    expect(authorHeader(SYSTEM_AUTHOR, 'Reprends')).toBeNull();
    expect(authorHeader({ type: 'user', id: 'u1', name: 'Alice', email: null }, '/compact')).toBeNull();
    expect(authorHeader(null, 'Go')).toBeNull();
  });

  it('relit un auteur venu d’un JSON, et rien d’autre', () => {
    expect(parseAuthor({ type: 'user', id: 'u1', name: 'Alice', email: 'a@b.c' })).toEqual({ type: 'user', id: 'u1', name: 'Alice', email: 'a@b.c' });
    expect(parseAuthor({ type: 'session', id: 's1', name: 'X' })).toEqual({ type: 'session', id: 's1', name: 'X' });
    expect(parseAuthor({ type: 'system', name: 'Planification « Revue »' })).toEqual({ type: 'system', name: 'Planification « Revue »' });
    expect(parseAuthor({ type: 'user' })).toBeNull();
    expect(parseAuthor('Alice')).toBeNull();
    expect(parseAuthor(null)).toBeNull();
  });
});
