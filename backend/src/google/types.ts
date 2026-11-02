import type { GoogleAccess } from '../vault/types.js';

export type { GoogleAccess };
export { GOOGLE_ACCESSES } from '../vault/types.js';

/**
 * Compte Google tel que les outils des agents le voient : un élément `google` du coffre (personnel ou
 * d'un projet) avec ses accès Gmail et Drive. Le jeton de rafraîchissement reste dans le coffre.
 */
export interface GoogleAccount {
  /** Identifiant de l'élément du coffre. */
  id: string;
  name: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  googleSub: string;
  gmailAccess: GoogleAccess;
  driveAccess: GoogleAccess;
  scopes: string[];
  requireApproval: boolean;
}

/** Accès demandés au moment de relier le compte. */
export interface GoogleAccessRequest {
  gmail: GoogleAccess;
  drive: GoogleAccess;
}

/** Brouillons : création, modification, suppression (et envoi). */
export const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
/** Corbeille et libellés (pas de suppression définitive des messages). */
export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
/** Accès complet : toute opération Gmail. */
export const GMAIL_FULL = 'https://mail.google.com/';

/**
 * Ce que permettent les portées accordées au-delà de la lecture et de l'envoi : les comptes reliés avant
 * l'ajout des brouillons et de la corbeille n'ont que gmail.send et doivent être reconnectés pour en profiter.
 */
export function gmailCan(account: Pick<GoogleAccount, 'gmailAccess' | 'scopes'>, what: 'drafts' | 'trash'): boolean {
  if (account.gmailAccess !== 'write') return false;
  const has = (s: string) => account.scopes.includes(s);
  return has(GMAIL_FULL) || (what === 'drafts' ? has(GMAIL_COMPOSE) : has(GMAIL_MODIFY));
}
