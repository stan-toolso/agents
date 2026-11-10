import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { artifactDataService } from './dataService.js';
import { INJECT_MAX_BYTES, injectCommentScript, injectDataScript, injectSlidesScript } from './inject.js';
import { sharedPageRepository } from './repository.js';
import { downloadName, sharedPageService } from './service.js';

const ROUTE = /^\/api\/shared\/([0-9a-f-]{36})$/;

/**
 * GET /api/shared/<id>[?v=N][&download=1] : contenu HTML d'une page partagée, servi dans un bac à sable
 * (CSP `sandbox` sans `allow-same-origin` : origine opaque, la page ne lit ni le stockage de l'application
 * ni son API avec le cookie). Les droits sont revérifiés à chaque chargement. Renvoie false hors route.
 * Hors téléchargement (`download=1`) et sauf `raw=1`, le script des commentaires ancrés est injecté dans la page
 * (voir `inject.ts`) : il dialogue avec l'application par postMessage pour pointer un élément et placer les repères.
 * Artefact de données : les données de ses sources sont injectées en tête de la page (`window.Skipper`), téléchargement
 * compris (la page reste lisible hors de Skipper, avec les données du moment) ; l'ouverture est notée (`viewed_at`),
 * ce qui garde le rafraîchissement automatique en marche. Artefact de diapositives : le lecteur est injecté (mode
 * `thumb=1` pour l'aperçu réduit, `print=1` pour l'export PDF : toutes les diapositives puis impression), sauf au
 * téléchargement et avec `raw=1` (le fichier HTML tel que publié).
 */
export async function handleSharedPageRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end("Connectez-vous à Skipper pour ouvrir cette page.");
    return true;
  }
  try {
    const page = await sharedPageService.getFor(user.id, match[1]);
    const v = url.searchParams.get('v');
    const content = await sharedPageService.content(page, v ? Number(v) : null);
    const download = url.searchParams.get('download') === '1';
    const raw = download || url.searchParams.get('raw') === '1' || content.html.length > INJECT_MAX_BYTES;
    let html = content.html;
    // Type de la version servie (une republication peut l'avoir changé) ; celui de l'artefact si elle ne l'a pas gardé.
    const kind = content.version === page.version ? page.kind : ((await sharedPageRepository.version(page.id, content.version))?.kind ?? page.kind);
    if (kind === 'data' && content.html.length <= INJECT_MAX_BYTES && url.searchParams.get('raw') !== '1') {
      const sources = await artifactDataService.sourcesAt(page, content.version, true);
      const data = Object.fromEntries(sources.map((s) => [s.name, s.data]));
      const meta = {
        refreshedAt: page.dataRefreshedAt?.toISOString() ?? null,
        sources: sources.map((s) => ({ name: s.name, kind: s.kind, status: s.status, error: s.error, rowCount: s.rowCount, refreshedAt: s.refreshedAt?.toISOString() ?? null })),
      };
      html = Buffer.from(injectDataScript(html.toString('utf8'), { data, meta }), 'utf8');
      // Aperçu réduit de la galerie (`thumb=1`) : pas une lecture, le rafraîchissement automatique n'en tient pas compte.
      if (!download && url.searchParams.get('thumb') !== '1') void sharedPageRepository.touchViewed(page.id).catch(() => undefined);
    }
    if (!raw && kind === 'slides') {
      const mode = url.searchParams.get('print') === '1' ? 'print' : url.searchParams.get('thumb') === '1' ? 'thumb' : 'view';
      html = Buffer.from(injectSlidesScript(html.toString('utf8'), mode), 'utf8');
    }
    if (!raw) html = Buffer.from(injectCommentScript(html.toString('utf8')), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(download ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName(page.title))}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (err) {
    const status = err instanceof AppError ? (err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400) : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(status === 500 ? 'Impossible de lire la page.' : (err as Error).message);
  }
  return true;
}
