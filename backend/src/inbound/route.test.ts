import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectApiKey } from '../tasks/types.js';
import type { InboundEvent } from './repository.js';

const authenticate = vi.fn();
const signingSecret = vi.fn();
vi.mock('../apiKeys/service.js', () => ({ apiKeyService: { authenticate: (s: string) => authenticate(s), signingSecret: (id: string) => signingSecret(id) } }));

/** Dépôt en mémoire. */
let events: InboundEvent[] = [];
let recent = 0;
let recentTriages = 0;
vi.mock('./repository.js', () => ({
  inboundRepository: {
    findByIdempotencyKey: async (projectId: string, key: string) => events.find((e) => e.projectId === projectId && e.idempotencyKey === key) ?? null,
    insert: async (e: Omit<InboundEvent, 'id' | 'status' | 'error' | 'createdAt' | 'taskId' | 'sessionId' | 'agentId'>) => {
      if (e.idempotencyKey && events.some((x) => x.projectId === e.projectId && x.idempotencyKey === e.idempotencyKey)) return null;
      const ev: InboundEvent = { ...e, id: `ev${events.length + 1}`, status: 'processing', error: null, createdAt: new Date(), taskId: null, sessionId: null, agentId: null };
      events.push(ev);
      return ev;
    },
    retry: async (id: string) => {
      const ev = events.find((e) => e.id === id && e.status === 'failed');
      if (!ev) return null;
      Object.assign(ev, { status: 'processing', error: null });
      return ev;
    },
    attachTask: async (id: string, taskId: string) => void Object.assign(events.find((e) => e.id === id)!, { taskId }),
    finish: async (id: string, p: Partial<InboundEvent>) => {
      const ev = events.find((e) => e.id === id)!;
      Object.assign(ev, { status: p.status, error: p.error ?? null, taskId: p.taskId ?? ev.taskId, sessionId: p.sessionId ?? ev.sessionId, agentId: p.agentId ?? ev.agentId });
      return ev;
    },
    countRecent: async (_k: string, _s: number, triageOnly?: boolean) => (triageOnly ? recentTriages : recent),
  },
}));

const createTask = vi.fn();
const getTask = vi.fn();
vi.mock('../tasks/service.js', () => ({ taskService: { create: (...a: unknown[]) => createTask(...a), get: (id: string) => getTask(id) } }));

const pm = { id: 'agent-pm', projectId: 'p1', name: 'Chris', kind: 'product_manager', enabled: true, archivedAt: null };
const dev = { id: 'agent-dev', projectId: 'p1', name: 'Ben', kind: 'developer', enabled: true, archivedAt: null };
const summon = vi.fn();
vi.mock('../agents/service.js', () => ({
  agentService: {
    get: async (id: string) => [pm, dev].find((a) => a.id === id) ?? Promise.reject(new Error('introuvable')),
    resolve: async (_p: string, ref: string) => {
      const a = [pm, dev].find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
      if (!a) {
        const { NotFoundError } = await import('../errors.js');
        throw new NotFoundError(`Aucun agent « ${ref} » dans ce projet`);
      }
      return a;
    },
    listByProject: async () => [pm, dev],
    summon: (...a: unknown[]) => summon(...a),
  },
}));
const record = vi.fn();
vi.mock('../audit/service.js', () => ({ auditService: { record: (...a: unknown[]) => record(...a) } }));
vi.mock('../settings/server.js', () => ({ serverSettings: { maintenance: false } }));

const { handleInboundRoute, RATE_PER_MINUTE } = await import('./route.js');
const { sign } = await import('./signature.js');

const baseKey: ProjectApiKey = { id: 'k1', projectId: 'p1', name: 'Curso', prefix: 'skp_abcd', createdById: null, createdAt: new Date(), lastUsedAt: null, scopes: ['inbound:task', 'inbound:triage'], signed: false, triageAgentId: null };

