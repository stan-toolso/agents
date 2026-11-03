/**
 * Erreur métier destinée à être renvoyée telle quelle au client GraphQL
 * (les autres erreurs sont masquées en "Unexpected error." par graphql-yoga).
 */
export class AppError extends Error {
  constructor(message: string, readonly code: string = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') {
    super(message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

/**
 * Erreur PostgreSQL d'un identifiant mal formé (`invalid input syntax for type uuid`, code 22P02) : un identifiant
 * qui n'est pas un UUID ne désigne rien. Le journal GraphQL la traite comme une `NotFoundError` (« introuvable »,
 * une ligne, sans trace) plutôt que comme une erreur inattendue.
 */
export function isInvalidUuidError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as Error & { code?: unknown }).code === '22P02' && /type uuid/.test(error.message);
}
