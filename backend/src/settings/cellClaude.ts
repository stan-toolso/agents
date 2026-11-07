import { AppError } from '../errors.js';
import { tokenServiceLabel } from '../vault/tokens.js';
import { vaultService } from '../vault/service.js';
import type { TokenSettings } from '../vault/types.js';
import { settingsRepository } from './repository.js';
import { log } from '../log.js';

/**
 * Compte Claude de la cellule (« crédits Skipper ») : un jeton applicatif du coffre (abonnement Claude ou clé API
 * Anthropic) choisi par un administrateur, qui sert aux personnes et aux agents **sans identifiants Claude à eux**.
 * Une personne qui connecte son propre compte (abonnement ou clé API) l'utilise à la place : le compte de la cellule
 * n'est qu'un repli. L'élément reste dans le coffre de l'administrateur qui l'a choisi : Skipper le lit avec ses droits
 * à lui (comme un compte prêté à un agent), et journalise chaque usage au nom de la personne servie.
 *
 * Rangé dans `app_settings` (clé `claude.cell`) et relu à chaque usage : plusieurs instances (bleu/vert) restent
 * d'accord sans cache à invalider.
 */
const KEY = 'claude.cell';

export interface CellClaudeAccount {
  itemId: string;
  /** Administrateur qui l'a choisi : ses droits sur l'élément servent à le lire. */
  configuredById: string;
  configuredAt: string;
}

/** Vue du compte de la cellule (administrateurs) : l'élément et son service, ou rien. */
export interface CellClaudeAccountView {
  itemId: string;
  itemName: string | null;
  service: 'claude' | 'anthropic' | null;
  serviceLabel: string | null;
  configuredById: string;
  configuredAt: string;
  /** L'administrateur peut-il encore utiliser l'élément ? Sinon le repli ne sert plus. */
  usable: boolean;
}

export const cellClaude = {
  async get(): Promise<CellClaudeAccount | null> {
    return settingsRepository.get<CellClaudeAccount>(KEY).catch((err) => {
      log.error('[settings] lecture du compte Claude de la cellule', err);
      return null;
    });
  },

  /** L'élément et son service, si l'administrateur qui l'a choisi peut toujours l'utiliser. */
  async resolve(): Promise<{ account: CellClaudeAccount; service: 'claude' | 'anthropic'; name: string } | null> {
    const account = await this.get();
    if (!account) return null;
    const item = await vaultService.getFor(account.configuredById, account.itemId, 'use').catch(() => null);
    if (!item || item.kind !== 'token') return null;
    const service = (item.settings as TokenSettings).service;
    if (service !== 'claude' && service !== 'anthropic') return null;
    return { account, service, name: item.name };
  },

  async view(): Promise<CellClaudeAccountView | null> {
    const account = await this.get();
    if (!account) return null;
    const resolved = await this.resolve();
    return {
      itemId: account.itemId,
      itemName: resolved?.name ?? null,
      service: resolved?.service ?? null,
      serviceLabel: resolved ? tokenServiceLabel(resolved.service) : null,
      configuredById: account.configuredById,
      configuredAt: account.configuredAt,
      usable: Boolean(resolved),
    };
  },

  /** Choisit (ou retire, `null`) le compte de la cellule : un jeton `claude` ou `anthropic` que l'administrateur peut utiliser. */
  async set(adminId: string, itemId: string | null): Promise<void> {
    if (!itemId) {
      await settingsRepository.delete(KEY);
      return;
    }
    const item = await vaultService.assertTokenItem(adminId, itemId, ['claude', 'anthropic']);
    if (item.kind !== 'token') throw new AppError("Le compte de la cellule doit être un jeton d'abonnement Claude ou une clé API Anthropic");
    await settingsRepository.set<CellClaudeAccount>(KEY, { itemId, configuredById: adminId, configuredAt: new Date().toISOString() });
  },
};