interface FakeRes {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

async function call(body: unknown, opts: { headers?: Record<string, string>; method?: string; path?: string; raw?: string } = {}): Promise<FakeRes & { handled: boolean }> {
  const raw = opts.raw ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
  Object.assign(req, { url: opts.path ?? '/api/v1/inbound', method: opts.method ?? 'POST', headers: { authorization: 'Bearer skp_secret', ...lower(opts.headers ?? {}) } });
  const out: FakeRes = { status: 0, headers: {}, body: {} };
  const res = {
    setHeader: (k: string, v: string) => void (out.headers[k.toLowerCase()] = v),
    writeHead: (status: number, h: Record<string, string> = {}) => {
      out.status = status;
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = String(v);
      return res;
    },
    end: (text?: string) => void (out.body = text ? JSON.parse(text) : {}),
  } as unknown as ServerResponse;
  const handled = await handleInboundRoute(req, res);
  return { ...out, handled };
}
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

beforeEach(() => {
  events = [];
  recent = 0;
  recentTriages = 0;
  authenticate.mockReset().mockResolvedValue(baseKey);
  signingSecret.mockReset().mockResolvedValue(null);
  createTask.mockReset().mockImplementation(async (projectId: string, input: { title: string }) => ({ id: 't1', projectId, title: input.title }));
  getTask.mockReset().mockImplementation(async (id: string) => ({ id, projectId: 'p1', title: 'Tâche' }));
  summon.mockReset().mockResolvedValue({ id: 's1' });
  record.mockReset();
});

describe('POST /api/v1/inbound', () => {
  it('ignore les autres routes', async () => {
    expect((await call({}, { path: '/api/v1/tasks' })).handled).toBe(false);
  });

  it('exige une clé valide', async () => {
    authenticate.mockResolvedValue(null);
    const r = await call({ task: { title: 'x' } });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuse les méthodes autres que POST', async () => {
    expect((await call(undefined, { method: 'GET' })).status).toBe(405);
  });

  it('crée une tâche avec le payload et les champs external_id / source', async () => {
    const r = await call({ externalId: 'evt-1', source: 'curso', task: { title: 'Bug paiement', priority: 'high', tags: ['curso'] }, payload: { order: 42 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'done', externalId: 'evt-1', task: { id: 't1' }, triage: null });
    const [projectId, input, actor] = createTask.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(input.description).toContain('"order": 42');
    expect(input.customFields).toEqual([{ key: 'external_id', value: 'evt-1' }, { key: 'source', value: 'curso' }]);
    expect(actor.name).toBe('Clé d\'API « Curso »');
    expect(summon).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', action: 'inbound.receive', targetType: 'inbound' }));
  });

  it('demande task, triage ou les deux', async () => {
    const r = await call({ payload: { a: 1 } });
    expect(r.status).toBe(400);
  });

  it('refuse un champ inconnu', async () => {
    const r = await call({ task: { title: 'x' }, oops: 1 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_USER_INPUT');
  });

  it('refuse hors portée', async () => {
    authenticate.mockResolvedValue({ ...baseKey, scopes: ['inbound:task'] });
    const r = await call({ triage: true, payload: {} });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FORBIDDEN', requiredScope: 'inbound:triage' });
    expect(events).toHaveLength(0);
  });

  it("refuse une clé limitée à l'API des tâches", async () => {
    authenticate.mockResolvedValue({ ...baseKey, scopes: ['tasks:read', 'tasks:write'] });
    expect((await call({ task: { title: 'x' } })).status).toBe(403);
  });

  it('convoque le Product Manager par défaut sur la tâche créée', async () => {
    const r = await call({ source: 'curso', task: { title: 'Incident' }, triage: true, payload: { level: 'error' } });
    expect(r.status).toBe(201);
    expect(r.body.triage).toMatchObject({ agentId: 'agent-pm', agent: 'Chris', sessionId: 's1' });
    const [agentId, opts] = summon.mock.calls[0];
    expect(agentId).toBe('agent-pm');
    expect(opts).toMatchObject({ taskId: 't1', autoArchive: true, requestedById: null });
    expect(opts.text).toContain('[Événement entrant]');
    expect(opts.text).toContain('"level": "error"');
  });

  it('convoque l’agent demandé, sans tâche', async () => {
    const r = await call({ triage: { agent: 'Ben', instructions: 'Regarde les logs.' }, payload: {} });
    expect(r.status).toBe(201);
    expect(summon.mock.calls[0][0]).toBe('agent-dev');
    expect(summon.mock.calls[0][1]).toMatchObject({ taskId: null });
    expect(summon.mock.calls[0][1].text).toContain('Regarde les logs.');
  });

  it("utilise l'agent de triage de la clé", async () => {
    authenticate.mockResolvedValue({ ...baseKey, triageAgentId: 'agent-dev' });
    await call({ triage: true });
    expect(summon.mock.calls[0][0]).toBe('agent-dev');
  });

  it('agent inconnu : 404 et aucune tâche créée', async () => {
    const r = await call({ task: { title: 'x' }, triage: { agent: 'Personne' } });
    expect(r.status).toBe(404);
    expect(createTask).not.toHaveBeenCalled();
    expect(events[0].status).toBe('failed');
  });

  describe('idempotence', () => {
    it('rejoue la même réponse sans recréer la tâche', async () => {
      const body = { externalId: 'evt-9', task: { title: 'x' }, triage: true };
      const first = await call(body);
      const second = await call(body);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(summon).toHaveBeenCalledTimes(1);
    });

    it("l'en-tête Idempotency-Key prime sur externalId", async () => {
      await call({ task: { title: 'x' } }, { headers: { 'Idempotency-Key': 'abc' } });
      expect(events[0].idempotencyKey).toBe('abc');
    });

    it('refuse une clé réutilisée pour un autre contenu', async () => {
      await call({ externalId: 'evt-1', task: { title: 'x' } });
      const r = await call({ externalId: 'evt-1', task: { title: 'y' } });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('répond « en cours » pendant le traitement', async () => {
      events.push({ id: 'ev0', projectId: 'p1', apiKeyId: 'k1', keyName: 'Curso', idempotencyKey: 'evt-1', requestHash: '', source: null, taskId: null, sessionId: null, agentId: null, triage: false, status: 'processing', error: null, createdAt: new Date() });
      const body = JSON.stringify({ externalId: 'evt-1', task: { title: 'x' } });
      events[0].requestHash = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
      const r = await call(undefined, { raw: body });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('IN_PROGRESS');
      expect(r.headers['retry-after']).toBe('5');
    });

    it('reprend un événement en échec sans recréer la tâche déjà créée', async () => {
      summon.mockRejectedValueOnce(new (await import('../errors.js')).AppError("L'agent Chris est en pause"));
      const body = { externalId: 'evt-2', task: { title: 'x' }, triage: true };
      const first = await call(body);
      expect(first.status).toBe(400);
      expect(events[0]).toMatchObject({ status: 'failed', taskId: 't1' });
      const second = await call(body);
      expect(second.status).toBe(201);
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(summon).toHaveBeenCalledTimes(2);
      expect(second.body).toMatchObject({ status: 'done', task: { id: 't1' }, triage: { sessionId: 's1' } });
    });
  });

  describe('limitation de débit', () => {
    it('429 au-delà du débit par minute', async () => {
      recent = RATE_PER_MINUTE;
      const r = await call({ task: { title: 'x' } });
      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('60');
      expect(createTask).not.toHaveBeenCalled();
    });

    it('429 au-delà des triages par heure, mais les tâches seules passent', async () => {
      recentTriages = 1000;
      expect((await call({ triage: true })).status).toBe(429);
      expect((await call({ task: { title: 'x' } })).status).toBe(201);
    });

    it('un rejeu passe même quand le débit est atteint', async () => {
      const body = { externalId: 'evt-3', task: { title: 'x' } };
      await call(body);
      recent = RATE_PER_MINUTE;
      expect((await call(body)).status).toBe(200);
    });
  });

  describe('signature HMAC', () => {
    const secret = 'whs_test';
    beforeEach(() => {
      authenticate.mockResolvedValue({ ...baseKey, signed: true });
      signingSecret.mockResolvedValue(secret);
    });

    it('exige la signature quand la clé en a une', async () => {
      const r = await call({ task: { title: 'x' } });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_SIGNATURE');
    });

    it('accepte une signature valide', async () => {
      const raw = JSON.stringify({ task: { title: 'x' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await call(undefined, { raw, headers: { 'X-Skipper-Timestamp': ts, 'X-Skipper-Signature': sign(secret, ts, raw) } });
      expect(r.status).toBe(201);
    });

    it('refuse une signature fausse ou un corps modifié', async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(secret, ts, JSON.stringify({ task: { title: 'x' } }));
      const r = await call({ task: { title: 'y' } }, { headers: { 'X-Skipper-Timestamp': ts, 'X-Skipper-Signature': sig } });
      expect(r.status).toBe(401);
    });

    it('refuse un horodatage trop ancien', async () => {
      const raw = JSON.stringify({ task: { title: 'x' } });
      const ts = String(Math.floor(Date.now() / 1000) - 3600);
      const r = await call(undefined, { raw, headers: { 'X-Skipper-Timestamp': ts, 'X-Skipper-Signature': sign(secret, ts, raw) } });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/fenêtre/);
    });
  });
});
