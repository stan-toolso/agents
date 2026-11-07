import { config } from '../config.js';
import type { ExternalIdentity } from '../users/types.js';

/**
 * Fournisseurs de connexion OAuth autres que Google (flux « authorization code », sans dépendance) : Microsoft (Entra ID,
 * comptes personnels et professionnels) et GitHub. Chacun rend un `ExternalIdentity` dont seules les adresses
 * **vérifiées** peuvent retrouver une invitation ; un compte relié une fois (`user_identities`) se reconnaît ensuite
 * par son identifiant, quelle que soit son adresse.
 */
export type LoginProviderId = ExternalIdentity['provider'];

export interface LoginProvider {
  id: LoginProviderId;
  label: string;
  readonly configured: boolean;
  readonly redirectUri: string;
  authorizationUrl(state: string): string;
  fetchIdentity(code: string): Promise<ExternalIdentity>;
}

/** Annuaire Microsoft des comptes personnels (outlook.com, hotmail…), dont l'adresse est vérifiée par Microsoft. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Contenu (non vérifié) d'un JWT : acceptable pour l'id_token reçu directement du point de jeton en TLS (OIDC, § 3.1.3.7). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Jeton d’identité illisible');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Identité Microsoft d'après les revendications de l'id_token. Une adresse n'est retenue comme vérifiée que pour un compte
 * personnel, un compte de l'annuaire imposé par `MICROSOFT_TENANT`, ou un annuaire qui en a prouvé le domaine
 * (`xms_edov`, revendication facultative à ajouter dans l'inscription de l'application) : ailleurs, l'administrateur
 * d'un annuaire choisit librement l'adresse de ses comptes (attaque « nOAuth »).
 */
export function microsoftIdentityFromClaims(claims: Record<string, unknown>, tenant: string): ExternalIdentity {
  const str = (k: string) => (typeof claims[k] === 'string' && (claims[k] as string).trim() ? (claims[k] as string).trim() : null);
  const tid = str('tid');
  const oid = str('oid');
  const sub = str('sub');
  if (!tid || !(oid || sub)) throw new Error('Profil Microsoft incomplet');
  if (GUID_RE.test(tenant) && tid.toLowerCase() !== tenant.toLowerCase()) throw new Error('Ce compte Microsoft n’appartient pas à l’annuaire autorisé');
  const email = (str('email') ?? (str('preferred_username')?.includes('@') ? str('preferred_username') : null))?.toLowerCase() ?? null;
  const edov = claims.xms_edov === true || claims.xms_edov === 1 || claims.xms_edov === '1' || claims.xms_edov === 'true';
  const trusted = tid === MICROSOFT_CONSUMER_TENANT || (GUID_RE.test(tenant) && tid.toLowerCase() === tenant.toLowerCase()) || edov;
  return {
    provider: 'microsoft',
    subject: `${tid}:${oid ?? sub}`,
    verifiedEmails: trusted && email ? [email] : [],
    email,
    name: str('name'),
    avatarUrl: null,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* réponse non JSON */
  }
  if (!res.ok || json.error) throw new Error(`Échange du code refusé (${res.status}) : ${String(json.error_description ?? json.error ?? text).slice(0, 200)}`);
  return json;
}

export const microsoftAuth: LoginProvider = {
  id: 'microsoft',
  label: 'Microsoft',
  get configured() {
    return Boolean(config.microsoftClientId && config.microsoftClientSecret);
  },
  get redirectUri() {
    return `${config.apiUrl}/auth/microsoft/callback`;
  },
  authorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: config.microsoftClientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(config.microsoftTenant)}/oauth2/v2.0/authorize?${params}`;
  },
  async fetchIdentity(code) {
    const tokens = await postForm(`https://login.microsoftonline.com/${encodeURIComponent(config.microsoftTenant)}/oauth2/v2.0/token`, {
      client_id: config.microsoftClientId,
      client_secret: config.microsoftClientSecret,
      code,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      scope: 'openid email profile',
    });
    if (typeof tokens.id_token !== 'string') throw new Error('Réponse Microsoft sans jeton d’identité');
    const claims = decodeJwtPayload(tokens.id_token);
    if (claims.aud !== config.microsoftClientId) throw new Error('Jeton d’identité Microsoft destiné à une autre application');
    return microsoftIdentityFromClaims(claims, config.microsoftTenant);
  },
};

export const githubAuth: LoginProvider = {
  id: 'github',
  label: 'GitHub',
  get configured() {
    return Boolean(config.githubLoginClientId && config.githubLoginClientSecret);
  },
  get redirectUri() {
    return `${config.apiUrl}/auth/github/callback`;
  },
  authorizationUrl(state) {
    const params = new URLSearchParams({ client_id: config.githubLoginClientId, redirect_uri: this.redirectUri, scope: 'read:user user:email', state, allow_signup: 'false' });
    return `https://github.com/login/oauth/authorize?${params}`;
  },
  async fetchIdentity(code) {
    const tokens = await postForm('https://github.com/login/oauth/access_token', {
      client_id: config.githubLoginClientId,
      client_secret: config.githubLoginClientSecret,
      code,
      redirect_uri: this.redirectUri,
    });
    const token = tokens.access_token;
    if (typeof token !== 'string') throw new Error('Réponse GitHub sans jeton d’accès');
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Skipper', 'x-github-api-version': '2022-11-28' };
    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) throw new Error(`Lecture du profil GitHub impossible (${userRes.status})`);
    const user = (await userRes.json()) as { id?: number; login?: string; name?: string | null; avatar_url?: string | null; email?: string | null };
    if (!user.id) throw new Error('Profil GitHub incomplet');
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
    const emails = emailsRes.ok ? ((await emailsRes.json()) as { email: string; verified: boolean; primary: boolean }[]) : [];
    const verified = emails.filter((e) => e.verified && e.email && !e.email.endsWith('@users.noreply.github.com')).sort((a, b) => Number(b.primary) - Number(a.primary));
    return {
      provider: 'github',
      subject: String(user.id),
      verifiedEmails: verified.map((e) => e.email.toLowerCase()),
      email: verified[0]?.email.toLowerCase() ?? user.email?.toLowerCase() ?? null,
      name: user.name || user.login || null,
      avatarUrl: user.avatar_url ?? null,
    };
  },
};

export const loginProviders: Record<LoginProviderId, LoginProvider> = { microsoft: microsoftAuth, github: githubAuth };
export const isLoginProviderId = (s: string): s is LoginProviderId => s === 'microsoft' || s === 'github';
