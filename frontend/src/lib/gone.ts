/** Forme minimale d'une erreur Apollo : les erreurs GraphQL avec leur code (`extensions.code`). */
interface ErrorWithCodes {
  graphQLErrors?: ReadonlyArray<{ extensions?: { code?: unknown } | null }>;
}

/**
 * L'erreur dit que l'élément demandé n'existe plus pour cette personne : supprimé (`NOT_FOUND`, identifiant mal
 * formé compris) ou devenu inaccessible (`FORBIDDEN`, projet supprimé ou accès retiré). Un onglet restauré qui
 * tombe dessus affiche « n'existe plus » et propose de se fermer, plutôt qu'une erreur.
 */
export function isGoneError(error: unknown): boolean {
  const errors = (error as ErrorWithCodes | null | undefined)?.graphQLErrors;
  return Boolean(errors?.some((e) => e.extensions?.code === 'NOT_FOUND' || e.extensions?.code === 'FORBIDDEN'));
}
