import { EventEmitter } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../db/pool.js', () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));
const holder = vi.fn();
vi.mock('../instances/registry.js', () => ({
  instanceRegistry: { id: 'self', isSelf: (id: string) => id === 'self', holder: (id: string) => holder(id), liveIds: async () => ['self', 'other'] },
}));
const callInstance = vi.fn();
vi.mock('../instances/client.js', () => ({ callInstance: (...args: unknown[]) => callInstance(...args) }));

const { chromeBridge, chromeBrowserService } = await import('./service.js');
const { crc32, zip } = await import('./zip.js');
const { extensionZip } = await import('./routes.js');

/** WebSocket factice : garde les messages envoyés. */
class FakeWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(JSON.parse(data));
    cb?.();
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
}

const session = { id: 's1', name: 'Session', url: null };

beforeEach(() => {
  query.mockReset();
  holder.mockReset();
  callInstance.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('chromeBridge', () => {
  it('envoie la commande au navigateur tenu par cette instance et renvoie sa réponse', async () => {
    const ws = new FakeWs();
    await chromeBridge.attach({ id: 'b1', userId: 'u1' }, ws as never, { version: '0.1.0' });
    query.mockResolvedValueOnce({ rows: [{ id: 'b1', instance_id: 'self' }] });
    const pending = chromeBridge.sendCommand('u1', { name: 'tabs', args: {}, session });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    const cmd = ws.sent[0];
    expect(cmd).toMatchObject({ type: 'command', name: 'tabs', session });
    chromeBridge.onResult('b1', { id: cmd.id, ok: true, result: { text: 'onglets', image: { data: 'x', mimeType: 'text/html' }, extra: 1 } });
    // Seuls les champs attendus reviennent ; une « image » d'un autre type est écartée.
    await expect(pending).resolves.toEqual({ text: 'onglets' });
    await chromeBridge.detach('b1', ws as never);
  });

  it("relaie l'erreur de l'extension", async () => {
    const ws = new FakeWs();
    await chromeBridge.attach({ id: 'b2', userId: 'u1' }, ws as never, {});
    const pending = chromeBridge.local('b2', { name: 'click', args: {}, session });
    chromeBridge.onResult('b2', { id: ws.sent[0].id, ok: false, error: 'Onglet non confié' });
    await expect(pending).rejects.toThrow('Onglet non confié');
    await chromeBridge.detach('b2', ws as never);
  });

  it('fait échouer les commandes en attente quand le navigateur se déconnecte', async () => {
    const ws = new FakeWs();
    await chromeBridge.attach({ id: 'b3', userId: 'u1' }, ws as never, {});
    const pending = chromeBridge.local('b3', { name: 'read_page', args: {}, session });
    await chromeBridge.detach('b3', ws as never);
    await expect(pending).rejects.toThrow(/déconnecté/);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('instance_id = NULL'), ['b3', 'self']);
  });

  it("passe par l'instance qui tient la connexion (bleu/vert)", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'b9', instance_id: 'other' }] });
    holder.mockResolvedValueOnce({ id: 'other', port: 4102, token: 't' });
    callInstance.mockResolvedValueOnce({ text: 'ok' });
    await expect(chromeBridge.sendCommand('u1', { name: 'tabs', args: {}, session })).resolves.toEqual({ text: 'ok' });
    expect(callInstance).toHaveBeenCalledWith(expect.objectContaining({ id: 'other' }), 'chrome.command', { browserId: 'b9', command: expect.objectContaining({ name: 'tabs' }) });
  });

  it('explique quand aucun navigateur n’est connecté', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'b8', instance_id: 'dead' }] });
    holder.mockResolvedValueOnce(null);
    await expect(chromeBridge.sendCommand('u1', { name: 'tabs', args: {}, session })).rejects.toThrow(/Aucun navigateur Chrome connecté/);
  });

  it('une nouvelle connexion du même navigateur remplace la précédente', async () => {
    const a = new FakeWs();
    const b = new FakeWs();
    await chromeBridge.attach({ id: 'b4', userId: 'u1' }, a as never, {});
    await chromeBridge.attach({ id: 'b4', userId: 'u1' }, b as never, {});
    expect(a.closed?.code).toBe(4000);
    // La fermeture de l'ancienne ne libère pas la nouvelle.
    await chromeBridge.detach('b4', a as never);
    expect(chromeBridge.size()).toBeGreaterThan(0);
    await chromeBridge.detach('b4', b as never);
  });
});

describe('chromeBrowserService', () => {
  it('crée un jeton skc_ dont seul le hachage est enregistré', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    query.mockImplementationOnce(async (_sql: string, params: unknown[]) => ({
      rows: [{ id: 'b1', user_id: 'u1', name: params[1], key_prefix: params[2], created_at: new Date(), last_used_at: null, instance_id: null, connected_at: null, user_agent: null, extension_version: null }],
    }));
    const { token, browser } = await chromeBrowserService.create('u1', '  Chrome du bureau ');
    expect(token).toMatch(/^skc_/);
    expect(browser).toMatchObject({ name: 'Chrome du bureau', prefix: token.slice(0, 12), connected: false });
    const insert = query.mock.calls[1][1] as string[];
    expect(insert).not.toContain(token);
    expect(insert[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuse un jeton sans le préfixe sans interroger la base', async () => {
    await expect(chromeBrowserService.resolveToken('skp_autre')).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('marque connecté un navigateur tenu par une instance vivante', async () => {
    const base = { user_id: 'u1', name: 'C', key_prefix: 'skc_x', created_at: new Date(), last_used_at: null, connected_at: new Date(), user_agent: null, extension_version: null };
    query.mockResolvedValueOnce({ rows: [{ ...base, id: 'a', instance_id: 'other' }, { ...base, id: 'b', instance_id: 'dead' }, { ...base, id: 'c', instance_id: null }] });
    const list = await chromeBrowserService.list('u1');
    expect(list.map((b) => b.connected)).toEqual([true, false, false]);
  });
});

describe('archive de l’extension', () => {
  it('crc32 standard', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('produit un zip lisible', () => {
    const data = Buffer.from('bonjour '.repeat(50));
    const archive = zip([{ name: 'a/b.txt', data }]);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = archive.readUInt16LE(26);
    const size = archive.readUInt32LE(18);
    expect(archive.subarray(30, 30 + nameLen).toString()).toBe('a/b.txt');
    expect(inflateRawSync(archive.subarray(30 + nameLen, 30 + nameLen + size)).equals(data)).toBe(true);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
  });

  it("contient le manifeste et l'adresse du serveur", async () => {
    const archive = await extensionZip('https://skipper.example');
    const text = archive.toString('latin1');
    expect(text).toContain('skipper-chrome/manifest.json');
    expect(text).toContain('skipper-chrome/background.js');
    expect(text).toContain('skipper-chrome/config.json');
    expect(text).not.toContain('skipper-chrome/README.md');
    expect(text).not.toContain('skipper-chrome/test/');
  });
});
