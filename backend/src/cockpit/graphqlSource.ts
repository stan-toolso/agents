import { Kind, parse, visit, type DocumentNode, type SelectionSetNode } from 'graphql';
import { AppError } from '../errors.js';

/**
 * Sources `graphql` des artefacts (pur, testé) : la définition est une requête GraphQL de **lecture** sur l'API de
 * Skipper, exécutée à la lecture de la page avec les droits de la personne qui regarde (cockpit/liveSources.ts). Ici :
 * les bornes de la requête (une seule opération `query`, pas d'introspection, profondeur et nombre de champs limités)
 * et les variables modèles (`{{project.id}}`, `{{viewer.id}}`, `{{params.x}}`, `{{now}}`, `{{now-7d}}`…).
 */
export const GRAPHQL_LIMITS = {
  queryChars: 8000,
  variablesChars: 4096,
  maxDepth: 8,
  maxFields: 80,
  /** Délai d'exécution d'une source. */
  timeoutMs: 10_000,
  /** Durée de vie du cache d'un résultat (par page, version, personne et variables). */
  cacheMs: 15_000,
} as const;

export interface GraphqlSourceConfig {
  query: string;
  variables: Record<string, unknown>;
}

const fail = (msg: string): never => {
  throw new AppError(msg, 'VALIDATION');
};

/** Analyse et borne une requête ; renvoie le document. Lève une AppError lisible. */
export function checkGraphqlQuery(query: string): DocumentNode {
  const q = (query ?? '').trim();
  if (!q) return fail('query (la requête GraphQL) est obligatoire');
  if (q.length > GRAPHQL_LIMITS.queryChars) return fail(`Requête trop longue (${GRAPHQL_LIMITS.queryChars} caractères au plus)`);
  let doc: DocumentNode;
  try {
    doc = parse(q, { noLocation: true });
  } catch (err) {
    return fail(`Requête GraphQL invalide : ${(err as Error).message}`);
  }
  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  if (ops.length !== 1) return fail('Une seule opération par source');
  const op = ops[0];
  if (op.kind === Kind.OPERATION_DEFINITION && op.operation !== 'query') return fail("Seule une opération `query` est admise (ni mutation ni subscription) : une source lit, elle n'écrit pas");
  let fields = 0;
  visit(doc, {
    Field(node) {
      fields += 1;
      if (node.name.value.startsWith('__')) return fail("L'introspection (`__schema`, `__type`…) n'est pas admise dans une source");
      return undefined;
    },
  });
  if (fields > GRAPHQL_LIMITS.maxFields) return fail(`Requête trop large (${GRAPHQL_LIMITS.maxFields} champs au plus)`);
  const depthOf = (set: SelectionSetNode | undefined, d: number): number => {
    if (!set) return d;
    let max = d;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) max = Math.max(max, depthOf(sel.selectionSet, d + 1));
      else if (sel.kind === Kind.INLINE_FRAGMENT) max = Math.max(max, depthOf(sel.selectionSet, d));
      else max = Math.max(max, d + 1); // fragment nommé : compté comme un niveau (son contenu est borné par maxFields)
    }
    return max;
  };
  const depth = Math.max(...doc.definitions.map((d) => ('selectionSet' in d ? depthOf(d.selectionSet, 0) : 0)));
  if (depth > GRAPHQL_LIMITS.maxDepth) return fail(`Requête trop profonde (${GRAPHQL_LIMITS.maxDepth} niveaux au plus)`);
  return doc;
}

/** Valide les variables déclarées (objet JSON borné). */
export function checkGraphqlVariables(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('variables doit être un objet');
  const text = JSON.stringify(raw);
  if (text.length > GRAPHQL_LIMITS.variablesChars) return fail(`variables trop volumineuses (${GRAPHQL_LIMITS.variablesChars} caractères au plus)`);
  return raw as Record<string, unknown>;
}

/** Ce que les variables modèles peuvent lire. */
export interface TemplateContext {
  project: { id: string; name: string } | null;
  viewer: { id: string; name: string };
  params: Record<string, unknown>;
  now?: Date;
}

const DURATION = /^now([+-])(\d{1,4})([mhdw])$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Résout une valeur modèle : `{{project.id}}`, `{{project.name}}`, `{{viewer.id}}`, `{{viewer.name}}`, `{{params.<clé>}}`,
 * `{{now}}`, `{{now-7d}}` / `{{now+2h}}` (m, h, d, w ; ISO 8601). Une chaîne qui n'est qu'un modèle garde le type de la
 * valeur (un paramètre numérique reste un nombre) ; un modèle inconnu reste tel quel.
 */
export function resolveTemplate(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    if (whole) {
      const v = lookup(whole[1], ctx);
      return v === undefined ? value : v;
    }
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key: string) => {
      const v = lookup(key, ctx);
      return v === undefined ? m : v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveTemplate(v, ctx)]));
  return value;
}

function lookup(key: string, ctx: TemplateContext): unknown {
  const now = ctx.now ?? new Date();
  if (key === 'now') return now.toISOString();
  const d = DURATION.exec(key);
  if (d) return new Date(now.getTime() + (d[1] === '-' ? -1 : 1) * Number(d[2]) * UNIT_MS[d[3]]).toISOString();
  const [head, ...rest] = key.split('.');
  const path = rest.join('.');
  if (head === 'project') return ctx.project ? (path === 'id' ? ctx.project.id : path === 'name' ? ctx.project.name : undefined) : null;
  if (head === 'viewer') return path === 'id' ? ctx.viewer.id : path === 'name' ? ctx.viewer.name : undefined;
  if (head === 'params') return path ? (ctx.params as Record<string, unknown>)[path] : undefined;
  return undefined;
}

export function resolveVariables(variables: Record<string, unknown>, ctx: TemplateContext): Record<string, unknown> {
  return resolveTemplate(variables, ctx) as Record<string, unknown>;
}
