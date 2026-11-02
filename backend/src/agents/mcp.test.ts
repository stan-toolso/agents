import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { Agent } from './types.js';

// Le CLI liste les outils de chaque serveur au démarrage : un schéma zod refusé ferait disparaître tout le serveur.
const { service, sessions } = vi.hoisted(() => ({ service: {} as Record<string, unknown>, sessions: {} as Record<string, unknown> }));
vi.mock('./service.js', () => ({ agentService: service }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: sessions }));

const { createAgentsMcpServer, AGENTS_FREE_TOOLS } = await import('./mcp.js');

const project = { id: 'p1', name: 'Skipper' } as Project;
const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', userId: 'a1', name: 'Léa', email: 'agent-a1@agents.skipper', projectId: 'p1', kind: 'product_manager', description: 'Cadre les demandes', enabled: true, archivedAt: null, triggers: {}, actions: [], defaults: {}, ...over }) as unknown as Agent;

async function connect() {
  const server = createAgentsMcpServer(project, 's1');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) => (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('serveur MCP agents', () => {
  beforeEach(() => {
    service.listByProject = vi.fn(async () => [agent(), agent({ id: 'a2', name: 'Max', kind: 'developer', description: '' })]);
    service.forUser = vi.fn(async (id: string | null) => (id === 'a1' ? agent() : null));
    service.resolve = vi.fn(async (_p: string, ref: string) => (ref === 'Max' || ref === 'a2' ? agent({ id: 'a2', name: 'Max', kind: 'developer' }) : agent()));
    service.summon = vi.fn(async () => ({ id: 'new', name: 'Max · Export CSV' }));
    sessions.findById = vi.fn(async () => ({ id: 's1', ownerId: 'a1', requestedById: 'u9' }));
  });

  it('liste ses outils (schémas acceptés) ; seul list est libre', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list', 'summon']);
    expect(AGENTS_FREE_TOOLS).toEqual(['mcp__agents__list']);
  });

  it('list décrit les agents du projet et marque la session appelante', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'list', arguments: {} }));
    expect(text).toContain('a1 · Léa · Product Manager · Cadre les demandes · toi');
    expect(text).toContain('a2 · Max · Developer');
  });

  it('summon convoque un autre agent avec la tâche et le demandeur de la session appelante', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'summon', arguments: { agent: 'Max', text: 'Développe la tâche', task_id: 't1' } }));
    expect(service.summon).toHaveBeenCalledWith('a2', expect.objectContaining({ taskId: 't1', text: 'Développe la tâche', requestedById: 'u9' }));
    expect(text).toContain('Max convoqué sur la tâche t1 : session new');
  });

  it('summon refuse de se convoquer soi-même', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'summon', arguments: { agent: 'Léa', text: 'bonjour' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("C'est toi");
    expect(service.summon).not.toHaveBeenCalled();
  });
});
