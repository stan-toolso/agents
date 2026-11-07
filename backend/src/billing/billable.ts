import { userRepository } from '../users/repository.js';
import { billingService } from './service.js';

/**
 * Un tour de session compte-t-il dans la consommation (`usage_ledger.billable`) ?
 *
 * Dans une cellule facturée en crédits, seuls comptent les tours servis par le compte Claude de la cellule
 * (« crédits Skipper ») ou par le compte d'un CTO Skipper (`users.is_cto`, dont le travail est facturé au client) :
 * une personne qui fait tourner ses sessions sur son propre abonnement ou sa clé API ne consomme pas de crédits, et
 * l'interface n'affiche rien pour ces tours (coût de session, transcript, relevés, budgets).
 * Sans facturation configurée (instance interne, coûts en USD), tout compte, comme avant.
 *
 * La décision est prise à l'inscription du tour : elle reflète le compte qui l'a réellement servi à ce moment-là.
 */
export function isBillable(facts: { creditMode: boolean; cellAccount: boolean; cto: boolean }): boolean {
  return !facts.creditMode || facts.cellAccount || facts.cto;
}

/** La cellule facture-t-elle en crédits (facturation configurée avec un taux) ? */
export async function creditMode(): Promise<boolean> {
  const s = await billingService.stored();
  return Boolean(s && s.creditsPerUsd > 0);
}

/**
 * Décision pour une session : `accountHolderId` = la personne (ou l'agent) dont les identifiants Claude servent la
 * session (`accountsForSession(...).claudeUserId`), `cellAccount` = ses identifiants sont ceux de la cellule.
 */
export async function sessionBillable(accountHolderId: string | null, cellAccount: boolean): Promise<boolean> {
  if (cellAccount) return true;
  if (!(await creditMode())) return true;
  const holder = accountHolderId ? await userRepository.findById(accountHolderId) : null;
  return isBillable({ creditMode: true, cellAccount, cto: Boolean(holder?.isCto) });
}
