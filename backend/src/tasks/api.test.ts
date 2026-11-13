import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticate = vi.fn();
vi.mock('../apiKeys/service.js', () => ({ apiKeyService: { authenticate: (s: string) => authenticate(s) } }));
const list = vi.fn();
const create = vi.fn();
vi.mock('./service.js', () => ({ taskService: { list: (...a: unknown[]) => list(...a), create: (...a: unknown[]) => create(...a) } }));
vi.mock('../settings/server.js', () => ({ serverSettings: { maintenance: false } }));

const { handleTasksApiRoute } = await import('./api.js');

const key = (scopes: string[]) => ({ id: 'k', projectId: 'p1', name: 'K', prefix: 'skp_', createdById: null, createdAt: new Date(), lastUsedAt: null, scopes, signed: false, triageAgentId: null });

async function call(method: string, body?: unknown) {
  const req = Readable.from([Buffer.from(body ? JSON.stringify(body) : '')]) as unknown as IncomingMessage;
  Object.assign(req, { url: '/api/v1/tasks', method, headers: { authorization: 'Bearer skp_x' } });
  const out = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead: (s: number) => ((out.status = s), res),
    end: (t?: string) => void (out.body = t ? JSON.parse(t) : {}),
  } as unknown as ServerResponse;
  await handleTasksApiRoute(req, res);
  return out;
}

beforeEach(() => {
  list.mockReset().mockResolvedValue([]);
  create.mockReset();
});

describe('/api/v1/tasks : portées', () => {
  it('lit avec tasks:read', async () => {
    authenticate.mockResolvedValue(key(['tasks:read']));
    expect((await call('GET')).status).toBe(200);
  });
  it('refuse la création sans tasks:write', async () => {
    authenticate.mockResolvedValue(key(['tasks:read']));
    const r = await call('POST', { title: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FORBIDDEN', requiredScope: 'tasks:write' });
    expect(create).not.toHaveBeenCalled();
  });
  it('refuse la lecture à une clé inbound seule', async () => {
    authenticate.mockResolvedValue(key(['inbound:task']));
    expect((await call('GET')).status).toBe(403);
  });
});
