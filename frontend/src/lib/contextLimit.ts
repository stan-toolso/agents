import type { SessionCleanup } from '../graphql/operations';

/**
 * Limite de contexte d'une session : compacter (« compact ») ou repartir d'une conversation neuve en gardant un résumé
 * (« reset ») quand le contexte dépasse un seuil, appliquée à la fin d'un tour ; '' : aucune limite, la session propose
 * seulement (bandeau au-delà du seuil de signalement de la personne). Choisie au lancement, dans les réglages de la
 * session ou comme défaut du projet ; jamais appliquée sans ce choix.
 */
export type ContextLimitAction = '' | 'compact' | 'reset';
export interface ContextLimit {
  action: ContextLimitAction;
  /** Seuil, en milliers de tokens. */
  maxK: number;
}

/** Seuil recommandé (même valeur que RECOMMENDED_CONTEXT_MAX_TOKENS du backend). */
export const RECOMMENDED_CONTEXT_K = 100;
/** Seuil minimal accepté par le backend (MIN_CONTEXT_TOKENS). */
export const MIN_CONTEXT_K = 10;
export const NO_CONTEXT_LIMIT: ContextLimit = { action: '', maxK: RECOMMENDED_CONTEXT_K };

/** Limite décrite par des réglages de nettoyage (« fresh », réservé aux planifications, n'en est pas une). */
export function limitFromCleanup(cleanup: Pick<SessionCleanup, 'contextAction' | 'contextMaxTokens'> | null | undefined): ContextLimit {
  const action = cleanup?.contextAction;
  if ((action !== 'compact' && action !== 'reset') || !cleanup?.contextMaxTokens) return NO_CONTEXT_LIMIT;
  return { action, maxK: Math.round(cleanup.contextMaxTokens / 1000) };
}

/** Réglages envoyés au backend : objet vide pour « aucune limite ». */
export function cleanupFromLimit(limit: ContextLimit): { contextAction: 'compact' | 'reset'; contextMaxTokens: number } | Record<string, never> {
  return limit.action ? { contextAction: limit.action, contextMaxTokens: Math.round(limit.maxK) * 1000 } : {};
}

export const validLimit = (limit: ContextLimit) => !limit.action || (Number.isFinite(limit.maxK) && limit.maxK >= MIN_CONTEXT_K);

export const sameLimit = (a: ContextLimit, b: ContextLimit) => a.action === b.action && (!a.action || a.maxK === b.maxK);

/** Libellé court (ligne récapitulative du lancement, défaut du projet). */
export function limitLabel(limit: ContextLimit, warnK?: number | null): string {
  if (limit.action === 'compact') return `compacter au-delà de ${limit.maxK} k`;
  if (limit.action === 'reset') return `conversation neuve au-delà de ${limit.maxK} k`;
  return warnK ? `me proposer au-delà de ${warnK} k` : 'me proposer de nettoyer';
}

/** Dernière limite choisie dans le formulaire de lancement, par projet (prioritaire sur le défaut du projet). */
const storageKey = (projectId: string) => `skipper.launcher.contextLimit.${projectId}`;

export function lastContextLimit(projectId: string): ContextLimit | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ContextLimit>;
    const action = parsed.action === 'compact' || parsed.action === 'reset' ? parsed.action : '';
    const limit = { action, maxK: Number(parsed.maxK) || RECOMMENDED_CONTEXT_K } as ContextLimit;
    return validLimit(limit) ? limit : null;
  } catch {
    return null;
  }
}

export function rememberContextLimit(projectId: string, limit: ContextLimit): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(limit));
  } catch {
    /* stockage indisponible (navigation privée) : rien à mémoriser */
  }
}
