import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { gitlabFetch, GITLAB_OAUTH_SCOPES, normalizeGitlabHost, storeGitlabOAuthAccount, type GitlabAccount, type GitlabTokenResponse } from './gitlab.js';

/**
 * Connexion d'un compte GitLab avec un code (OAuth 2.0 device authorization grant, GitLab 17.2 et plus) :
 * Skipper demande un code à l'instance, la personne le saisit sur la page de l'instance et autorise, la page
 * interroge jusqu'à ce que GitLab remette le jeton, rangé dans le coffre personnel et renouvelé par Skipper.
 * GitLab n'a pas de client public : il faut une application OAuth de l'instance (portées api, read_repository,
 * write_repository ; non confidentielle de préférence) dont l'identifiant va dans `GITLAB_CLIENT_ID`, et
 * `GITLAB_URL` pour une instance autre que gitlab.com (`GITLAB_CLIENT_SECRET` si l'application est confidentielle).
 * Sans `GITLAB_CLIENT_ID`, seuls les jetons personnels du coffre sont proposés.
 *
 * Sans état : l'identifiant remis à la page est le code d'appareil et son propriétaire, chiffrés avec la
 * clé du serveur, donc nul autre ne peut l'interroger.
 */

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface GitlabDeviceLogin {
  id: string;
  userCode: string;
  verificationUri: string;
  /** Page de validation avec le code déjà saisi, quand l'instance la fournit. */
  verificationUriComplete: string | null;
  expiresAt: Date;
  /** Secondes à attendre entre deux interrogations. */
  interval: number;
}

export type GitlabDevicePollStatus = 'pending' | 'connected' | 'expired' | 'denied';

export interface GitlabDevicePoll {
  status: GitlabDevicePollStatus;
  interval: number;
  account: GitlabAccount | null;
}

interface DeviceState {
  /** Code d'appareil. */
  d: string;
  /** Propriétaire (identifiant de la personne). */
  u: string;
  /** Expiration (ms epoch). */
  e: number;
}

export function gitlabDeviceConfig(): { clientId: string; host: string } | null {
  const clientId = process.env.GITLAB_CLIENT_ID?.trim();
  if (!clientId || clientId.toLowerCase() === 'none') return null;
  const host = normalizeGitlabHost(process.env.GITLAB_URL);
  return host ? { clientId, host } : null;
}

export const gitlabDevice = () => {
  const c = gitlabDeviceConfig();
  return { available: c !== null, host: c?.host ?? null };
};

function requireConfig(): { clientId: string; host: string } {
  const c = gitlabDeviceConfig();
  if (!c) throw new AppError("La connexion GitLab par code n'est pas configurée sur ce serveur (GITLAB_CLIENT_ID)");
  return c;
}

/** POST de formulaire vers l'instance ; GitLab répond 400 pour les états d'attente du device flow, le corps est donc lu dans tous les cas. */
async function postForm<T>(host: string, path: string, params: Record<string, string>): Promise<{ status: number; data: T }> {
  const secret = process.env.GITLAB_CLIENT_SECRET?.trim();
  const res = await gitlabFetch(host, path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(secret ? { ...params, client_secret: secret } : params) });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

function readState(id: string, userId: string): DeviceState {
  let state: DeviceState;
  try {
    state = JSON.parse(decryptSecret(id)) as DeviceState;
  } catch {
    throw new AppError('Connexion GitLab introuvable : recommencez');
  }
  if (state.u !== userId) throw new AppError('Connexion GitLab introuvable : recommencez');
  return state;
}

export const gitlabDeviceService = {
  /** Demande à l'instance un code que la personne saisit sur `verificationUri`. */
  async start(userId: string): Promise<GitlabDeviceLogin> {
    const { clientId, host } = requireConfig();
    const { status, data } = await postForm<{ device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }>(
      host,
      '/oauth/authorize_device',
      { client_id: clientId, scope: GITLAB_OAUTH_SCOPES.join(' ') },
    );
    if (data.error || !data.device_code || !data.user_code) {
      throw new AppError(`GitLab : ${data.error_description ?? data.error ?? `aucun code reçu (${status})`}. Vérifiez l'application OAuth (identifiant, portées, instance 17.2 ou plus).`);
    }
    const expiresAt = new Date(Date.now() + (data.expires_in ?? 600) * 1000);
    return {
      id: encryptSecret(JSON.stringify({ d: data.device_code, u: userId, e: expiresAt.getTime() } satisfies DeviceState)),
      userCode: data.user_code,
      verificationUri: data.verification_uri ?? `https://${host}/oauth/device`,
      verificationUriComplete: data.verification_uri_complete ?? null,
      expiresAt,
      interval: data.interval ?? 5,
    };
  },

  /** Une interrogation d'une connexion lancée par la personne : enregistre le compte une fois l'autorisation donnée. */
  async poll(userId: string, id: string): Promise<GitlabDevicePoll> {
    const state = readState(id, userId);
    if (state.e < Date.now()) return { status: 'expired', interval: 0, account: null };
    const { clientId, host } = requireConfig();
    const { data: t } = await postForm<GitlabTokenResponse & { interval?: number }>(host, '/oauth/token', { client_id: clientId, device_code: state.d, grant_type: DEVICE_GRANT });
    switch (t.error) {
      case undefined:
        if (!t.access_token) throw new AppError('GitLab : aucun jeton reçu');
        return { status: 'connected', interval: 0, account: await storeGitlabOAuthAccount(userId, host, t, clientId) };
      case 'authorization_pending':
        return { status: 'pending', interval: t.interval ?? 5, account: null };
      case 'slow_down':
        return { status: 'pending', interval: t.interval ?? 10, account: null };
      case 'expired_token':
        return { status: 'expired', interval: 0, account: null };
      case 'access_denied':
        return { status: 'denied', interval: 0, account: null };
      default:
        throw new AppError(`GitLab : ${t.error_description ?? t.error}`);
    }
  },
};
