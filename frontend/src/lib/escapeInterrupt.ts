/**
 * Échap pour interrompre l'agent sur la page d'une session, sans interruption involontaire.
 *
 * Le 03/11/2026, une session a été interrompue alors que la personne n'avait pas voulu l'arrêter : l'ancien
 * écouteur prenait n'importe quel Échap de la fenêtre, y compris celui qui ferme la recherche, un menu, les
 * notifications ou une fenêtre de confirmation. Désormais :
 * - le raccourci passe par le registre (lib/shortcuts.ts), où les raccourcis de contexte passent avant ;
 * - un Échap pressé pendant qu'un panneau, un menu ou une fenêtre est ouvert est ignoré (constaté dès la
 *   phase de capture, avant que ce panneau ne se ferme) ;
 * - il faut deux Échap rapprochés : le premier arme, le second interrompt.
 */

/** Panneaux et menus ouverts qui consomment Échap pour se fermer. */
export const OVERLAY_SELECTOR = [
  '.modal', // fenêtres react-bootstrap (dialogues, recherche ⌘K, aide des raccourcis)
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.wb-pop', // PopMenu, choix des colonnes
  '.wb-notif-panel',
  '.dropdown-menu.show',
].join(', ');

export function overlayOpen(root: Pick<ParentNode, 'querySelector'> = document): boolean {
  return root.querySelector(OVERLAY_SELECTOR) !== null;
}

/** Délai maximal entre les deux Échap. */
export const DOUBLE_ESCAPE_MS = 1500;

/** Un Échap de plus : interrompt s'il suit de près un premier Échap, sinon arme. */
export function nextEscape(armedAt: number | null, now: number, windowMs = DOUBLE_ESCAPE_MS): { fire: boolean; armedAt: number | null } {
  if (armedAt !== null && now - armedAt >= 0 && now - armedAt <= windowMs) return { fire: true, armedAt: null };
  return { fire: false, armedAt: now };
}
