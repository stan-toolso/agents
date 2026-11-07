import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { auditService } from '../audit/service.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { log } from '../log.js';
import { requestService } from '../requests/service.js';
import { loadMasterKey } from '../settings/crypto.js';
import { ctoTimeService } from '../billing/ctoTime.js';
import { userRepository } from '../users/repository.js';
import { userService } from '../users/service.js';
import { ROLE_RANK } from '../users/types.js';

/**
 * Boutons « Autoriser » et « Refuser » d'une notification push de demande d'autorisation. Le service worker n'a pas
 * toujours le cookie de session (iOS, application fermée) : la notification porte un jeton signé (HMAC dérivé de la
 * clé maîtresse) qui désigne la demande et la personne destinataire, valable le temps de vie de la notification.
 * POST /api/push/action { token, action: 'allow' | 'deny' } répond à la demande au nom de cette personne, après avoir
 * revérifié qu'elle est toujours membre du projet. Le contenu d'une notification Web Push est chiffré de bout en bout
 * jusqu'à l'appareil : le jeton ne circule pas en clair.
 */

const ROUTE = '/api/push/action';
export const ACTION_TOKEN_TTL_SECONDS = 86_400;

let hmacKey: Buffer | null = null;
const key = () => (hmacKey ??= createHmac('sha256', loadMasterKey()).update('skipper:push-action:v1').digest());

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signActionToken(requestId: string, userId: string, nowMs = Date.now()): string {
  const body = b64(JSON.stringify({ r: requestId, u: userId, e: Math.floor(nowMs / 1000) + ACTION_TOKEN_TTL_SECONDS }));
  return `${body}.${b64(createHmac('sha256', key()).update(body).digest())}`;
}

export function verifyActionToken(token: string, nowMs = Date.now()): { requestId: string; userId: string } | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { r, u, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { r?: unknown; u?: unknown; e?: unknown };
    if (typeof r !== 'string' || typeof u !== 'string' || typeof e !== 'number' || e * 1000 < nowMs) return null;
    return { requestId: r, userId: u };
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error('trop long');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const reply = (res: ServerResponse, status: number, message: string) =>
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: status === 200, message }));

/** Répond à une demande depuis une notification ; renvoie false hors route. */
export async function handlePushActionRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  if (url.pathname !== ROUTE) return false;
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return true;
  }
  let token: unknown;
  let action: unknown;
  try {
    ({ token, action } = JSON.parse(await readBody(req)) as { token?: unknown; action?: unknown });
  } catch {
    reply(res, 400, 'Requête invalide');
    return true;
  }
  if (typeof token !== 'string' || (action !== 'allow' && action !== 'deny')) {
    reply(res, 400, 'Requête invalide');
    return true;
  }
  const claims = verifyActionToken(token);
  if (!claims) {
    reply(res, 403, 'Lien expiré : ouvrez la demande dans Skipper');
    return true;
  }
  try {
    const { rows } = await pool.query<{ type: string; status: string; title: string; session_id: string; project_id: string }>(
      'SELECT r.type, r.status, r.title, r.session_id, s.project_id FROM requests r JOIN sessions s ON s.id = r.session_id WHERE r.id = $1',
      [claims.requestId],
    );
    const request = rows[0];
    if (!request || request.type !== 'permission') {
      reply(res, 404, 'Demande introuvable');
      return true;
    }
    const user = await userRepository.findById(claims.userId);
    const role = user ? await userService.memberRoleFor(user.id, request.project_id) : null;
    if (!user || !role || ROLE_RANK[role] < ROLE_RANK.member) {
      reply(res, 403, 'Vous ne pouvez plus répondre à cette demande');
      return true;
    }
    if (request.status !== 'pending') {
      reply(res, 409, 'Demande déjà réglée');
      return true;
    }
    await requestService.answer(claims.requestId, { decision: action }, user.id);
    void ctoTimeService.record(user, { action: 'pushAnswerRequest', targetType: 'request', targetId: claims.requestId });
    await auditService.record({
      projectId: request.project_id,
      actor: { userId: user.id, label: user.name || user.email },
      action: 'request.answer',
      targetType: 'request',
      targetId: claims.requestId,
      targetLabel: request.title,
      details: { type: 'permission', sessionId: request.session_id, decision: action, via: 'push' },
    });
    reply(res, 200, action === 'allow' ? 'Autorisé' : 'Refusé');
  } catch (err) {
    log.warn(`[push] réponse depuis une notification impossible : ${(err as Error).message}`);
    reply(res, 409, (err as Error).message);
  }
  return true;
}
