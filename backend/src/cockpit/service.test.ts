import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../users/types.js';

const P = '11111111-2222-4333-8444-555555555555';
const A = '22222222-2222-4333-8444-555555555555';
const { store, userService } = vi.hoisted(() => ({
  store: { rows: new Map<string, any>(), versions: [] as any[], roles: new Map<string, string | null>(), personal: false },
  userService: {
    roleFor: vi.fn(async (_userId: string, projectId: string) => store.roles.get(projectId) ?? null),
    isPersonalProject: vi.fn(async () => store.personal),
  },
}));
vi.mock('../users/service.js', () => ({ userService }));
vi.mock('./projectPages.js', () => ({ projectPageRepository: { findBySlug: async (_p: string, slug: string) => (slug === 'reporting' ? { id: 'pg', slug } : null) } }));
vi.mock('../agents/repository.js', () => ({ agentRepository: { findById: async (id: string) => (id === A ? { id: A, projectId: P } : null) } }));
vi.mock('../sharedPages/service.js', () => ({ sharedPageService: { getFor: async () => null, canManage: () => false } }));
vi.mock('./repository.js', () => ({
  cockpitRepository: {
    find: async (scope: { key: string; kind: string; cell?: boolean }, userId: string) => store.rows.get(scope.kind === 'home' && !scope.cell ? `${scope.key}|${userId}` : scope.key) ?? null,
    save: async (input: any) => {
      const k = input.scope.kind === 'home' && !input.scope.cell ? `${input.scope.key}|${input.userId}` : input.scope.key;
      const prev = store.rows.get(k);
      const row = { id: k, scope: input.scope.key, user_id: null, project_id: input.scope.projectId, layout: input.layout, version: (prev?.version ?? 0) + 1, updated_by: input.authorId, updated_at: new Date() };
      store.rows.set(k, row);
      store.versions.push({ layoutId: k, version: row.version, layout: input.snapshot, reset: input.layout === null, authorId: input.authorId, sessionId: input.sessionId, note: input.note, createdAt: new Date() });
      return row;
    },
    history: async (id: string) => store.versions.filter((v) => v.layoutId === id).reverse(),
    version: async (id: string, n: number) => store.versions.find((v) => v.layoutId === id && v.version === n) ?? null,
  },
}));

const { cockpitService, sanitizeLayout } = await import('./service.js');
const alice = { id: 'alice', isSuperAdmin: false } as User;

beforeEach(() => {
  store.rows.clear();
  store.versions.length = 0;
  store.roles.clear();
  store.personal = false;
});

