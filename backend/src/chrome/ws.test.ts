import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const attach = vi.fn(async () => {});
const detach = vi.fn(async () => {});
const onResult = vi.fn();
vi.mock('./service.js', () => ({
  chromeBrowserService: { resolveToken: async (t: string) => (t === 'skc_bon' ? { id: 'b1', userId: 'u1', name: 'Chrome' } : null) },
  chromeBridge: { attach: (...a: unknown[]) => attach(...(a as [])), detach: (...a: unknown[]) => detach(...(a as [])), onResult: (...a: unknown[]) => onResult(...a) },
}));

const { chromeUpgradeHandler } = await import('./ws.js');
const { attachWebSockets } = await import('../websockets.js');

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer();
  // Comme dans index.ts : avant le contrôle d'origine (l'extension a une origine chrome-extension://).
  attachWebSockets(server, [], [chromeUpgradeHandler()]);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/chrome/connect`;
});
afterAll(() => server.close());

function open(): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>>; closed: Promise<number> }> {
  const ws = new WebSocket(url, { origin: 'chrome-extension://abcdef' });
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const next = () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Record<string, unknown>>((r) => waiters.push(r)));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, next, closed }));
    ws.on('error', reject);
  });
}

describe('WebSocket de l’extension Chrome', () => {
  it('accepte un jeton valide, répond au ping et transmet les résultats', async () => {
    const { ws, next, closed } = await open();
    ws.send(JSON.stringify({ type: 'hello', token: 'skc_bon', version: '0.1.0', userAgent: 'UA' }));
    expect(await next()).toEqual({ type: 'ready', name: 'Chrome' });
    expect(attach).toHaveBeenCalledWith({ id: 'b1', userId: 'u1', name: 'Chrome' }, expect.anything(), { userAgent: 'UA', version: '0.1.0' });
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await next()).toEqual({ type: 'pong' });
    ws.send(JSON.stringify({ type: 'result', id: 'x', ok: true, result: { text: 'ok' } }));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith('b1', expect.objectContaining({ id: 'x' })));
    ws.close();
    await closed;
    await vi.waitFor(() => expect(detach).toHaveBeenCalledWith('b1', expect.anything()));
  });

  it('ferme la connexion avec 4401 pour un jeton inconnu', async () => {
    const { ws, closed } = await open();
    ws.send(JSON.stringify({ type: 'hello', token: 'skc_mauvais' }));
    expect(await closed).toBe(4401);
  });

  it('refuse tout autre message avant l’authentification', async () => {
    const { ws, closed } = await open();
    ws.send(JSON.stringify({ type: 'result', id: 'x', ok: true }));
    expect(await closed).toBe(4401);
  });
});
