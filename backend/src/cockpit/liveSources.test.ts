import { buildSchema } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../users/types.js';

// Petit schéma à la place de celui de Skipper : la résolution lit le contexte créé par createAuthContext (simulé).
const schema = buildSchema(`type Query { me: String, slow: String, fail: String, n(x: Int): Int }`);
const root = {
  me: (_: unknown, ctx: { user: { name: string } }) => ctx.user.name,
  slow: () => new Promise<string>((r) => setTimeout(() => r('late'), 50)),
  fail: () => {
    throw new Error('boum');
  },
  n: ({ x }: { x: number }) => x * 2,
};
vi.mock('../auth/access.js', () => ({ createAuthContext: (user: User) => ({ user, roles: new Map() }) }));
vi.mock('./schemaRegistry.js', () => ({ getExecutableSchema: () => schemaWithRoot }));
// graphql-js : les résolveurs racine se passent par rootValue ; on les attache au schéma pour execute().
const schemaWithRoot = schema;
for (const [name, fn] of Object.entries(root)) {
  const f = schema.getQueryType()!.getFields()[name];
  f.resolve = (src, args, ctx) => (fn as (a: unknown, c: unknown) => unknown)(args, ctx);
}

const { liveSources, runGraphql } = await import('./liveSources.js');
const alice = { id: 'u1', name: 'Alice' } as User;

beforeEach(() => liveSources.clear());

describe('runGraphql', () => {
  it('exécute avec le contexte de la personne', async () => {
    const r = await runGraphql('{ me n(x: 2) }', {}, alice, schema);
    expect(r).toMatchObject({ status: 'ok', data: { me: 'Alice', n: 4 }, error: null });
  });
  it('rend les erreurs de résolution sans casser', async () => {
    const r = await runGraphql('{ fail }', {}, alice, schema);
    expect(r.status).toBe('ok');
    expect(r.error).toContain('boum');
    expect(r.data).toEqual({ fail: null });
  });
  it('refuse une mutation ou une requête invalide', async () => {
    expect((await runGraphql('mutation { x }', {}, alice, schema)).status).toBe('error');
    expect((await runGraphql('{ nope }', {}, alice, schema)).error).toMatch(/nope/);
  });
});

describe('liveSources.run', () => {
  it('résout les variables modèles et met en cache par personne et variables', async () => {
    const source = { id: 's1', config: { query: 'query($x: Int) { n(x: $x) me }', variables: { x: '{{params.k}}' } } };
    const ctx = { project: null, viewer: { id: 'u1', name: 'Alice' }, params: { k: 3 } };
    const a = await liveSources.run(source, alice, ctx);
    expect(a.data).toEqual({ n: 6, me: 'Alice' });
    const again = liveSources.run(source, alice, ctx);
    expect(again).toBe(liveSources.run(source, alice, ctx));
    const other = await liveSources.run(source, alice, { ...ctx, params: { k: 5 } });
    expect(other.data).toEqual({ n: 10, me: 'Alice' });
    const bob = await liveSources.run(source, { id: 'u2', name: 'Bob' } as User, ctx);
    expect(bob.data).toEqual({ n: 6, me: 'Bob' });
  });
});
