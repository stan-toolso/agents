import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './types.js';

// Base, réglages Claude et comptes des agents : simulés.
const repo = vi.hoisted(() => ({ findById: vi.fn(), update: vi.fn(), findLastEvent: vi.fn() }));
const db = vi.hoisted(() => ({ query: vi.fn() }));
const settings = vi.hoisted(() => ({ autoTitle: true, hasCredentials: true }));
vi.mock('./repository.js', () => ({ sessionRepository: repo }));
vi.mock('../db/pool.js', () => ({ pool: db }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn() } }));
const billing = vi.hoisted(() => ({ sessionBillable: vi.fn(async () => true) }));
vi.mock('../billing/billable.js', () => billing);
vi.mock('../agents/service.js', () => ({ agentService: { accountsForSession: vi.fn(async (s: Session) => ({ claudeUserId: s.ownerId })) } }));
vi.mock('../settings/claude.js', () => ({
  cliEnv: (c: Record<string, string>) => c,
  claudeSettings: {
    forUser: vi.fn(async () => ({
      settings: { autoTitle: settings.autoTitle },
      hasCredentials: () => settings.hasCredentials,
      usesCellAccount: () => false,
      credentialEnv: async () => ({ ANTHROPIC_API_KEY: 'k' }),
    })),
  },
}));

const { autoTitleService, cleanTitle, titlePrompt, withoutAutoTitle, autoTitleConfig, TITLE_MODEL } = await import('./autoTitle.js');

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    projectId: 'p1',
    ownerId: 'u1',
    takenOverById: null,
    name: "Est ce qu'on est d'accord qu'on a plus aucun agent qui tourn",
    prompt: "Est ce qu'on est d'accord qu'on a plus aucun agent qui tourne sur l'ancien serveur ?",
    config: { permissionMode: 'default', ...autoTitleConfig() },
    archivedAt: null,
    ...overrides,
  }) as Session;

const generator = vi.fn();

beforeEach(() => {
  for (const fn of [...Object.values(repo), db.query, generator]) fn.mockReset();
  settings.autoTitle = true;
  settings.hasCredentials = true;
  autoTitleService.generator = generator;
  repo.findLastEvent.mockResolvedValue({ payload: { result: 'Oui, plus aucun agent ne tourne sur l’EC2.' } });
  repo.update.mockImplementation(async (id: string, patch: Partial<Session>) => makeSession({ id, ...patch }));
  db.query.mockResolvedValue({ rows: [] });
});

describe('cleanTitle', () => {
  it('retire guillemets, préfixe, Markdown et point final', () => {
    expect(cleanTitle('« Agents restants sur l’ancien serveur ».')).toBe('Agents restants sur l’ancien serveur');
    expect(cleanTitle('Titre : **Sessions et worktrees**\n\nexplication')).toBe('Sessions et worktrees');
    expect(cleanTitle('"Migration vers skipper-1"')).toBe('Migration vers skipper-1');
  });
  it('rejette une réponse vide et tronque une réponse trop longue', () => {
    expect(cleanTitle('  \n ')).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle('mot '.repeat(40))!.length).toBeLessThanOrEqual(80);
  });
});

describe('titlePrompt', () => {
  it('contient la demande et la première réponse, tronquées', () => {
    const text = titlePrompt('x'.repeat(10_000), 'réponse');
    expect(text).toContain('<premiere_reponse>');
    expect(text.length).toBeLessThan(6000);
    expect(titlePrompt('demande', null)).not.toContain('<premiere_reponse>');
  });
});

describe('autoTitleService.afterTurn', () => {
  it('remplace le nom provisoire, retire le drapeau et compte le coût', async () => {
    repo.findById.mockResolvedValue(makeSession());
    generator.mockResolvedValue({ text: 'Agents restants sur l’ancien serveur', costUsd: 0.0012, models: { [TITLE_MODEL]: 0.0012 } });
    const publish = vi.fn(async () => undefined);
    await autoTitleService.afterTurn('s1', publish);
    expect(generator.mock.calls[0][1]).toContain('plus aucun agent');
    expect(repo.update).toHaveBeenCalledWith('s1', { config: { permissionMode: 'default' }, name: 'Agents restants sur l’ancien serveur' });
    expect(publish).toHaveBeenCalledOnce();
    const ledger = db.query.mock.calls.find((c) => String(c[0]).includes('usage_ledger'))!;
    expect(ledger[1]).toEqual(['s1', 'p1', 'u1', JSON.stringify({ [TITLE_MODEL]: 0.0012 }), '0.001200', true]);
  });

  it('inscrit le coût comme non compté quand la session ne consomme pas de crédits (propre compte Claude)', async () => {
    billing.sessionBillable.mockResolvedValueOnce(false);
    repo.findById.mockResolvedValue(makeSession());
    generator.mockResolvedValue({ text: 'Titre', costUsd: 0.001, models: {} });
    await autoTitleService.afterTurn('s1', vi.fn(async () => undefined));
    expect(billing.sessionBillable).toHaveBeenCalledWith('u1', false);
    const ledger = db.query.mock.calls.find((c) => String(c[0]).includes('usage_ledger'))!;
    expect(ledger[1].at(-1)).toBe(false);
  });

  it('ne fait rien sans le drapeau (tâche, planification, nom explicite)', async () => {
    repo.findById.mockResolvedValue(makeSession({ config: {} }));
    await autoTitleService.afterTurn('s1', vi.fn());
    expect(generator).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('réglage coupé : garde le nom, retire le drapeau', async () => {
    settings.autoTitle = false;
    repo.findById.mockResolvedValue(makeSession());
    await autoTitleService.afterTurn('s1', vi.fn());
    expect(generator).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('s1', { config: { permissionMode: 'default' } });
  });

  it('un renommage manuel pendant la génération l’emporte', async () => {
    repo.findById.mockResolvedValueOnce(makeSession()).mockResolvedValueOnce(makeSession({ name: 'Mon nom', config: {} }));
    generator.mockResolvedValue({ text: 'Titre généré', costUsd: 0, models: {} });
    await autoTitleService.afterTurn('s1', vi.fn());
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('un échec de génération garde le nom provisoire sans réessayer', async () => {
    repo.findById.mockResolvedValue(makeSession());
    generator.mockRejectedValue(new Error('réseau'));
    await autoTitleService.afterTurn('s1', vi.fn());
    expect(repo.update).toHaveBeenCalledWith('s1', { config: { permissionMode: 'default' } });
  });
});

describe('withoutAutoTitle', () => {
  it('retire seulement le drapeau', () => {
    expect(withoutAutoTitle({ autoTitle: true, model: 'sonnet' })).toEqual({ model: 'sonnet' });
  });
});
