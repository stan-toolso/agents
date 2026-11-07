import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { googleAccountService, parseAccess } from '../google/service.js';
import { userService } from '../users/service.js';
import { vaultService } from '../vault/service.js';
import { googleAuth } from './google.js';
import { signInService } from './signInService.js';
import { MAX_PASSWORD_LENGTH } from './password.js';
import { isLoginProviderId, loginProviders, type LoginProviderId } from './providers.js';
import { authSession, readCookie, SESSION_COOKIE } from './session.js';
import { isAllowedOrigin } from '../origin.js';
import { log } from '../log.js';

const STATE_COOKIE = 'skipper_oauth';

/** Chemin de retour dans l'application : uniquement un chemin relatif (jamais une URL externe). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.writeHead(302, { Location: location });
  res.end();
}

function stateCookie(value: string | null): string {
  const attrs = ['Path=/auth', 'HttpOnly', 'SameSite=Lax', value ? 'Max-Age=600' : 'Max-Age=0'];
  if (config.apiUrl.startsWith('https://')) attrs.push('Secure');
  return `${STATE_COOKIE}=${value ?? ''}; ${attrs.join('; ')}`;
}

const toApp = (path: string) => `${config.appUrl}${path}`;
/** Retour à la page de connexion avec un code d'erreur (et le message du serveur, affiché quand le code n'est pas connu du front). */
const loginError = (code: string, message?: string) => toApp(`/?authError=${encodeURIComponent(code)}${message ? `&authMessage=${encodeURIComponent(message.slice(0, 300))}` : ''}`);

/**
 * Contenu du cookie d'état : connexion d'un utilisateur (`next`) ou rattachement d'un compte Google au coffre
 * (`vault` : coffre d'un projet ou personnel, avec `replaceId` quand il remplace un compte déjà relié).
 */
interface OAuthState {
  state: string;
  next?: string;
  vault?: { projectId: string | null; userId: string; replaceId?: string };
}
/** Retour de Microsoft ou GitHub : connexion (`next`) ou liaison du compte à la personne connectée (`linkUserId`). */
interface ProviderState {
  state: string;
  provider: LoginProviderId;
  next?: string;
  linkUserId?: string;
}
const loginSettings = (params: Record<string, string>) => toApp(`/settings?${new URLSearchParams({ section: 'login', ...params })}`);

const encodeState = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url');
function readState<T>(req: IncomingMessage): T | null {
  try {
    const raw = readCookie(req.headers.cookie, STATE_COOKIE);
    return raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T) : null;
  } catch {
    return null;
  }
}

/** Adresse du client : nginx (seul à joindre le backend en production) pose X-Real-IP / X-Forwarded-For. */
function clientIp(req: IncomingMessage): string | null {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',').pop()!.trim();
  return req.socket.remoteAddress ?? null;
}

/** En-têtes CORS des routes JSON (développement : front sur un autre port que l'API). */
function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  cors(req, res);
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const sendError = (req: IncomingMessage, res: ServerResponse, err: unknown) => {
  const app = err instanceof AppError;
  const status = !app ? 500 : err.code === 'TOO_MANY_ATTEMPTS' ? 429 : err.code === 'INVALID_CREDENTIALS' ? 401 : err.code === 'FORBIDDEN' ? 403 : 400;
  if (!app) log.error('[auth]', err);
  sendJson(req, res, status, { error: app ? err.message : 'Erreur inattendue', code: app ? err.code : 'INTERNAL' });
};

