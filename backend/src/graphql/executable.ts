import { createSchema } from 'graphql-yoga';
import type { GraphQLSchema } from 'graphql';
import { resolvers } from './resolvers.js';
import { typeDefs } from './schemaSource.js';

export { typeDefs } from './schemaSource.js';

/**
 * Le schéma exécutable de Skipper (schema.graphql + résolveurs), construit une fois : servi par yoga (index.ts) et
 * exécuté en interne pour les sources `graphql` des artefacts (cockpit/liveSources.ts), avec le même contexte
 * d'authentification que l'API, donc les mêmes droits.
 */
let schema: GraphQLSchema | null = null;

export function executableSchema(): GraphQLSchema {
  schema ??= createSchema({ typeDefs: typeDefs(), resolvers });
  return schema;
}
