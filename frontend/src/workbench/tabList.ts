/** Ce qu'un calcul sur la liste des onglets lit d'un onglet (voir `Tab` dans TabsContext). */
interface TabLike {
  key: string;
  url: string;
  kind: string;
}

const pathOf = (url: string) => url.split('?')[0];

/** Onglets restants une fois retirés ceux dont la clé vérifie `match` ; un onglet de dossier dont seule la page affichée correspond revient sur sa clé. */
export function withoutTabs<T extends TabLike>(tabs: T[], match: (key: string) => boolean): T[] {
  return tabs.filter((t) => !match(t.key)).map((t) => (t.kind === 'workspace' && t.key !== pathOf(t.url) && match(pathOf(t.url)) ? { ...t, url: t.key } : t));
}
