import { describe, expect, it, vi } from 'vitest';

vi.mock('../runners/index.js', () => ({ runner: {} }));

const { encodeCwd, failedMcpServers, mcpFailureNotice, parseMcpLog } = await import('./mcpFailures.js');

describe('failedMcpServers', () => {
  it('relève les serveurs en échec et ceux connectés sans aucun outil', () => {
    const failures = failedMcpServers({
      mcp_servers: [
        { name: 'tasks', status: 'connected' },
        { name: 'vault', status: 'connected' },
        { name: 'google', status: 'failed' },
        { name: 'context', status: 'pending' },
        { name: 'playwright', status: 'failed' },
      ],
      tools: ['Bash', 'mcp__tasks__get', 'mcp__tasks__list'],
    });
    expect(failures.map((f) => [f.name, f.status])).toEqual([
      ['vault', 'connected'],
      ['google', 'failed'],
    ]);
  });

  it('ne signale rien quand tout est chargé', () => {
    expect(failedMcpServers({ mcp_servers: [{ name: 'vault', status: 'connected' }], tools: ['mcp__vault__list'] })).toEqual([]);
    expect(failedMcpServers({})).toEqual([]);
  });
});

describe('mcpFailureNotice', () => {
  it('nomme les outils et donne la cause', () => {
    const msg = mcpFailureNotice({ name: 'vault', status: 'failed', reason: "n'a pas démarré" }, 'Failed to fetch tools: boom');
    expect(msg).toMatch(/^Outils du coffre indisponibles : le serveur vault n'a pas démarré : Failed to fetch tools: boom\./);
    expect(mcpFailureNotice({ name: 'autre', status: 'failed', reason: "n'a pas démarré" }, null)).toMatch(/^Outils du serveur MCP autre indisponibles : le serveur autre n'a pas démarré\./);
  });
});

describe('parseMcpLog', () => {
  it('garde la dernière ligne « Failed to fetch tools »', () => {
    const log = [
      JSON.stringify({ debug: 'Connecting', timestamp: 't' }),
      JSON.stringify({ error: 'Failed to fetch tools: Cannot read properties of undefined (reading \'push\')', timestamp: 't' }),
      JSON.stringify({ error: 'Autre erreur', timestamp: 't' }),
      '{"error": "tronqu',
    ].join('\n');
    expect(parseMcpLog(log)).toBe("Failed to fetch tools: Cannot read properties of undefined (reading 'push')");
  });

  it('à défaut, la dernière erreur ; rien sans erreur', () => {
    expect(parseMcpLog(`${JSON.stringify({ error: 'Connection closed' })}\n`)).toBe('Connection closed');
    expect(parseMcpLog(JSON.stringify({ debug: 'ok' }))).toBeNull();
    expect(parseMcpLog('')).toBeNull();
  });

  it('tronque une cause trop longue', () => {
    expect(parseMcpLog(JSON.stringify({ error: 'x'.repeat(2000) }))!.length).toBe(501);
  });
});

describe('encodeCwd', () => {
  it('encode comme le CLI', () => {
    expect(encodeCwd('/home/skipper/a.b')).toBe('-home-skipper-a-b');
  });
});
