import { describe, expect, it } from 'vitest';
import { GRAPHQL_LIMITS, checkGraphqlQuery, checkGraphqlVariables, resolveTemplate, resolveVariables } from './graphqlSource.js';

describe('checkGraphqlQuery', () => {
  it('accepte une requête de lecture', () => {
    const doc = checkGraphqlQuery('query($p: ID!) { tasks(projectId: $p) { id title } }');
    expect(doc.definitions).toHaveLength(1);
  });
  it('refuse mutation, subscription, introspection, plusieurs opérations, trop profond, trop large, invalide, vide', () => {
    expect(() => checkGraphqlQuery('mutation { deleteTask(id: "x") }')).toThrow(/query/);
    expect(() => checkGraphqlQuery('subscription { notificationCreated { id } }')).toThrow(/query/);
    expect(() => checkGraphqlQuery('{ __schema { types { name } } }')).toThrow(/introspection/);
    expect(() => checkGraphqlQuery('{ a } query B { b }')).toThrow(/Une seule opération/);
    expect(() => checkGraphqlQuery('{ a { b { c { d { e { f { g { h { i { j } } } } } } } } } }')).toThrow(/profonde/);
    expect(() => checkGraphqlQuery(`{ ${Array.from({ length: GRAPHQL_LIMITS.maxFields + 1 }, (_, i) => `f${i}`).join(' ')} }`)).toThrow(/large/);
    expect(() => checkGraphqlQuery('{ a ')).toThrow(/invalide/);
    expect(() => checkGraphqlQuery('')).toThrow(/obligatoire/);
    expect(() => checkGraphqlQuery('x'.repeat(GRAPHQL_LIMITS.queryChars + 1))).toThrow(/longue/);
  });
});

describe('variables modèles', () => {
  const ctx = { project: { id: 'p1', name: 'Projet' }, viewer: { id: 'u1', name: 'Alice' }, params: { days: 7, tag: 'infra' }, now: new Date('2026-11-12T12:00:00Z') };
  it('résout les clés connues, garde le type d’une valeur entière, laisse l’inconnu', () => {
    expect(resolveVariables({ p: '{{project.id}}', who: '{{ viewer.name }}', n: '{{params.days}}', mixed: 'tag:{{params.tag}}', x: '{{nope}}', keep: 3 }, ctx)).toEqual({ p: 'p1', who: 'Alice', n: 7, mixed: 'tag:infra', x: '{{nope}}', keep: 3 });
  });
  it('calcule les dates relatives', () => {
    expect(resolveTemplate('{{now}}', ctx)).toBe('2026-11-12T12:00:00.000Z');
    expect(resolveTemplate('{{now-7d}}', ctx)).toBe('2026-11-05T12:00:00.000Z');
    expect(resolveTemplate('{{now+2h}}', ctx)).toBe('2026-11-12T14:00:00.000Z');
    expect(resolveTemplate('{{now-2w}}', ctx)).toBe('2026-10-29T12:00:00.000Z');
  });
  it('traverse tableaux et objets ; projet absent → null', () => {
    expect(resolveTemplate({ list: ['{{viewer.id}}', { deep: '{{project.id}}' }] }, { ...ctx, project: null })).toEqual({ list: ['u1', { deep: null }] });
  });
  it('borne les variables', () => {
    expect(checkGraphqlVariables(undefined)).toEqual({});
    expect(() => checkGraphqlVariables([1])).toThrow(/objet/);
    expect(() => checkGraphqlVariables({ big: 'x'.repeat(GRAPHQL_LIMITS.variablesChars) })).toThrow(/volumineuses/);
  });
});