describe('cockpitService', () => {
  it('résout le défaut de l’accueil, puis l’agencement enregistré, propre à chaque personne', async () => {
    const d = await cockpitService.resolve(alice, 'home');
    expect(d).toMatchObject({ isDefault: true, version: 0, canEdit: true });
    const { result, before } = await cockpitService.update(alice, 'home', { ops: [{ op: 'remove', id: 'd-projects-table' }], note: 'moins de projets' });
    expect(before.blocks.some((b) => b.id === 'd-projects-table')).toBe(true);
    expect(result).toMatchObject({ isDefault: false, version: 1 });
    expect(result.layout.blocks.some((b) => b.id === 'd-projects-table')).toBe(false);
    const bob = await cockpitService.resolve({ id: 'bob' } as User, 'home');
    expect(bob.isDefault).toBe(true);
  });

  it('applique les droits du projet : lecteur lit sans modifier, non membre refusé', async () => {
    store.roles.set(P, 'viewer');
    const r = await cockpitService.resolve(alice, `project:${P}`);
    expect(r.canEdit).toBe(false);
    expect(r.layout.blocks.some((b) => b.kind === 'builtin' && b.widget === 'channel')).toBe(true);
    await expect(cockpitService.update(alice, `project:${P}`, { layout: r.layout })).rejects.toThrow(/rôle membre/);
    store.roles.delete(P);
    await expect(cockpitService.resolve(alice, `project:${P}`)).rejects.toThrow(/accès/);
  });

  it('l’espace personnel a son défaut sans canal', async () => {
    store.roles.set(P, 'admin');
    store.personal = true;
    const r = await cockpitService.resolve(alice, `project:${P}`);
    expect(r.layout.blocks.some((b) => b.kind === 'builtin' && b.widget === 'channel')).toBe(false);
  });

  it('réinitialise, garde l’historique et restaure', async () => {
    store.roles.set(P, 'member');
    const key = `project:${P}`;
    await cockpitService.update(alice, key, { ops: [{ op: 'remove', id: 'd-channel' }], sessionId: 's1' });
    const reset = await cockpitService.reset(alice, key);
    expect(reset).toMatchObject({ isDefault: true, version: 2 });
    expect(reset.layout.blocks.some((b) => b.id === 'd-channel')).toBe(true);
    const history = await cockpitService.history(alice, key);
    expect(history.map((v) => [v.version, v.reset, v.sessionId])).toEqual([[2, true, null], [1, false, 's1']]);
    const restored = await cockpitService.restore(alice, key, 1);
    expect(restored).toMatchObject({ isDefault: false, version: 3 });
    expect(restored.layout.blocks.some((b) => b.id === 'd-channel')).toBe(false);
    await expect(cockpitService.restore(alice, key, 9)).rejects.toThrow(/introuvable/);
    // Réinitialiser crée une version ; réinitialiser un agencement déjà par défaut n'en crée pas.
    await cockpitService.reset(alice, key);
    expect((await cockpitService.resolve(alice, key))).toMatchObject({ version: 4, isDefault: true });
    await cockpitService.reset(alice, key);
    expect((await cockpitService.resolve(alice, key)).version).toBe(4);
  });

  it('refuse un enregistrement sans layout ni ops, et une portée réservée', async () => {
    await expect(cockpitService.update(alice, 'home', {})).rejects.toThrow(/Rien à enregistrer/);
    store.roles.set(P, 'member');
    await expect(cockpitService.resolve(alice, `project:${P}:page:absente`)).rejects.toThrow(/introuvable/);
    const page = await cockpitService.resolve(alice, `project:${P}:page:reporting`);
    expect(page).toMatchObject({ isDefault: true, canEdit: true });
    expect(page.layout.blocks).toEqual([]);
  });

  it('la fiche d’un agent suit les droits de son projet ; le pilotage a son défaut', async () => {
    await expect(cockpitService.resolve(alice, `agent:${A}`)).rejects.toThrow(/accès/);
    store.roles.set(P, 'viewer');
    const r = await cockpitService.resolve(alice, `agent:${A}`);
    expect(r).toMatchObject({ canEdit: false, isDefault: true });
    expect(r.layout.blocks.some((b) => b.kind === 'builtin' && b.widget === 'agent.sessions')).toBe(true);
    await expect(cockpitService.resolve(alice, `agent:${P}`)).rejects.toThrow(/introuvable/);
    const t = await cockpitService.resolve(alice, `project:${P}:tasks`);
    expect(t.layout.blocks.some((b) => b.kind === 'builtin' && b.widget === 'pilot.watchlist')).toBe(true);
  });

  it('l’accueil par défaut de la cellule : réservé aux administrateurs, hérité par qui n’a rien réglé', async () => {
    await expect(cockpitService.update(alice, 'home:default', { ops: [{ op: 'remove', id: 'd-projects-table' }] })).rejects.toThrow(/administrateurs/);
    const admin = { id: 'root', isAdmin: true } as User;
    await cockpitService.update(admin, 'home:default', { ops: [{ op: 'remove', id: 'd-projects-table' }] });
    const bob = await cockpitService.resolve({ id: 'bob' } as User, 'home');
    expect(bob.isDefault).toBe(true);
    expect(bob.layout.blocks.some((b) => b.id === 'd-projects-table')).toBe(false);
    // Un réglage propre l'emporte ; la réinitialisation revient au défaut de la cellule.
    await cockpitService.update({ id: 'bob' } as User, 'home', { ops: [{ op: 'remove', id: 'd-usage-card' }] });
    expect((await cockpitService.resolve({ id: 'bob' } as User, 'home')).layout.blocks.some((b) => b.id === 'd-usage-card')).toBe(false);
    const back = await cockpitService.reset({ id: 'bob' } as User, 'home');
    expect(back.layout.blocks.some((b) => b.id === 'd-usage-card')).toBe(true);
    expect(back.layout.blocks.some((b) => b.id === 'd-projects-table')).toBe(false);
  });
});

describe('sanitizeLayout', () => {
  it('ignore un bloc devenu inconnu plutôt que de tout perdre', () => {
    const l = sanitizeLayout({ v: 1, blocks: [{ id: 'a', kind: 'builtin', widget: 'tile.tasks', region: 'tiles' }, { id: 'b', kind: 'builtin', widget: 'retired.widget', region: 'main' }, { id: 'c', kind: 'builtin', widget: 'text', region: 'main' }] }, 'home');
    expect(l.blocks.map((b) => b.id)).toEqual(['a', 'c']);
    expect(sanitizeLayout('garbage', 'home')).toEqual({ v: 1, blocks: [] });
  });
});
