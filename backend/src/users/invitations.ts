import { SHARE_LOGIN_LINK_DAYS, signInService } from '../auth/signInService.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { mailService } from '../notifications/mail.js';
import type { Project } from '../projects/types.js';
import { projectGuestInviteEmail } from './invitationEmail.js';
import { isRestrictedAccount } from './restricted.js';
import type { User } from './types.js';

/** Le mot d'accueil d'une invitation : 2000 caractères au plus, vide → null. */
export function cleanInviteMessage(message: string | null | undefined): string | null {
  const m = (message ?? '').replace(/\u0000/g, '').trim();
  return m ? m.slice(0, 2000) : null;
}

/**
 * E-mail d'invitation d'un invité d'un projet (rôle `guest`), si l'envoi des e-mails est configuré : avec un lien de
 * connexion directe (30 jours, comme le partage d'une page) quand le compte est à accès restreint, sinon le lien des
 * conversations du projet. Un échec est seulement journalisé : l'invitation vaut sans l'e-mail.
 */
export async function sendProjectGuestInvitation(actor: User, project: Project, user: User, message: string | null): Promise<void> {
  try {
    if (!(await mailService.configured())) return;
    const path = `/projects/${project.id}/conversations`;
    const direct = await isRestrictedAccount(user);
    const url = direct ? await signInService.createLoginLink(user, path, { createdById: actor.id, ttlMs: SHARE_LOGIN_LINK_DAYS * 24 * 3600 * 1000 }) : `${config.appUrl}${path}`;
    await mailService.send({ to: user.email, ...projectGuestInviteEmail({ actor, project, to: user.email, message, url, directLoginDays: direct ? SHARE_LOGIN_LINK_DAYS : null }) });
  } catch (err) {
    log.warn(`[membres] e-mail d'invitation à ${user.email} : ${(err as Error).message}`);
  }
}
