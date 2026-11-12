import { describe, expect, it, vi } from 'vitest';

vi.mock('../users/service.js', () => ({
  userService: {
    memberRoleFor: vi.fn(async (userId: string, projectId: string) => (projectId === 'guest-project' ? 'guest' : 'member')),
    isPersonalProject: vi.fn(async () => false),
  },
}));

const { GUEST_TYPE_FIELDS, guardTypeForGuests, schemaFieldsOf } = await import('./guestFields.js');
const { createAuthContext } = await import('../auth/access.js');

const user = { id: 'u1', email: 'u@x', name: 'U', kind: 'person', avatarUrl: null, googleSub: null, isAdmin: false, isSuperAdmin: false, isCto: false, isGuest: false, createdAt: new Date(), lastLoginAt: null, passwordSetAt: null } as const;
const info = {} as never;

describe('champs ouverts aux invités de projet', () => {
  it('ne liste que des champs qui existent dans le schéma', () => {
    for (const [type, fields] of Object.entries(GUEST_TYPE_FIELDS)) {
      const known = new Set(schemaFieldsOf(type));
      expect(known.size).toBeGreaterThan(0);
      for (const f of fields) if (f !== '__typename') expect(known.has(f), `${type}.${f}`).toBe(true);
    }
  });

  it('refuse les autres champs à un invité, résolveur ou colonne, et les laisse aux membres', async () => {
    const guarded = guardTypeForGuests('Project', (p: { id: string }) => p.id, { monthUsd: async () => 42 } as never) as Record<string, (p: unknown, a: unknown, c: unknown, i: unknown) => Promise<unknown>>;
    const guest = createAuthContext({ ...user });
    const guestProject = { id: 'guest-project', systemPrompt: 'secret', name: 'P' };
    await expect(guarded.monthUsd(guestProject, {}, guest, info)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(guarded.systemPrompt(guestProject, {}, guest, info)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Les champs de la liste blanche gardent leur résolveur (ou leur absence de résolveur).
    expect(guarded.name).toBeUndefined();
    const member = createAuthContext({ ...user });
    const memberProject = { id: 'member-project', systemPrompt: 'visible', name: 'P' };
    await expect(guarded.monthUsd(memberProject, {}, member, info)).resolves.toBe(42);
    await expect(guarded.systemPrompt(memberProject, {}, member, info)).resolves.toBe('visible');
  });

  it("laisse passer un objet sans projet (rien à vérifier)", async () => {
    const guarded = guardTypeForGuests('Session', (s: { projectId: string | null }) => s.projectId, {} as never) as Record<string, (p: unknown, a: unknown, c: unknown, i: unknown) => Promise<unknown>>;
    await expect(guarded.prompt({ projectId: null, prompt: 'x' }, {}, createAuthContext({ ...user }), info)).resolves.toBe('x');
  });
});
