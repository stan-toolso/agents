import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Le texte du schéma GraphQL (schema.graphql), lu une fois. */
let source: string | null = null;

export function typeDefs(): string {
  source ??= readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.graphql'), 'utf8');
  return source;
}
