import { isEnumType, isInputObjectType, isInterfaceType, isObjectType, printType, type GraphQLSchema } from 'graphql';
import { AppError } from '../errors.js';

/**
 * Description compacte du schéma GraphQL pour un agent qui écrit une source `graphql` : les champs de lecture de la
 * racine avec leurs arguments, ou la définition SDL d'un type (objets, interfaces, enums, entrées). Les mutations et
 * subscriptions n'y figurent pas (une source lit), ni les types d'introspection.
 */
export function describeSchema(schema: GraphQLSchema, typeName: string | null, limits: { maxDepth: number; maxFields: number }): string {
  if (typeName) {
    const t = schema.getType(typeName);
    if (!t || t.name.startsWith('__')) throw new AppError(`Type « ${typeName} » inconnu`);
    if (!(isObjectType(t) || isInterfaceType(t) || isEnumType(t) || isInputObjectType(t))) return `${t.name} : scalaire`;
    if (t === schema.getMutationType() || t === schema.getSubscriptionType()) throw new AppError('Une source ne lit que : pas de mutation ni de subscription');
    return printType(t);
  }
  const q = schema.getQueryType();
  if (!q) return 'Pas de type Query';
  const lines = Object.values(q.getFields())
    .filter((f) => !f.name.startsWith('__'))
    .map((f) => {
      const args = f.args.map((a) => `${a.name}: ${String(a.type)}`).join(', ');
      const desc = f.description ? ` — ${f.description.replace(/\s+/g, ' ').slice(0, 140)}` : '';
      return `- ${f.name}${args ? `(${args})` : ''}: ${String(f.type)}${desc}`;
    });
  return [`Champs de lecture (Query), bornes d'une source : ${limits.maxDepth} niveaux, ${limits.maxFields} champs. Détail d'un type : cockpit.schema { type: "Task" }.`, ...lines].join('\n');
}
