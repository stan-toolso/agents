import { WebSocketServer, type WebSocket } from 'ws';
import type { UpgradeHandler } from '../websockets.js';
import { log } from '../log.js';
import { chromeBridge, chromeBrowserService } from './service.js';

export const CHROME_WS_PATH = '/api/chrome/connect';
/** Délai laissé à l'extension pour s'authentifier (premier message `hello`). */
const HELLO_TIMEOUT_MS = 10_000;
/** Battement du serveur : une connexion qui ne répond plus au ping est coupée. */
const PING_MS = 30_000;
/** Plus gros message accepté de l'extension (capture d'écran en base64 comprise). */
const MAX_PAYLOAD = 16 * 1024 * 1024;

/**
 * WebSocket `/api/chrome/connect` de l'extension « Skipper pour Chrome ».
 *
 * Authentifié par le jeton du navigateur (premier message), jamais par le cookie : l'origine est celle de l'extension
 * (`chrome-extension://…`), et ce gestionnaire passe donc avant le contrôle d'origine des WebSockets de l'application
 * (une page tierce n'a aucun jeton à présenter). Toute instance peut tenir la connexion (voir `service.ts`).
 */
export function chromeUpgradeHandler(): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  return (req, socket, head) => {
    if (!(req.url ?? '').match(/^\/api\/chrome\/connect(?:\?|$)/)) return false;
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws));
    return true;
  };
}

function handle(ws: WebSocket): void {
  let browser: { id: string; userId: string; name: string } | null = null;
  let alive = true;
  const helloTimer = setTimeout(() => ws.close(4401, 'Authentification attendue'), HELLO_TIMEOUT_MS);
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);
  ws.on('pong', () => (alive = true));

  ws.on('message', (raw, isBinary) => {
    alive = true;
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!browser) {
      if (msg.type !== 'hello' || typeof msg.token !== 'string') return void ws.close(4401, 'Authentification attendue');
      void (async () => {
        const found = await chromeBrowserService.resolveToken(msg.token as string);
        if (!found) return void ws.close(4401, 'Jeton inconnu ou révoqué : reconnectez l’extension à Skipper');
        if (ws.readyState !== ws.OPEN) return;
        clearTimeout(helloTimer);
        browser = found;
        await chromeBridge.attach(found, ws, { userAgent: typeof msg.userAgent === 'string' ? msg.userAgent : undefined, version: typeof msg.version === 'string' ? msg.version : undefined });
        ws.send(JSON.stringify({ type: 'ready', name: found.name }));
        log.info(`[chrome] navigateur ${found.id} (${found.name}) connecté`);
      })().catch((err) => {
        log.error('[chrome] authentification de l’extension', err);
        ws.close(1011, 'Erreur du serveur');
      });
      return;
    }
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    else if (msg.type === 'result') chromeBridge.onResult(browser.id, msg);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    clearInterval(ping);
    if (browser) {
      log.info(`[chrome] navigateur ${browser.id} déconnecté`);
      void chromeBridge.detach(browser.id, ws);
    }
  });
  ws.on('error', (err) => log.warn(`[chrome] WebSocket : ${err.message}`));
}
