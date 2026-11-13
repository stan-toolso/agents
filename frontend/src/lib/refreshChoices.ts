/** Intervalles proposés pour le rafraîchissement automatique d'un artefact de données (minutes) ; 0 = à la demande. */
export const REFRESH_CHOICES: [number, string][] = [
  [0, 'À la demande'],
  [5, 'Toutes les 5 minutes'],
  [15, 'Toutes les 15 minutes'],
  [60, 'Toutes les heures'],
  [360, 'Toutes les 6 heures'],
  [1440, 'Tous les jours'],
  [10080, 'Toutes les semaines'],
];

export function refreshLabel(minutes: number | null): string {
  if (!minutes) return 'à la demande';
  const known = REFRESH_CHOICES.find(([m]) => m === minutes);
  if (known) return known[1].toLowerCase();
  return minutes % 1440 === 0 ? `tous les ${minutes / 1440} jours` : minutes % 60 === 0 ? `toutes les ${minutes / 60} heures` : `toutes les ${minutes} minutes`;
}
