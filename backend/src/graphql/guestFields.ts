import { Kind, parse, defaultFieldResolver, type GraphQLResolveInfo } from 'graphql';
import { isGuestOn, type AuthContext } from '../auth/access.js';
import { AppError } from '../errors.js';
import { typeDefs } from './schemaSource.js';

/**
 * Champs ouverts aux invités d'un projet (rôle `guest` : conversations et artefacts partagés seulement) sur les types
 * qu'ils atteignent : le projet (`project(id)`, `guestProjects`), les sessions d'agent citées par un message
 * (`Message.authorSession`, `respondingSessions`) et les agents (`Project.agents`, `User.agent`). Tout autre champ
 * de ces types leur est refusé, qu'il ait un résolveur ou qu'il lise la colonne (prompt système, dépôt, consommation,
 * transcript d'une session, instructions d'un agent…). C'est une liste blanche : un nouveau champ est fermé aux
 * invités tant qu'on ne l'ajoute pas ici ; le test guestFields.test.ts vérifie que chaque champ existe.
 */
export const GUEST_TYPE_FIELDS: Record<'Project' | 'Session' | 'Agent', ReadonlySet<string>> = {
  Project: new Set(['id', 'name', 'slug', 'description', 'isPersonal', 'isMember', 'myRole', 'conversations', 'unreadMessages', 'followedTaskThreads', 'members', 'agents', 'createdAt', 'updatedAt', '__typename']),
  Session: new Set(['id', 'name', 'kind', 'status', 'activity', 'owner', 'agent', 'archivedAt', 'createdAt', 'updatedAt', '__typename']),
  Agent: new Set(['id', 'user', 'name', 'project', 'kind', 'avatar', 'description', 'enabled', 'archivedAt', 'createdAt', 'updatedAt', '__typename']),
};

/** Tous les champs d'un type objet du schéma, définitions `extend type` comprises. */
export function schemaFieldsOf(typeName: string, source: string = typeDefs()): string[] {
  const out: string[] = [];
  for (const def of parse(source).definitions) {
    if ((def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) && def.name.value === typeName) for (const f of def.fields ?? []) out.push(f.name.value);
  }
  return out;
}

type Resolver = (parent: never, args: never, ctx: AuthContext, info: GraphQLResolveInfo) => unknown;

/**
 * Enveloppe les résolveurs d'un type : chaque champ hors de la liste blanche vérifie que la personne connectée n'est
 * pas qu'invitée sur le projet de l'objet (`projectIdOf`) avant de répondre, en posant un résolveur même aux champs
 * qui n'en avaient pas (lecture directe de la colonne).
 */
export function guardTypeForGuests<T extends Record<string, Resolver>>(typeName: keyof typeof GUEST_TYPE_FIELDS, projectIdOf: (parent: never) => string | null | undefined, resolvers: T): T {
  const allowed = GUEST_TYPE_FIELDS[typeName];
  const out: Record<string, Resolver> = { ...resolvers };
  for (const field of schemaFieldsOf(typeName)) {
    if (allowed.has(field)) continue;
    const own = resolvers[field] as Resolver | undefined;
    // Sans résolveur, la lecture de la propriété (comme graphql-js l'aurait faite), sous le nom du champ.
    const inner: Resolver = own ?? ((parent, args, ctx, info) => defaultFieldResolver(parent, args as never, ctx, info?.fieldName ? info : ({ ...info, fieldName: field } as GraphQLResolveInfo)));
    out[field] = async (parent, args, ctx, info) => {
      const projectId = projectIdOf(parent);
      if (projectId && (await isGuestOn(ctx, projectId))) throw new AppError(`Réservé aux membres du projet (${typeName}.${field}) : votre accès d'invité se limite aux conversations et aux artefacts partagés avec vous`, 'FORBIDDEN');
      return inner(parent, args, ctx, info);
    };
  }
  return out as T;
}
