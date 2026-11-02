import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { isAllowedOrigin } from '../origin.js';
import { projectService } from '../projects/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { userService } from '../users/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { sessionToMarkdown, type MarkdownEvent } from './sessionMarkdown.js';
import { exportProjectArchive } from './service.js';

const SESSION_ROUTE = /^\/api\/sessions\/([0-9a-f-]{36})\/export\.md$/;
const PROJECT_ROUTE = /^\/api\/projects\/([0-9a-f-]{36})\/export\.tar\.gz$/;

/** Nom de fichier sûr pour Content-Disposition (le nom complet, accents compris, passe par filename*). */
function disposition(filename: string): string {
  const ascii = filename.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'export';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function sessionMarkdown(sessionId: string): Promise<{ filename: string; markdown: string } | null> {
  const session = await sessionRepository.findById(sessionId);
  if (!session) return null;
  const [project, worksession, owner] = await Promise.all([
    projectService.get(session.projectId),
    session.worksessionId ? worksessionRepository.findById(session.worksessionId) : Promise.resolve(null),
    session.ownerId ? userService.get(session.ownerId).catch(() => null) : Promise.resolve(null),
  ]);
  const events: MarkdownEvent[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await sessionRepository.listEvents(sessionId, { after, limit: 2000 });
    events.push(...page);
    if (page.length < 2000) break;
    after = page[page.length - 1].id;
  }
  const markdown = sessionToMarkdown(
    {
      id: session.id,
      name: session.name,
      provider: session.provider,
      status: session.status,
      prompt: session.prompt,
      createdAt: session.createdAt,
      projectName: project.name,
      branch: worksession?.branch ?? session.formerWorksession?.branch ?? null,
      ownerName: owner?.name ?? null,
      url: `${config.appUrl}/sessions/${session.id}`,
    },
    events,
  );
  const base = session.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'session';
  return { filename: `${base}.md`, markdown };
}

/**
 * Téléchargements des exports, authentifiés par le cookie de session :
 * - GET /api/sessions/<id>/export.md : la session en Markdown (accès au projet suffisant) ;
 * - GET /api/projects/<id>/export.tar.gz : l'archive du projet (administrateurs du projet).
 * Renvoie false si l'URL n'est pas l'une de ces routes.
 */
export async function handleExportRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const sessionMatch = url.pathname.match(SESSION_ROUTE);
  const projectMatch = sessionMatch ? null : url.pathname.match(PROJECT_ROUTE);
  if (!sessionMatch && !projectMatch) return false;
  if (req.method !== 'GET') {
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
  const ctx = createAuthContext(user);
  try {
    if (sessionMatch) {
      const session = await sessionRepository.findById(sessionMatch[1]);
      if (!session) {
        res.writeHead(404).end();
        return true;
      }
      await requireProject(ctx, session.projectId, 'viewer');
    } else {
      await requireProject(ctx, projectMatch![1], 'admin');
    }
  } catch {
    res.writeHead(403).end();
    return true;
  }
  try {
    if (sessionMatch) {
      const out = await sessionMarkdown(sessionMatch[1]);
      if (!out) {
        res.writeHead(404).end();
        return true;
      }
      const body = Buffer.from(out.markdown, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': body.length, 'Content-Disposition': disposition(out.filename), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } else {
      const { filename, archive } = await exportProjectArchive(projectMatch![1]);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': archive.length, 'Content-Disposition': disposition(filename), 'Cache-Control': 'no-store' });
      res.end(archive);
    }
  } catch (err) {
    log.error('[exports] export', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end("L'export a échoué");
  }
  return true;
}
