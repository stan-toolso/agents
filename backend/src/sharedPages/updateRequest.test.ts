import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedPage, SharedPageComment } from './types.js';

// Mise à jour d'une page par la session qui l'a publiée : texte de l'instruction, garde du propriétaire, page sans
// session, rien à transmettre, envoi à la session (relancée ou restaurée). Base, sessions et pages simulées.
const state = vi.hoisted(() => ({
  page: null as SharedPage | null,
  roots: [] as SharedPageComment[],
  replies: new Map<string, SharedPageComment[]>(),
  sent: [] as Array<{ id: string; text: string; opts: Record<string, unknown> }>,
}));
vi.mock('../config.js', () => ({ config: { appUrl: 'https://skipper.example.org' } }));
vi.mock('../sessions/service.js', () => ({
  sessionService: {
    sendMessage: async (id: string, text: string, _files: unknown, opts: Record<string, unknown>) => {
      state.sent.push({ id, text, opts });
      return { id, name: 'Rapport Elixis' };
    },
  },
}));
vi.mock('../users/repository.js', () => ({ userRepository: { findByIds: async (ids: string[]) => ids.map((id) => ({ id, name: { alice: 'Alice', bob: 'Bob', owner: 'Olivia' }[id] ?? id })) } }));
vi.mock('./service.js', () => ({
  sharedPageService: {
    getOwned: async (userId: string, id: string) => {
      if (!state.page || state.page.id !== id) throw new Error('Page partagée introuvable, ou non partagée avec vous');
      if (state.page.ownerId !== userId) throw new Error('Seul le propriétaire de la page peut faire cela');
      return state.page;
    },
  },
}));
vi.mock('./commentService.js', () => ({ sharedPageCommentService: { roots: async () => state.roots, replies: async (id: string) => state.replies.get(id) ?? [] } }));

const { formatUpdateInstruction, sharedPageUpdateService: svc } = await import('./updateRequest.js');

const owner = { id: 'owner', name: 'Olivia', email: 'olivia@example.org' } as unknown as import('../users/types.js').User;
const page = (extra: Partial<SharedPage> = {}): SharedPage => ({ id: 'p1', ownerId: 'owner', title: 'Rapport', description: null, linkAccess: false, version: 3, projectId: 'pr', sessionId: 's1', sourcePath: 'rapport.html', createdAt: new Date(), updatedAt: new Date(), ...extra });
const comment = (id: string, extra: Partial<SharedPageComment> = {}): SharedPageComment => ({ id, pageId: 'p1', parentId: null, authorId: 'alice', sessionId: null, body: 'Trop petit', anchor: { selector: 'main > h1', text: 'Titre', tag: 'h1' }, version: 3, resolvedAt: null, resolvedById: null, createdAt: new Date(), updatedAt: new Date(), ...extra });

beforeEach(() => {
  state.page = page();
  state.roots = [];
  state.replies.clear();
  state.sent = [];
});

describe("texte de l'instruction", () => {
  it('reprend la page, la demande, les commentaires (ancre, fil, version) et la consigne de republier puis traiter', () => {
    const text = formatUpdateInstruction(
      page(),
      [
        { comment: comment('c1'), author: 'Alice', replies: [{ author: 'Olivia', body: 'Vu' }] },
        { comment: comment('c2', { anchor: null, body: 'Ligne 1\nLigne 2', version: 2 }), author: 'Bob (agent)', replies: [] },
      ],
      'Mets les chiffres à jour',
      'Olivia',
    );
    expect(text).toContain('Mise à jour demandée par Olivia de la page partagée « Rapport » (page_id p1, version 3, https://skipper.example.org/shared/p1).');
    expect(text).toContain('Demande : Mets les chiffres à jour');
    expect(text).toContain('2 commentaires à prendre en compte :');
    expect(text).toContain('1. [c1] Alice, sur <h1> `main > h1` « Titre » :\n   Trop petit\n   ↳ Olivia : Vu');
    expect(text).toContain('2. [c2] Bob (agent), général (fait sur la version 2) :\n   Ligne 1\n   Ligne 2');
    expect(text).toContain('(rapport.html), puis publie une nouvelle version avec `pages.publish` (page_id p1). Marque ensuite chaque commentaire pris en compte comme traité avec `pages.resolve`');
  });

  it('sans commentaire : seulement la demande, sans consigne de traitement', () => {
    const text = formatUpdateInstruction(page({ sourcePath: null }), [], 'Ajoute un graphique', 'Olivia');
    expect(text).not.toContain('à prendre en compte');
    expect(text).not.toContain('pages.resolve');
    expect(text).toContain('Fais les changements dans le fichier HTML de la page, puis publie');
  });
});

describe('demande de mise à jour', () => {
  it('envoie à la session de la page, au nom du propriétaire, avec les commentaires non traités et leurs réponses', async () => {
    state.roots = [comment('c1'), comment('c2', { resolvedAt: new Date() })];
    state.replies.set('c1', [comment('r1', { parentId: 'c1', authorId: 'bob', body: 'Je confirme', anchor: null })]);
    const { session, text } = await svc.request(owner, 'p1', {});
    expect(session.id).toBe('s1');
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].opts).toMatchObject({ byPerson: true, unarchive: true, author: { type: 'user', id: 'owner', name: 'Olivia' } });
    expect(text).toContain('1 commentaire à prendre en compte');
    expect(text).toContain('[c1] Alice');
    expect(text).toContain('↳ Bob : Je confirme');
    expect(text).not.toContain('[c2]');
  });

  it('refuse sans session, sans rien à transmettre, et à qui n’est pas propriétaire', async () => {
    state.page = page({ sessionId: null });
    await expect(svc.request(owner, 'p1', { instruction: 'x' })).rejects.toThrow('aucune session');
    state.page = page();
    await expect(svc.request(owner, 'p1', {})).rejects.toThrow('Rien à transmettre');
    state.roots = [comment('c1')];
    await expect(svc.request(owner, 'p1', { withComments: false })).rejects.toThrow('Rien à transmettre');
    await expect(svc.request({ ...owner, id: 'alice' } as typeof owner, 'p1', {})).rejects.toThrow('propriétaire');
    expect(state.sent).toEqual([]);
  });
});
