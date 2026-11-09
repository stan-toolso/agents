import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { callInstance } from '../instances/client.js';
import { instanceRegistry } from '../instances/registry.js';
import { log } from '../log.js';

/**
 * Extension « Skipper pour Chrome » : le navigateur d'une personne, piloté par ses sessions.
 *
 * La personne relie un navigateur depuis l'extension (page `/chrome/connect` de Skipper) : un jeton `skc_…` propre à ce
 * navigateur est créé (seul son hachage est gardé). L'extension ouvre avec lui un WebSocket (`/api/chrome/connect`) sur
 * l'instance active du backend ; la ligne `chrome_browsers` note alors l'instance qui tient la connexion. Une session
 * envoie une commande (`sendCommand`) au navigateur connecté le plus récemment de la personne qui la pilote : sur cette
 * instance directement, sinon par l'appel interne `chrome.command` à l'instance qui tient la connexion (bleu/vert).
 *
 * Protocole (JSON, texte) :
 * - extension → serveur : `{ type: 'hello', token, version, userAgent }` (premier message), `{ type: 'ping' }`,
 *   `{ type: 'result', id, ok, result?, error? }` ;
 * - serveur → extension : `{ type: 'ready', name }`, `{ type: 'pong' }`, `{ type: 'command', id, name, args, session }`.
 */

const PREFIX = 'skc_';
const MAX_BROWSERS = 10;
const LAST_USED_THROTTLE_MS = 60_000;
/** Délai d'une commande : sous celui des appels entre instances (30 s), pour que l'erreur soit la nôtre. */
export const COMMAND_TIMEOUT_MS = 25_000;

export interface ChromeBrowser {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  connected: boolean;
  connectedAt: Date | null;
  userAgent: string | null;
  extensionVersion: string | null;
}

/** Session au nom de laquelle une commande est envoyée : l'extension range ses onglets dans un groupe à son nom. */
export interface ChromeCommandSession {
  id: string;
  name: string;
  url: string | null;
}

export interface ChromeCommand {
  name: string;
  args: Record<string, unknown>;
  session: ChromeCommandSession;
}

/** Résultat d'une commande : texte, image éventuelle (capture). */
export interface ChromeCommandResult {
  text?: string;
  image?: { data: string; mimeType: string };
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  instance_id: string | null;
  connected_at: Date | null;
  user_agent: string | null;
  extension_version: string | null;
}

const COLUMNS = 'id, user_id, name, key_prefix, created_at, last_used_at, instance_id, connected_at, user_agent, extension_version';
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

const toBrowser = (r: Row, live: Set<string>): ChromeBrowser => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  prefix: r.key_prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  connected: Boolean(r.instance_id && live.has(r.instance_id)),
  connectedAt: r.instance_id ? r.connected_at : null,
  userAgent: r.user_agent,
  extensionVersion: r.extension_version,
});

