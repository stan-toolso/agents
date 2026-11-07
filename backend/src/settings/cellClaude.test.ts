import { beforeEach, describe, expect, it, vi } from 'vitest';

// Réglages des personnes et de l'application en mémoire ; coffre simulé (droits par personne, jetons).
const userStore = new Map<string, unknown>();
const appStore = new Map<string, unknown>();
const vaultItems = new Map<string, { id: string; name: string; kind: string; settings: { service: string }; token: string; usableBy: string[] }>();
const useToken = vi.fn();

vi.mock('./userStore.js', () => ({
  userSettingsStore: {
    get: async (userId: string, key: string) => userStore.get(`${userId}:${key}`) ?? null,
    set: async (userId: string, key: string, value: unknown) => void userStore.set(`${userId}:${key}`, value),
    delete: async (userId: string, key: string) => void userStore.delete(`${userId}:${key}`),
  },
}));
vi.mock('./repository.js', () => ({
  settingsRepository: {
    get: async (key: string) => appStore.get(key) ?? null,
    set: async (key: string, value: unknown) => void appStore.set(key, value),
    delete: async (key: string) => void appStore.delete(key),
  },
}));
vi.mock('../vault/service.js', () => {
  const getFor = async (userId: string, itemId: string) => {
    const item = vaultItems.get(itemId);
    if (!item || !item.usableBy.includes(userId)) throw Object.assign(new Error('introuvable'), { code: 'FORBIDDEN' });
    return item;
  };
  return {
    vaultService: {
      getFor,
      assertTokenItem: async (userId: string, itemId: string, services: string[]) => {
        const item = await getFor(userId, itemId);
        if (!services.includes(item.settings.service)) throw new Error('mauvais service');
        return item;
      },
      useToken: async (userId: string, itemId: string, services: string[], actor: unknown) => {
        useToken(userId, itemId, services, actor);
        const item = await getFor(userId, itemId);
        return { item, secrets: { token: item.token } };
      },
    },
  };
});

const { claudeSettings } = await import('./claude.js');
const { cellClaude } = await import('./cellClaude.js');
const { onboardingService } = await import('./onboarding.js');

const ADMIN = 'admin-1';
const ALICE = 'alice-1';

beforeEach(() => {
  userStore.clear();
  appStore.clear();
  vaultItems.clear();
  useToken.mockClear();
  vaultItems.set('cell-key', { id: 'cell-key', name: 'claude-cellule', kind: 'token', settings: { service: 'anthropic' }, token: 'sk-ant-cellule', usableBy: [ADMIN] });
  vaultItems.set('alice-oauth', { id: 'alice-oauth', name: 'claude-abonnement', kind: 'token', settings: { service: 'claude' }, token: 'sk-ant-alice', usableBy: [ALICE] });
});

describe('compte Claude de la cellule (crédits Skipper)', () => {
  it("sans compte de la cellule, une personne sans identifiants ne peut pas lancer de session", async () => {
    const s = await claudeSettings.forUser(ALICE);
    expect(s.hasCredentials()).toBe(false);
    expect(() => s.assertCredentials()).toThrow(/Aucun identifiant Claude/);
    expect((await s.authStatus()).cellAccountAvailable).toBe(false);
  });

  it("sert de repli à qui n'a pas d'identifiants, lu avec les droits de l'administrateur et journalisé au nom de la personne", async () => {
    await cellClaude.set(ADMIN, 'cell-key');
    const s = await claudeSettings.forUser(ALICE);
    expect(s.hasCredentials()).toBe(true);
    expect(s.usesCellAccount()).toBe(true);
    expect(await s.credentialEnv(undefined, { sessionId: 'sess-1' })).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-cellule' });
    expect(useToken).toHaveBeenCalledWith(ADMIN, 'cell-key', ['anthropic'], expect.objectContaining({ userId: ALICE, sessionId: 'sess-1' }));
    const status = await s.authStatus();
    expect(status).toMatchObject({ cellAccountAvailable: true, usesCellAccount: true });
  });

  it('le compte de la personne remplace les crédits Skipper', async () => {
    await cellClaude.set(ADMIN, 'cell-key');
    await (await claudeSettings.forUser(ALICE)).setOauthItem('alice-oauth');
    const s = await claudeSettings.forUser(ALICE);
    expect(s.usesCellAccount()).toBe(false);
    expect(await s.credentialEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-alice' });
    expect(useToken).toHaveBeenCalledWith(ALICE, 'alice-oauth', ['claude'], expect.anything());
  });

  it("n'accepte qu'un jeton Claude ou Anthropic que l'administrateur peut utiliser, et cesse de servir s'il le perd", async () => {
    await expect(cellClaude.set(ADMIN, 'alice-oauth')).rejects.toThrow();
    await cellClaude.set(ADMIN, 'cell-key');
    vaultItems.get('cell-key')!.usableBy = [];
    const s = await claudeSettings.forUser(ALICE);
    expect(s.hasCredentials()).toBe(false);
    expect((await cellClaude.view())?.usable).toBe(false);
    await cellClaude.set(ADMIN, null);
    expect(await cellClaude.view()).toBeNull();
  });
});

describe('assistant de premiers pas', () => {
  it('mémorise la fermeture et la fin, et garde la première date', async () => {
    expect(await onboardingService.get(ALICE)).toEqual({ dismissedAt: null, completedAt: null });
    const first = await onboardingService.update(ALICE, { dismissed: true });
    expect(first.dismissedAt).toBeTruthy();
    const again = await onboardingService.update(ALICE, { dismissed: true, completed: true });
    expect(again.dismissedAt).toBe(first.dismissedAt);
    expect(again.completedAt).toBeTruthy();
    expect((await onboardingService.update(ALICE, { dismissed: false })).dismissedAt).toBeNull();
  });
});
