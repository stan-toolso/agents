import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { isAllowedOrigin } from '../origin.js';
import { messageAttachmentFile } from './attachments.js';
import { conversationRepository } from './repository.js';

const ROUTE = /^\/api\/message-attachments\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

/** Types servis tels quels au navigateur (aperçu) ; tout le reste est proposé en téléchargement. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);


/**
 * GET /api/message-attachments/<canal>/<id> : fichier joint à un message d'un canal (aperçu des images,
 * téléchargement). Authentification par le cookie de session ; il faut avoir accès au projet du canal. Même
 * comportement que la route des fichiers des tâches (tasks/attachmentRoute.ts). Renvoie false si l'URL n'est pas
 * cette route.
 */
export async function handleMessageAttachmentRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) {
    res.writeHead(401).end();
    return true;
  }
  const [, conversationId, attachmentId] = match;
  const conversation = await conversationRepository.findById(conversationId);
  const attachment = conversation ? await conversationRepository.findAttachment(attachmentId) : null;
  if (!conversation || !attachment || attachment.conversationId !== conversation.id) {
    res.writeHead(404).end();
    return true;
  }
  try {
    await requireProject(createAuthContext(user), conversation.projectId, 'viewer');
  } catch {
    res.writeHead(403).end();
    return true;
  }
  const file = await messageAttachmentFile(attachment);
  if (!file) {
    res.writeHead(404).end();
    return true;
  }
  // Le type est celui enregistré, jamais deviné du nom seul.
  const mediaType = attachment.mediaType || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mediaType.startsWith('text/') ? `${mediaType}; charset=utf-8` : mediaType,
    'Content-Length': file.size,
    'Content-Disposition': `${INLINE_TYPES.has(mediaType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
  return true;
}
