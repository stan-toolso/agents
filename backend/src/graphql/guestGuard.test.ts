import { readFileSync } from 'node:fs';
import { buildSchema, parse } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';
import { GUEST_ROOT_FIELDS, guestForbiddenFields, guestGuardPlugin } from './security.js';

describe('champs refusés à un invité des pages partagées', () => {
  it('laisse passer les pages partagées et leurs commentaires', () => {
    expect(guestForbiddenFields(parse('query { me { id } sharedPages { id } sharedPage(id: "x") { id comments { id } } }'))).toEqual([]);
    expect(guestForbiddenFields(parse('mutation { addSharedPageComment(pageId: "x", body: "b") { id } }'))).toEqual([]);
  });

  it('refuse le reste, fragments du premier niveau compris', () => {
    expect(guestForbiddenFields(parse('query { me { id } projects { id } }'))).toEqual(['projects']);
    expect(guestForbiddenFields(parse('query { ...F ... on Query { sessions { id } } } fragment F on Query { personalSpace { id } }'))).toEqual(['personalSpace', 'sessions']);
    expect(guestForbiddenFields(parse('mutation { createProject(input: {}) { id } }'))).toEqual(['createProject']);
  });

  it("ne regarde que l'opération exécutée", () => {
    const doc = parse('query A { me { id } } query B { projects { id } }');
    expect(guestForbiddenFields(doc, 'A')).toEqual([]);
    expect(guestForbiddenFields(doc, 'B')).toEqual(['projects']);
  });

  it('ne permet que des champs qui existent dans le schéma', () => {
    const schema = buildSchema(readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8'));
    const roots = { query: schema.getQueryType(), mutation: schema.getMutationType(), subscription: schema.getSubscriptionType() };
    for (const [op, fields] of Object.entries(GUEST_ROOT_FIELDS)) {
      const type = roots[op as keyof typeof roots];
      for (const f of fields) if (f !== '__typename') expect(type?.getFields()[f], `${op}.${f}`).toBeDefined();
    }
  });
});

describe('garde des invités branchée sur yoga', () => {
  const yoga = createYoga<{ user: { isGuest: boolean } | null }>({
    schema: createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          me: String
          projects: [String!]!
        }
      `,
      resolvers: { Query: { me: () => 'moi', projects: () => ['p'] } },
    }),
    logging: false,
    plugins: [guestGuardPlugin()],
    context: ({ request }) => ({ user: request.headers.has('x-user') ? { isGuest: request.headers.get('x-user') === 'guest' } : null }),
  });
  const run = async (query: string, user: string) => (await yoga.fetch('http://test/graphql', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify({ query }) })).json();

  it('une personne ordinaire voit tout', async () => {
    expect(await run('{ projects }', 'person')).toEqual({ data: { projects: ['p'] } });
  });

  it("un invité n'a que la liste blanche", async () => {
    expect(await run('{ me }', 'guest')).toEqual({ data: { me: 'moi' } });
    const refused = await run('{ me projects }', 'guest');
    expect(refused.data).toBeUndefined();
    expect(refused.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(refused.errors[0].message).toContain('projects');
  });
});
