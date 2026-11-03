import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { Conversation, Message } from './types.js';

// Le CLI liste les outils de chaque serveur au démarrage : un schéma zod refusé ferait disparaître tout le serveur.
const { service } = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));
vi.mock('./service.js', async () => {
  const actual = await vi.importActual<typeof import('./service.js')>('./service.js');
  return { ...actual, conversationService: service };
});
vi.mock('./attachments.js', async () => {
  const actual = await vi.importActual<typeof import('./attachments.js')>('./attachments.js');
  return { ...actual, messageImageBlocks: async (images: { id: string; mediaType: string }[]) => images.map((a) => ({ type: 'image', data: Buffer.from(a.id).toString('base64'), mimeType: a.mediaType })) };
});
vi.mock('../personal/scope.js', () => ({
  inScope: async (_p: Project, _s: unknown, projectId: string) => projectId === 'p1',
  targetProject: async (p: Project) => p,
  withProjectParam: (shape: Record<string, unknown>) => shape,
}));

const { createConversationsMcpServer, CONVERSATIONS_FREE_TOOLS, conversationsMcpPrompt } = await import('./mcp.js');

const project = { id: 'p1', name: 'Skipper' } as Project;
const general: Conversation = { id: 'c1', projectId: 'p1', kind: 'channel', taskId: null, slug: 'general', name: 'général', topic: 'Pilotage', createdById: null, lastMessageAt: new Date('2026-11-02T10:00:00Z'), createdAt: new Date(), updatedAt: new Date(), archivedAt: null };
const root: Message = { id: 'm1', conversationId: 'c1', parentId: null, authorType: 'human', authorUserId: 'u1', authorSessionId: null, authorName: 'Alice', body: 'On livre ce soir ?', mentions: [], createdAt: new Date('2026-11-02T10:00:00Z'), updatedAt: new Date() };

async function connect() {
  const server = createConversationsMcpServer(project, 's1', 'Ben · général');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) => (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('serveur MCP conversations', () => {
  beforeEach(() => {
    service.list = vi.fn(async () => [general]);
    service.countMessages = vi.fn(async () => 3);
    service.resolve = vi.fn(async (_p: string, ref: string) => {
      if (['general', '#general', 'général', 'c1'].includes(ref)) return general;
      throw new Error(`Canal « ${ref} » introuvable`);
    });
    service.messages = vi.fn(async () => [root]);
    service.thread = vi.fn(async () => [root]);
    service.reactions = vi.fn(async () => []);
    service.attachments = vi.fn(async () => []);
    service.post = vi.fn(async (id: string, body: string, _actor: unknown, opts: { parentId?: string | null }) => ({ ...root, id: 'm9', conversationId: id, body, parentId: opts.parentId ?? null, mentions: [{ kind: 'user', id: 'u2', label: 'Chris', text: '@Chris' }] }));
    service.getMessage = vi.fn(async () => root);
    service.get = vi.fn(async () => general);
    service.toggleReaction = vi.fn(async () => ({ reaction: { emoji: '👍' }, added: true }));
  });

  it('liste ses outils (schémas acceptés), tous libres', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list', 'post', 'react', 'read']);
    expect([...CONVERSATIONS_FREE_TOOLS].sort()).toEqual(['mcp__conversations__list', 'mcp__conversations__post', 'mcp__conversations__react', 'mcp__conversations__read']);
  });

  it('list décrit les canaux, read montre les messages avec leur identifiant', async () => {
    const client = await connect();
    expect(textOf(await client.callTool({ name: 'list', arguments: {} }))).toContain('#general (général) — Pilotage · 3 messages');
    const read = textOf(await client.callTool({ name: 'read', arguments: { channel: '#general' } }));
    expect(read).toContain('Alice, 2026-11-02 10:00 UTC (message m1)');
    expect(read).toContain('On livre ce soir ?');
  });

  it('read nomme les fichiers joints et montre les images en blocs image', async () => {
    const at = (id: string, name: string, mediaType: string, size = 1024) => ({ id, conversationId: 'c1', messageId: 'm1', name, mediaType, size, createdAt: new Date() });
    service.attachments = vi.fn(async () => [at('f1', 'capture.png', 'image/png'), at('f2', 'journal.txt', 'text/plain'), at('f3', 'enorme.png', 'image/png', 6 * 1024 * 1024)]);
    const client = await connect();
    const res = await client.callTool({ name: 'read', arguments: { channel: '#general' } });
    const content = res.content as { type: string; text?: string; data?: string }[];
    expect(content.filter((c) => c.type === 'image').map((c) => c.data)).toEqual([Buffer.from('f1').toString('base64')]);
    const t = content[0].text!;
    expect(t).toContain('- capture.png (image/png, 1 Ko) — montré ci-dessous');
    expect(t).toContain('- journal.txt (text/plain, 1 Ko)\n');
    expect(t).not.toContain('enorme.png (image/png, 6 Mo) — montré');
  });

  it('post écrit dans le canal résolu, dans le fil demandé, et nomme les mentions', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'post', arguments: { channel: 'général', body: 'Oui @Chris', reply_to: 'm1' } }));
    expect(text).toContain('Message posté dans #general (m9) dans le fil m1 ; mentionne Chris');
    expect(service.post).toHaveBeenCalledWith('c1', 'Oui @Chris', { type: 'agent', sessionId: 's1', name: 'Ben · général' }, { parentId: 'm1' });
    expect(textOf(await client.callTool({ name: 'post', arguments: { channel: 'inconnu', body: 'x' } }))).toContain('introuvable');
  });

  it('react pose une réaction sur un message du projet', async () => {
    const client = await connect();
    expect(textOf(await client.callTool({ name: 'react', arguments: { message_id: 'm1', emoji: '👍' } }))).toContain('Réaction 👍 posée sur le message m1');
  });

  it('le prompt nomme les canaux et explique les messages reçus', () => {
    const prompt = conversationsMcpPrompt([general]);
    expect(prompt).toContain('#general (Pilotage)');
    expect(prompt).toContain('[Message dans un canal]');
    expect(conversationsMcpPrompt([], { scoped: true })).toContain('`list` avec `project`');
  });
});