/**
 * Corps JSON d'une route d'authentification. Exige `content-type: application/json` (une page d'un autre site ne
 * peut pas l'envoyer sans pré-vol CORS) et refuse une origine étrangère : pas de connexion forcée depuis un autre site.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new AppError('Corps JSON attendu');
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) throw new AppError('Origine refusée', 'FORBIDDEN');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024) throw new AppError('Requête trop volumineuse');
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    throw new AppError('Corps JSON illisible');
  }
}
const str = (v: unknown, max = MAX_PASSWORD_LENGTH + 64) => (typeof v === 'string' ? v.slice(0, max) : '');

const vaultPage = (projectId: string | null, params: Record<string, string>) => toApp(`${projectId ? `/projects/${projectId}/vault` : '/vault'}?${new URLSearchParams(params)}`);

/**
 * Routes HTTP d'authentification, à côté de GraphQL :
 * - GET  /auth/google?next=/chemin : redirige vers Google ;
 * - GET  /auth/google/callback      : retour de Google, ouvre la session et renvoie vers l'application ;
 * - GET  /auth/google/connect?(projectId=…|personal=1)&gmail=read|write|none&drive=read|write|none[&itemId=…] :
 *   relie un compte Google au coffre du projet (administrateur) ou au coffre personnel, ou remplace l'élément
 *   `itemId` ; le retour passe par le même callback et ramène sur la page du coffre ;
 * - GET  /auth/methods              : modes de connexion offerts (page de connexion) ;
 * - POST /auth/password/login       : e-mail et mot de passe (JSON), ouvre la session ;
 * - POST /auth/password/forgot      : envoie un lien pour choisir ou réinitialiser son mot de passe (si SMTP) ;
 * - GET  /auth/password/token       : à qui appartient un lien de mot de passe ;
 * - POST /auth/password/reset       : choisit le mot de passe avec un lien, ouvre la session ;
 * - GET  /auth/microsoft|github[?next=…], …/link, …/callback : connexion ou liaison d'un compte Microsoft ou GitHub ;
 * - POST /auth/logout               : ferme la session.
 * Renvoie false si l'URL n'est pas une route d'authentification.
 */
