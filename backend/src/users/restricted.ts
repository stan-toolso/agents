import { userRepository } from './repository.js';
import type { User } from './types.js';

/**
 * Compte à accès restreint : une personne qui n'a que des accès d'invité. Soit invitée des pages partagées
 * (`isGuest`), soit invitée sur des projets avec le rôle `guest` sans être administratrice ni membre (lectrice ou
 * plus) d'aucun projet. Elle ne voit que les conversations de ces projets et les artefacts partagés avec elle, sans
 * espace personnel ni chat ; elle peut se connecter par un lien direct envoyé par e-mail (auth/signInService.ts).
 */
export async function isRestrictedAccount(user: Pick<User, 'id' | 'isAdmin' | 'isSuperAdmin' | 'isGuest' | 'kind'>): Promise<boolean> {
  if (user.kind !== 'person') return false;
  if (user.isGuest) return true;
  if (user.isAdmin || user.isSuperAdmin) return false;
  return !(await userRepository.hasFullMembership(user.id));
}