interface Pending {
  resolve: (r: ChromeCommandResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  browserId: string;
  userId: string;
  ws: WebSocket;
  pending: Map<string, Pending>;
}

/** Connexions tenues par cette instance, par navigateur. */
const connections = new Map<string, Connection>();
const lastUsedWritten = new Map<string, number>();

export const chromeBrowserService = {
  async list(userId: string): Promise<ChromeBrowser[]> {
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM chrome_browsers WHERE user_id = $1 ORDER BY created_at`, [userId]);
    const live = rows.some((r) => r.instance_id) ? new Set(await instanceRegistry.liveIds()) : new Set<string>();
    return rows.map((r) => toBrowser(r, live));
  },

  /** La personne a relié au moins un navigateur (le serveur MCP `chrome` est alors proposé à ses sessions). */
  async hasAny(userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('SELECT 1 FROM chrome_browsers WHERE user_id = $1 LIMIT 1', [userId]);
    return (rowCount ?? 0) > 0;
  },

  /** Relie un navigateur ; le jeton complet n'est renvoyé que cette fois (l'extension le garde). */
  async create(userId: string, name: string): Promise<{ browser: ChromeBrowser; token: string }> {
    const label = name.trim().slice(0, 100) || 'Chrome';
    const { rows: count } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM chrome_browsers WHERE user_id = $1', [userId]);
    if ((count[0]?.n ?? 0) >= MAX_BROWSERS) throw new AppError(`Au plus ${MAX_BROWSERS} navigateurs reliés : retirez-en un dans Paramètres › Chrome`);
    const token = `${PREFIX}${randomBytes(30).toString('base64url')}`;
    const { rows } = await pool.query<Row>(
      `INSERT INTO chrome_browsers (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [userId, label, token.slice(0, PREFIX.length + 8), hash(token)],
    );
    return { browser: toBrowser(rows[0], new Set()), token };
  },

  /** Retire un navigateur : son jeton est révoqué et sa connexion fermée (sur l'instance qui la tient). */
  async delete(userId: string, id: string): Promise<boolean> {
    const { rows } = await pool.query<{ instance_id: string | null }>('DELETE FROM chrome_browsers WHERE id = $1 AND user_id = $2 RETURNING instance_id', [id, userId]);
    if (!rows[0]) throw new NotFoundError('Navigateur introuvable');
    const instanceId = rows[0].instance_id;
    if (instanceRegistry.isSelf(instanceId) || !instanceId) chromeBridge.disconnect(id);
    else {
      const holder = await instanceRegistry.holder(instanceId);
      if (holder) await callInstance(holder, 'chrome.disconnect', { browserId: id }).catch((err) => log.warn(`[chrome] fermeture de ${id} sur ${holder.id} : ${(err as Error).message}`));
    }
    return true;
  },

  /** Navigateur correspondant à un jeton, ou null. */
  async resolveToken(token: string): Promise<{ id: string; userId: string; name: string } | null> {
    if (!token.startsWith(PREFIX)) return null;
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM chrome_browsers WHERE key_hash = $1`, [hash(token)]);
    const r = rows[0];
    if (!r) return null;
    const now = Date.now();
    if (now - (lastUsedWritten.get(r.id) ?? 0) > LAST_USED_THROTTLE_MS) {
      lastUsedWritten.set(r.id, now);
      void pool.query('UPDATE chrome_browsers SET last_used_at = now() WHERE id = $1', [r.id]).catch(() => {});
    }
    return { id: r.id, userId: r.user_id, name: r.name };
  },
};

/** Connexions de l'extension tenues par cette instance, et envoi des commandes. */
export const chromeBridge = {
  /** Connexion authentifiée de l'extension : notée en base (instance qui la tient). */
  async attach(browser: { id: string; userId: string }, ws: WebSocket, info: { userAgent?: string; version?: string }): Promise<void> {
    const previous = connections.get(browser.id);
    if (previous && previous.ws !== ws) previous.ws.close(4000, 'Remplacée par une nouvelle connexion');
    connections.set(browser.id, { browserId: browser.id, userId: browser.userId, ws, pending: new Map() });
    await pool.query('UPDATE chrome_browsers SET instance_id = $2, connected_at = now(), user_agent = $3, extension_version = $4 WHERE id = $1', [
      browser.id,
      instanceRegistry.id,
      info.userAgent?.slice(0, 300) ?? null,
      info.version?.slice(0, 40) ?? null,
    ]);
  },

  /** Fin de la connexion : commandes en attente en échec, ligne libérée si c'est bien elle qui la tenait. */
  async detach(browserId: string, ws: WebSocket): Promise<void> {
    const conn = connections.get(browserId);
    if (!conn || conn.ws !== ws) return;
    connections.delete(browserId);
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AppError("Le navigateur s'est déconnecté pendant la commande"));
    }
    await pool.query('UPDATE chrome_browsers SET instance_id = NULL WHERE id = $1 AND instance_id = $2', [browserId, instanceRegistry.id]).catch(() => {});
  },

  /** Ferme la connexion d'un navigateur retiré. */
  disconnect(browserId: string): void {
    connections.get(browserId)?.ws.close(4401, 'Navigateur retiré de Skipper');
  },

  /** Instance en drainage : les extensions se reconnectent aussitôt à l'instance active. */
  closeAll(reason: string): void {
    for (const conn of connections.values()) conn.ws.close(1012, reason);
  },

  /** Réponse de l'extension à une commande. */
  onResult(browserId: string, msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): void {
    const conn = connections.get(browserId);
    const p = conn && typeof msg.id === 'string' ? conn.pending.get(msg.id) : undefined;
    if (!conn || !p) return;
    conn.pending.delete(msg.id as string);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(sanitizeResult(msg.result));
    else p.reject(new AppError(typeof msg.error === 'string' && msg.error ? msg.error.slice(0, 2000) : 'Commande refusée par le navigateur'));
  },

  /** Commande à un navigateur dont cette instance tient la connexion. */
  local(browserId: string, command: ChromeCommand): Promise<ChromeCommandResult> {
    const conn = connections.get(browserId);
    if (!conn) return Promise.reject(new AppError("Le navigateur n'est plus connecté à cette instance"));
    const id = randomUUID();
    return new Promise<ChromeCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new AppError(`Le navigateur n'a pas répondu à « ${command.name} » en ${COMMAND_TIMEOUT_MS / 1000} s`));
      }, COMMAND_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type: 'command', id, name: command.name, args: command.args, session: command.session }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new AppError(`Envoi au navigateur impossible : ${err.message}`));
      });
    });
  },

  /**
   * Envoie une commande au navigateur de la personne : le plus récemment connecté, sur cette instance ou sur celle qui
   * tient sa connexion.
   */
  async sendCommand(userId: string, command: ChromeCommand): Promise<ChromeCommandResult> {
    const { rows } = await pool.query<{ id: string; instance_id: string }>(
      'SELECT id, instance_id FROM chrome_browsers WHERE user_id = $1 AND instance_id IS NOT NULL ORDER BY connected_at DESC',
      [userId],
    );
    for (const r of rows) {
      if (connections.has(r.id)) return this.local(r.id, command);
      const holder = await instanceRegistry.holder(r.instance_id);
      if (holder) return callInstance<ChromeCommandResult>(holder, 'chrome.command', { browserId: r.id, command });
    }
    throw new AppError(
      "Aucun navigateur Chrome connecté : la personne doit ouvrir Chrome avec l'extension « Skipper pour Chrome » connectée (icône de l'extension). Demande-le-lui plutôt que de réessayer en boucle.",
    );
  },

  /** Nombre de connexions tenues ici (santé, tests). */
  size: () => connections.size,
};

/** Ne garde du résultat de l'extension que les champs attendus. */
function sanitizeResult(raw: unknown): ChromeCommandResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ChromeCommandResult = {};
  if (typeof r.text === 'string') out.text = r.text;
  const img = r.image as Record<string, unknown> | undefined;
  if (img && typeof img.data === 'string' && typeof img.mimeType === 'string' && /^image\/(png|jpeg|webp)$/.test(img.mimeType)) out.image = { data: img.data, mimeType: img.mimeType };
  return out;
}
