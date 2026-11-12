import type { GraphQLSchema } from 'graphql';
import { AppError } from '../errors.js';

/**
 * Le schéma exécutable de Skipper, déposé ici au démarrage (index.ts) pour les sources `graphql` vivantes et l'outil
 * `cockpit.schema`, sans que ces modules importent les résolveurs (qui importent les sessions, qui importent les
 * serveurs MCP… : un cycle, et node-pty dans les tests).
 */
let schema: GraphQLSchema | null = null;

export function setExecutableSchema(s: GraphQLSchema): void {
  schema = s;
}

export function getExecutableSchema(): GraphQLSchema {
  if (!schema) throw new AppError("Le schéma GraphQL n'est pas encore disponible");
  return schema;
}
