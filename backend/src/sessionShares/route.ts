import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { userService } from '../users/service.js';
import { toPublicEvents, type PublicEvent } from './publicEvents.js';
import { redactSecrets } from './redact.js';
import { sessionShareService } from './service.js';

const ROUTE = /^\/api\/share\/([^/]+)$/;
/** Au-delà, le transcript partagé est coupé (les plus anciens événements d'abord). */
const MAX_EVENTS = 20_000;
const PAGE = 2000;

/** Ce que la page publique `/share/<token>` reçoit : de quoi afficher l'en-tête et le transcript, rien d'autre. */
export interface SharedSessionView {
  session: { name: string; projectName: string; ownerName: string | null; status: string; createdAt: string };
  expiresAt: string;
  truncated: boolean;
  events: PublicEvent[];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

/**
 * GET /api/share/<token> : transcript d'une session partagée par lien public, sans connexion. Lecture seule par
 * construction (seul GET est servi, aucune mutation n'accepte de jeton de partage) ; un lien inconnu, révoqué ou
 * expiré renvoie 404. Les événements passent par une liste blanche et les secrets sont masqués (publicEvents.ts).
 */
export async function handleSessionShareRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' }).end();
    return true;
  }
  try {
    const share = await sessionShareService.resolve(decodeURIComponent(match[1]));
    const session = share ? await sessionRepository.findById(share.sessionId) : null;
    if (!share || !session) {
      json(res, 404, { error: "Ce lien de partage n'existe pas, a expiré ou a été révoqué." });
      return true;
    }
    const [project, owner] = await Promise.all([projectService.get(session.projectId), session.ownerId ? userService.get(session.ownerId).catch(() => null) : Promise.resolve(null)]);
    const raw = [];
    let after: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await sessionRepository.listEvents(session.id, { after, limit: PAGE });
      raw.push(...page);
      if (page.length < PAGE) break;
      if (raw.length >= MAX_EVENTS) {
        truncated = true;
        break;
      }
      after = page[page.length - 1].id;
    }
    const events = toPublicEvents(raw);
    // Consigne de départ jamais journalisée comme instruction (sessions anciennes) : montrée en tête, comme l'export.
    if (session.prompt?.trim() && !events.some((e) => e.type === 'instruction')) {
      events.unshift({ id: '0', sessionId: session.id, type: 'instruction', payload: { text: redactSecrets(session.prompt) }, createdAt: session.createdAt.toISOString() });
    }
    const view: SharedSessionView = {
      session: { name: session.name, projectName: project.name, ownerName: owner?.name ?? null, status: session.status, createdAt: session.createdAt.toISOString() },
      expiresAt: share.expiresAt.toISOString(),
      truncated,
      events,
    };
    json(res, 200, view);
  } catch (err) {
    log.error('[sessionShares] lecture du lien', err);
    if (!res.headersSent) json(res, 500, { error: 'Impossible de lire la session partagée.' });
  }
  return true;
}
