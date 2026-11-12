import { execute, validate, type DocumentNode, type GraphQLSchema } from 'graphql';
import { createAuthContext } from '../auth/access.js';
import { getExecutableSchema } from './schemaRegistry.js';
import type { DataSource } from '../sharedPages/dataSources.js';
import type { User } from '../users/types.js';
import { checkGraphqlQuery, GRAPHQL_LIMITS, resolveVariables, type GraphqlSourceConfig, type TemplateContext } from './graphqlSource.js';

/**
 * Sources `graphql` **vivantes** : exécutées à la lecture de la page, avec les droits de la personne qui regarde (même
 * schéma, mêmes résolveurs et même contexte que l'API), jamais par le planificateur ni au nom du propriétaire. Chacun
 * voit donc ce qu'il a le droit de voir, et un agent ne peut rien exposer de plus que l'API. Résultat mis en cache
 * quelques secondes par (page, version, personne, variables résolues) pour absorber le sondage du cockpit.
 */
export interface LiveResult {
  data: unknown;
  status: 'ok' | 'error';
  error: string | null;
  durationMs: number;
}

const cache = new Map<string, { at: number; result: Promise<LiveResult> }>();

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Source trop lente (plus de ${ms / 1000} s)`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

/** Exécute une requête de lecture bornée pour une personne ; `schema` injectable pour les tests. */
export async function runGraphql(query: string | DocumentNode, variables: Record<string, unknown>, user: User, schema: GraphQLSchema = getExecutableSchema()): Promise<LiveResult> {
  const started = Date.now();
  try {
    const document = typeof query === 'string' ? checkGraphqlQuery(query) : query;
    const invalid = validate(schema, document);
    if (invalid.length) throw new Error(invalid.map((e) => e.message).join(' ; '));
    const result = await withTimeout(Promise.resolve(execute({ schema, document, variableValues: variables, contextValue: createAuthContext(user) })), GRAPHQL_LIMITS.timeoutMs);
    const errors = result.errors?.map((e) => e.message) ?? [];
    return { data: result.data ?? null, status: errors.length && !result.data ? 'error' : 'ok', error: errors.length ? errors.join(' ; ') : null, durationMs: Date.now() - started };
  } catch (err) {
    return { data: null, status: 'error', error: (err as Error).message, durationMs: Date.now() - started };
  }
}

export const liveSources = {
  /** Résultat d'une source graphql pour une personne, avec ses variables résolues ; mis en cache `GRAPHQL_LIMITS.cacheMs`. */
  run(source: Pick<DataSource, 'id' | 'config'>, user: User, ctx: TemplateContext, version: number | null = null): Promise<LiveResult> {
    const cfg = source.config as GraphqlSourceConfig;
    const variables = resolveVariables(cfg.variables ?? {}, ctx);
    const key = `${source.id}:${version ?? ''}:${user.id}:${JSON.stringify(variables)}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < GRAPHQL_LIMITS.cacheMs) return hit.result;
    const result = runGraphql(cfg.query, variables, user);
    cache.set(key, { at: now, result });
    if (cache.size > 2000) for (const [k, v] of cache) if (now - v.at >= GRAPHQL_LIMITS.cacheMs) cache.delete(k);
    return result;
  },
  clear: () => cache.clear(),
};
