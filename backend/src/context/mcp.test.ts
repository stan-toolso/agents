import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// Le CLI liste les outils au démarrage : un schéma zod refusé ferait disparaître tout le serveur. Le service est simulé :
// on vérifie la déclaration des outils et la résolution du paramètre `library` (projet, agent par nom ou identifiant, défaut).
const { service, trace } = vi.hoisted(() => ({ service: {} as Record<string, unknown>, trace: { fn: null as unknown as ReturnType<typeof import('vitest').vi.fn> } }));
vi.mock('./service.js', () => ({ contextService: service }));
vi.mock('../sessions/events.js', () => ({ traceSessionEvent: (...args: unknown[]) => trace.fn(...args) }));

const { createContextMcpServer } = await import('./mcp.js');

const project = { id: 'p1', name: 'Skipper' } as Project;
const libraries = [
  { id: 'a1', name: 'Léa' },
  { id: 'a2', name: 'Max' },
];

async function connect(opts?: Parameters<typeof createContextMcpServer>[2]) {
  const server = createContextMcpServer(project, 's1', opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) => (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

beforeEach(() => {
  service.tree = vi.fn(async (_p: string, agentId: string | null) => ({ folders: [], instructions: agentId ? [{ id: 'i', folderId: null, path: `memo-${agentId}`, description: '', version: 1 }] : [] }));
  service.writeInstructionAtPath = vi.fn(async (_p: string, path: string) => ({ instruction: { id: `i-${path}`, path, description: '', version: 1 }, created: true }));
  trace.fn = vi.fn(async () => undefined);
});

describe('serveur MCP context (bibliothèques)', () => {
  it('liste ses outils, dont libraries, et chaque outil accepte library', async () => {
    const client = await connect({ agentLibraries: libraries });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_folder', 'delete', 'history', 'libraries', 'move', 'read', 'search', 'tree', 'write']);
    const tree = tools.find((t) => t.name === 'tree')!;
    expect(Object.keys((tree.inputSchema as { properties: Record<string, unknown> }).properties)).toContain('library');
  });

  it('sans library : la bibliothèque du projet pour une session de personne, la sienne pour une session d’agent', async () => {
    const human = await connect({ agentLibraries: libraries });
    expect(textOf(await human.callTool({ name: 'tree', arguments: {} }))).toBe('(bibliothèque vide)');
    expect(service.tree).toHaveBeenLastCalledWith('p1', null);
    const agent = await connect({ agentLibraries: libraries, defaultAgentId: 'a1' });
    expect(textOf(await agent.callTool({ name: 'tree', arguments: {} }))).toContain('memo-a1');
    expect(service.tree).toHaveBeenLastCalledWith('p1', 'a1');
    expect(textOf(await agent.callTool({ name: 'libraries', arguments: {} }))).toContain('Léa (agent, identifiant a1) · par défaut (la tienne)');
  });

  it('library désigne « projet », un agent par son nom (sans casse ni accents) ou son identifiant ; inconnu : erreur', async () => {
    const client = await connect({ agentLibraries: libraries, defaultAgentId: 'a1' });
    await client.callTool({ name: 'tree', arguments: { library: 'projet' } });
    expect(service.tree).toHaveBeenLastCalledWith('p1', null);
    await client.callTool({ name: 'write', arguments: { library: 'max', path: 'notes/jour', content: 'x' } });
    expect(service.writeInstructionAtPath).toHaveBeenLastCalledWith('p1', 'notes/jour', expect.objectContaining({ content: 'x' }), { type: 'agent', sessionId: 's1' }, 'a2');
    await client.callTool({ name: 'tree', arguments: { library: 'a2' } });
    expect(service.tree).toHaveBeenLastCalledWith('p1', 'a2');
    const res = await client.callTool({ name: 'tree', arguments: { library: 'Zoé' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Bibliothèque « Zoé » inconnue');
  });

  it('write trace l’instruction dans le transcript (événement context), avec sa bibliothèque', async () => {
    const client = await connect({ agentLibraries: libraries, defaultAgentId: 'a1' });
    await client.callTool({ name: 'write', arguments: { path: 'notes/jour', content: 'x', change_note: 'premier jet' } });
    expect(trace.fn).toHaveBeenLastCalledWith('s1', 'context', expect.objectContaining({ action: 'created', projectId: 'p1', instructionId: 'i-notes/jour', path: 'notes/jour', version: 1, agentId: 'a1', library: 'Léa', changeNote: 'premier jet' }));
    await client.callTool({ name: 'write', arguments: { library: 'projet', path: 'conventions', content: 'y' } });
    expect(trace.fn).toHaveBeenLastCalledWith('s1', 'context', expect.objectContaining({ agentId: null, library: null }));
  });
});