export async function handleAuthRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  if (!url.pathname.startsWith('/auth/')) return false;

  if (req.method === 'OPTIONS') {
    cors(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204);
    res.end();
    return true;
  }

  // Modes de connexion offerts (page de connexion, sans session).
  if (url.pathname === '/auth/methods' && req.method === 'GET') {
    sendJson(req, res, 200, await signInService.availableMethods());
    return true;
  }

  // E-mail et mot de passe : ouvre la session comme le retour de Google.
  if (url.pathname === '/auth/password/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const user = await signInService.loginWithPassword(str(body.email, 320), str(body.password), clientIp(req));
      const token = await authSession.create(user);
      log.info(`[auth] connexion de ${user.email} (mot de passe)`);
      sendJson(req, res, 200, { ok: true }, [authSession.cookie(token)]);
    } catch (err) {
      if (err instanceof AppError) log.info(`[auth] connexion par mot de passe refusée (${err.code}) depuis ${clientIp(req) ?? '?'}`);
      sendError(req, res, err);
    }
    return true;
  }

  // « Mot de passe oublié » : toujours 204, que l'adresse existe ou non.
  if (url.pathname === '/auth/password/forgot' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await signInService.requestPasswordReset(str(body.email, 320));
      cors(req, res);
      res.writeHead(204);
      res.end();
    } catch (err) {
      sendError(req, res, err);
    }
    return true;
  }

  // Lien de mot de passe : à qui il appartient (page « Choisir un mot de passe »).
  if (url.pathname === '/auth/password/token' && req.method === 'GET') {
    const user = await signInService.userOfToken(url.searchParams.get('token') ?? '');
    sendJson(req, res, 200, user && user.kind === 'person' ? { valid: true, email: user.email, name: user.name, hasPassword: Boolean(user.passwordSetAt) } : { valid: false });
    return true;
  }

  if (url.pathname === '/auth/password/reset' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const user = await signInService.resetPassword(str(body.token, 200), str(body.password));
      const token = await authSession.create(user);
      log.info(`[auth] mot de passe choisi par ${user.email}`);
      sendJson(req, res, 200, { ok: true }, [authSession.cookie(token)]);
    } catch (err) {
      sendError(req, res, err);
    }
    return true;
  }

  // Microsoft, GitHub : /auth/<fournisseur>?next=… (connexion), /auth/<fournisseur>/link (relier à la personne connectée), /auth/<fournisseur>/callback.
  const providerMatch = /^\/auth\/(microsoft|github)(\/link|\/callback)?$/.exec(url.pathname);
  if (providerMatch && req.method === 'GET' && isLoginProviderId(providerMatch[1])) {
    const provider = loginProviders[providerMatch[1]];
    const step = providerMatch[2] ?? '';
    if (step === '' || step === '/link') {
      const linking = step === '/link';
      if (!provider.configured) {
        redirect(res, linking ? loginSettings({ loginError: `Connexion ${provider.label} non configurée sur le serveur` }) : loginError('not_configured'));
        return true;
      }
      let linkUserId: string | undefined;
      if (linking) {
        const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
        if (!user) {
          redirect(res, loginError('unauthenticated'));
          return true;
        }
        linkUserId = user.id;
      }
      const state = randomBytes(16).toString('base64url');
      const payload: ProviderState = { state, provider: provider.id, ...(linking ? { linkUserId } : { next: safeNext(url.searchParams.get('next')) }) };
      redirect(res, provider.authorizationUrl(state), [stateCookie(encodeState(payload))]);
      return true;
    }
    // Retour du fournisseur.
    const expected = readState<ProviderState>(req);
    const linking = Boolean(expected?.linkUserId);
    const fail = (message: string, code: string) => redirect(res, linking ? loginSettings({ loginError: message }) : loginError(code, message), [stateCookie(null)]);
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) {
      const error = url.searchParams.get('error') ?? 'cancelled';
      fail(error === 'access_denied' ? `Autorisation refusée sur ${provider.label}` : `${provider.label} : ${url.searchParams.get('error_description') ?? error}`, error === 'access_denied' ? 'access_denied' : 'cancelled');
      return true;
    }
    if (!expected || expected.provider !== provider.id || url.searchParams.get('state') !== expected.state) {
      fail('État OAuth invalide, recommencez', 'invalid_state');
      return true;
    }
    try {
      const identity = await provider.fetchIdentity(code);
      if (expected.linkUserId) {
        const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
        if (!user || user.id !== expected.linkUserId) throw new AppError('Session expirée, reconnectez-vous puis recommencez', 'UNAUTHENTICATED');
        await signInService.linkIdentity(user, identity);
        log.info(`[auth] compte ${provider.label} ${identity.email ?? identity.subject} relié à ${user.email}`);
        redirect(res, loginSettings({ linked: provider.id }), [stateCookie(null)]);
        return true;
      }
      const user = await signInService.loginWithIdentity(identity);
      const token = await authSession.create(user);
      log.info(`[auth] connexion de ${user.email} (${provider.label})`);
      redirect(res, toApp(expected.next ?? '/'), [stateCookie(null), authSession.cookie(token)]);
    } catch (err) {
      const errCode = err instanceof AppError ? err.code.toLowerCase() : 'provider_error';
      log.error(`[auth] connexion ${provider.label} refusée :`, (err as Error).message);
      fail((err as Error).message, errCode);
    }
    return true;
  }

  if (url.pathname === '/auth/google' && req.method === 'GET') {
    if (!googleAuth.configured) {
      redirect(res, loginError('not_configured'));
      return true;
    }
    const state = randomBytes(16).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ state, next: safeNext(url.searchParams.get('next')) })).toString('base64url');
    redirect(res, googleAuth.authorizationUrl(state), [stateCookie(payload)]);
    return true;
  }

  if (url.pathname === '/auth/google/connect' && req.method === 'GET') {
    const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!user) {
      redirect(res, loginError('unauthenticated'));
      return true;
    }
    const projectId = url.searchParams.get('projectId') || null;
    try {
      if (!googleAccountService.configured) throw new AppError('Connexion Google non configurée (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)', 'NOT_CONFIGURED');
      // Invité des pages partagées : pas de coffre.
      if (user.isGuest) throw new AppError('Réservé aux membres des projets', 'FORBIDDEN');
      if (projectId && (await userService.roleFor(user.id, projectId)) !== 'admin') throw new AppError('Réservé aux administrateurs du projet', 'FORBIDDEN');
      const access = { gmail: parseAccess(url.searchParams.get('gmail'), 'messagerie'), drive: parseAccess(url.searchParams.get('drive'), 'Drive') };
      const replaceId = url.searchParams.get('itemId') || undefined;
      if (replaceId) {
        const item = await vaultService.getFor(user.id, replaceId, 'manage');
        if (item.kind !== 'google' || item.ownerProjectId !== projectId || item.ownerUserId !== (projectId ? null : user.id)) throw new AppError('Compte Google introuvable dans ce coffre', 'NOT_FOUND');
      }
      const state = randomBytes(16).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ state, vault: { projectId, userId: user.id, replaceId } } satisfies OAuthState)).toString('base64url');
      redirect(res, googleAccountService.authorizationUrl(state, access), [stateCookie(payload)]);
    } catch (err) {
      redirect(res, vaultPage(projectId, { googleError: (err as Error).message }));
    }
    return true;
  }

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    let expected: OAuthState | null = null;
    try {
      const raw = readCookie(req.headers.cookie, STATE_COOKIE);
      expected = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : null;
    } catch {
      expected = null;
    }
    const code = url.searchParams.get('code');
    const vault = expected?.vault;
    if (url.searchParams.get('error') || !code) {
      const error = url.searchParams.get('error') ?? 'cancelled';
      redirect(res, vault ? vaultPage(vault.projectId, { googleError: error === 'access_denied' ? 'Autorisation refusée sur Google' : error }) : loginError(error), [stateCookie(null)]);
      return true;
    }
    if (!expected || url.searchParams.get('state') !== expected.state) {
      redirect(res, vault ? vaultPage(vault.projectId, { googleError: 'État OAuth invalide, recommencez' }) : loginError('invalid_state'), [stateCookie(null)]);
      return true;
    }
    if (vault) {
      // Rattachement d'un compte Google au coffre : l'utilisateur de la session doit être celui qui a lancé le flux, et toujours habilité.
      try {
        const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
        if (!user || user.id !== vault.userId) throw new AppError('Session expirée, reconnectez-vous puis recommencez', 'UNAUTHENTICATED');
        if (vault.projectId && (await userService.roleFor(user.id, vault.projectId)) !== 'admin') throw new AppError('Réservé aux administrateurs du projet', 'FORBIDDEN');
        const item = await googleAccountService.connect({ userId: vault.projectId ? null : user.id, projectId: vault.projectId }, code, { userId: user.id, projectId: vault.projectId }, vault.replaceId);
        redirect(res, vaultPage(vault.projectId, { google: 'connected', email: (item.settings as { email: string }).email, item: item.id }), [stateCookie(null)]);
      } catch (err) {
        log.error('[google] rattachement refusé :', (err as Error).message);
        redirect(res, vaultPage(vault.projectId, { googleError: (err as Error).message }), [stateCookie(null)]);
      }
      return true;
    }
    try {
      const profile = await googleAuth.fetchProfile(code);
      const user = await userService.loginWithGoogle(profile);
      const token = await authSession.create(user);
      log.info(`[auth] connexion de ${user.email}`);
      redirect(res, toApp(expected.next ?? '/'), [stateCookie(null), authSession.cookie(token)]);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'google_error';
      log.error('[auth] connexion refusée :', (err as Error).message);
      redirect(res, loginError(code.toLowerCase()), [stateCookie(null)]);
    }
    return true;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    await authSession.destroy(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.setHeader('Set-Cookie', authSession.cookie(null));
    res.writeHead(204);
    res.end();
    return true;
  }

  res.writeHead(404);
  res.end();
  return true;
}
