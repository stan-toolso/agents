import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedPage } from './types.js';

// Ouverture d'un artefact aux membres du projet depuis la publication (pages.publish project_access) :
// mêmes garde-fous que sharedPageService.update (artefact rattaché à un projet, propriétaire seulement).
const state = vi.hoisted(() => ({
  pages: new Map<string, Record<string, unknown>>(),
  created: [] as Record<string, unknown>[],
  versions: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock('./repository.js', () => ({
  sharedPageRepository: {
    findById: async (id: string) => state.pages.get(id) ?? null,
    isMember: async () => false,
    members: async () => [],
    snapshotLatest: async () => undefined,
    create: async (input: Record<string, unknown>) => {
      state.created.push(input);
      return { id: 'new', ownerId: input.ownerId, projectId: input.projectId, linkAccess: input.linkAccess, projectAccess: input.projectAccess ?? false, version: 1 };
    },
    addVersion: async (id: string, input: Record<string, unknown>) => {
      state.versions.push(input);
      const page = state.pages.get(id)!;
      return { ...page, version: (page.version as number) + 1, projectAccess: input.projectAccess ?? page.projectAccess };
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      state.updates.push(patch);
      return { ...state.pages.get(id), ...patch };
    },
  },
}));
vi.mock('./dataRepository.js', () => ({ dataSourceRepository: { list: async () => [] } }));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async () => ({ id: 'x', isGuest: false }) } }));
vi.mock('../users/service.js', () => ({ userService: { memberRoleFor: async () => 'member' } }));

const { sharedPageService } = await import('./service.js');

const html = Buffer.from('<html><body>ok</body></html>');
const page = (extra: Partial<SharedPage> = {}) => ({ id: 'p1', ownerId: 'stan', title: 'Tableau', projectId: 'proj', linkAccess: false, projectAccess: false, version: 1, kind: 'page', ...extra });

beforeEach(() => {
  state.pages.clear();
  state.created = [];
  state.versions = [];
  state.updates = [];
});

describe('publish : project_access', () => {
  it('ouvre un nouvel artefact aux membres du projet ; privé par défaut', async () => {
    const opened = await sharedPageService.publish({ ownerId: 'stan', title: 'T', html, projectId: 'proj', projectAccess: true });
    expect(state.created[0]).toMatchObject({ projectAccess: true, projectId: 'proj' });
    expect(opened.projectAccess).toBe(true);
    await sharedPageService.publish({ ownerId: 'stan', title: 'T', html, projectId: 'proj' });
    expect(state.created[1]).toMatchObject({ projectAccess: false });
  });

  it('refuse un artefact sans projet', async () => {
    await expect(sharedPageService.publish({ ownerId: 'stan', title: 'T', html, projectAccess: true })).rejects.toThrow(/aucun projet/);
    expect(state.created).toEqual([]);
  });

  it('nouvelle version : ouvre, referme, ou laisse inchangé (null)', async () => {
    state.pages.set('p1', page());
    await sharedPageService.publish({ ownerId: 'stan', title: 'T', html, pageId: 'p1', projectId: 'proj', projectAccess: true });
    await sharedPageService.publish({ ownerId: 'stan', title: 'T', html, pageId: 'p1', projectId: 'proj', projectAccess: false });
    await sharedPageService.publish({ ownerId: 'stan', title: 'T', html, pageId: 'p1', projectId: 'proj' });
    expect(state.versions.map((v) => v.projectAccess)).toEqual([true, false, null]);
  });

  it("nouvelle version : réservée au propriétaire, et refusée sur un artefact sans projet", async () => {
    state.pages.set('p1', page());
    await expect(sharedPageService.publish({ ownerId: 'alice', title: 'T', html, pageId: 'p1', projectId: 'proj', projectAccess: true })).rejects.toThrow(/propriétaire/);
    state.pages.set('p2', page({ id: 'p2', projectId: null }));
    await expect(sharedPageService.publish({ ownerId: 'stan', title: 'T', html, pageId: 'p2', projectAccess: true })).rejects.toThrow(/aucun projet/);
    expect(state.versions).toEqual([]);
  });
});

describe('update : project_access (chemin de pages.share)', () => {
  it('le propriétaire ouvre puis referme ; un autre ne peut pas', async () => {
    state.pages.set('p1', page());
    expect((await sharedPageService.update('stan', 'p1', { projectAccess: true })).projectAccess).toBe(true);
    expect((await sharedPageService.update('stan', 'p1', { projectAccess: false })).projectAccess).toBe(false);
    await expect(sharedPageService.update('alice', 'p1', { projectAccess: true })).rejects.toThrow();
  });

  it('un invité ne voit jamais un artefact ouvert aux membres du projet', async () => {
    const opened = page({ projectAccess: true }) as unknown as SharedPage;
    expect(await sharedPageService.canView(opened, 'alice', true)).toBe(false);
    expect(await sharedPageService.canView(opened, 'alice', false)).toBe(true);
  });
});
