import { userSettingsStore } from './userStore.js';

/**
 * Assistant de premiers pas d'une personne (frontend : components/onboarding/) : il l'invite à connecter son compte
 * Claude, ses comptes git (GitHub, GitLab) et ses premiers éléments du coffre. Seul son avancement est gardé ici
 * (`user_settings`, clé `onboarding`) ; l'état de chaque étape se lit dans les réglages eux-mêmes (compte Claude,
 * comptes git, coffre), si bien qu'une étape faite ailleurs apparaît faite dans l'assistant.
 */
const KEY = 'onboarding';

export interface OnboardingState {
  /** Fermé sans être terminé : il ne s'ouvre plus de lui-même. */
  dismissedAt: string | null;
  /** Mené jusqu'à la dernière étape. */
  completedAt: string | null;
}

const empty: OnboardingState = { dismissedAt: null, completedAt: null };

export const onboardingService = {
  async get(userId: string): Promise<OnboardingState> {
    return { ...empty, ...((await userSettingsStore.get<Partial<OnboardingState>>(userId, KEY)) ?? {}) };
  },

  async update(userId: string, patch: { dismissed?: boolean; completed?: boolean }): Promise<OnboardingState> {
    const current = await this.get(userId);
    const now = new Date().toISOString();
    const next: OnboardingState = { ...current };
    if (patch.dismissed !== undefined) next.dismissedAt = patch.dismissed ? current.dismissedAt ?? now : null;
    if (patch.completed !== undefined) next.completedAt = patch.completed ? current.completedAt ?? now : null;
    await userSettingsStore.set(userId, KEY, next);
    return next;
  },
};
