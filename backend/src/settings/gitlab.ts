import { AppError, NotFoundError } from '../errors.js';
import { vaultService } from '../vault/service.js';
import type { VaultActor } from '../vault/types.js';
import { gitlabAccountRepository, type GitlabAccountRecord } from './gitlabRepository.js';
import { pickCredential } from './github.js';
import { log } from '../log.js';

/**
 * Comptes GitLab d'UNE personne (plusieurs possibles, sur gitlab.com ou sur une instance auto-hébergée),
 * pendant de `github.ts` : connectés avec un code (device flow d'une application OAuth de l'instance,
 * `GITLAB_CLIENT_ID`) ou avec un jeton d'accès personnel gardé dans son coffre (jeton applicatif 'gitlab').
 * Les jetons servent aux commandes git de la personne (clone, fetch, push), à la liste de ses dépôts et
 * aux agents des sessions qu'elle possède ; chaque usage vérifie qu'elle peut toujours utiliser l'élément.
 * Pour un dépôt, le compte employé est celui de la même instance dont l'identifiant ou l'un des groupes
 * possède l'espace du dépôt, sinon le compte par défaut de cette instance.
 */

const USER_AGENT = 'skipper';
export const GITLAB_COM = 'gitlab.com';
/** Portées demandées par le device flow : API (dépôts, groupes, merge requests) et git en https (lecture/écriture). */
export const GITLAB_OAUTH_SCOPES = ['api', 'read_repository', 'write_repository'];
/** Un jeton qui expire est renouvelé quand il lui reste moins que ceci (les jetons OAuth de GitLab durent 2 h). */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface GitlabAccount {
  id: string;
  host: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  method: 'oauth' | 'pat';
  scopes: string[];
  groups: string[];
  isDefault: boolean;
  /** Élément du coffre qui détient le jeton. */
  vaultItemId: string;
  connectedAt: Date;
  tokenExpiresAt: Date | null;
}

export interface GitlabAuthStatus {
  connected: boolean;
  accounts: GitlabAccount[];
  /** La connexion par code (device flow) est possible sur ce serveur. */
  deviceAvailable: boolean;
  /** Instance de la connexion par code. */
  deviceHost: string | null;
}

export interface GitlabRepository {
  fullName: string;
  name: string;
  namespace: string;
  description: string | null;
  private: boolean;
  defaultBranch: string | null;
  cloneUrl: string;
  htmlUrl: string;
  pushedAt: Date | null;
  host: string;
  /** Identifiant du compte connecté avec lequel le dépôt a été listé. */
  account: string;
}

/** Jeton en clair d'un compte, et les espaces qu'il sert (son identifiant et ses groupes, en minuscules). */
export interface GitlabCredential {
  host: string;
  login: string;
  name: string | null;
  email: string | null;
  token: string;
  owners: string[];
  isDefault: boolean;
}

export interface GitlabTokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Nom d'hôte d'une instance saisie par la personne (« gitlab.exemple.fr », « https://gitlab.exemple.fr/ ») :
 * en minuscules, avec le port s'il en a un ; null si ce n'est pas une adresse.
 */
export function normalizeGitlabHost(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return GITLAB_COM;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    return u.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

const hostname = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

/**
 * Instance et espace (premier segment du chemin, en minuscules) d'une URL de dépôt (https ou ssh). Une URL est
 * GitLab si son hôte est gitlab.com ou l'une des `knownHosts` (instances des comptes connectés) ; null sinon.
 */
export function gitlabRepoOf(url: string | null | undefined, knownHosts: string[] = []): { host: string; namespace: string; path: string } | null {
  const u = (url ?? '').trim();
  const m = u.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i) ?? u.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i) ?? u.match(/^(?:[^@/]+@)([^:/]+):(?!\d+\/)(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const name = hostname(m[1]);
  const known = [GITLAB_COM, ...knownHosts].find((h) => hostname(h) === name);
  if (!known) return null;
  const path = m[2].replace(/^\/+/, '');
  if (!path.includes('/')) return null;
  return { host: known.toLowerCase(), namespace: path.split('/')[0].toLowerCase(), path };
}

/**
 * Instances GitLab connues du serveur (celles où une personne a connecté un compte), pour reconnaître le dépôt
 * auto-hébergé d'un projet sans dépendre des comptes de la personne qui regarde. Relues au plus une fois par minute
 * (`refreshKnownGitlabHosts`) et à chaque connexion de compte ; gitlab.com est toujours reconnu.
 */
let knownHosts: string[] = [];
let knownHostsAt = 0;
const KNOWN_HOSTS_TTL_MS = 60_000;

export const knownGitlabHosts = (): string[] => knownHosts;

export async function refreshKnownGitlabHosts(opts: { force?: boolean } = {}): Promise<string[]> {
  if (!opts.force && Date.now() - knownHostsAt < KNOWN_HOSTS_TTL_MS) return knownHosts;
  knownHostsAt = Date.now();
  try {
    knownHosts = await gitlabAccountRepository.allHosts();
  } catch (err) {
    log.warn(`[gitlab] instances connues illisibles : ${(err as Error).message}`);
  }
  return knownHosts;
}

/** Pour les tests : fixe les instances connues. */
export function setKnownGitlabHosts(hosts: string[]): void {
  knownHosts = hosts;
  knownHostsAt = Date.now();
}

/** Dépôt GitLab d'une URL de projet (gitlab.com ou une instance connue), null sinon. */
export const projectGitlabRepo = (url: string | null | undefined) => gitlabRepoOf(url, knownHosts);

export async function gitlabFetch(host: string, path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, ...((init.headers as Record<string, string>) ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return fetch(`https://${host}${path}`, { ...init, headers });
}

const toPublic = (a: GitlabAccountRecord): GitlabAccount => ({
  id: a.id,
  host: a.host,
  login: a.login,
  name: a.name,
  avatarUrl: a.avatarUrl,
  method: a.method,
  scopes: a.scopes,
  groups: a.groups,
  isDefault: a.isDefault,
  vaultItemId: a.vaultItemId,
  connectedAt: a.updatedAt,
  tokenExpiresAt: a.tokenExpiresAt,
});

const inSeconds = (s: number | undefined) => (s ? new Date(Date.now() + s * 1000) : null);

interface AccountInfo {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  scopes: string[];
  groups: string[];
  /** Expiration d'un jeton personnel, quand il en a une. */
  expiresAt: Date | null;
}

/** Profil, portées et groupes de premier niveau du compte d'un jeton. */
export async function readGitlabAccount(host: string, token: string): Promise<AccountInfo> {
  let res: Response;
  try {
    res = await gitlabFetch(host, '/api/v4/user', { token });
  } catch (err) {
    throw new AppError(`GitLab (${host}) injoignable : ${(err as Error).message}`);
  }
  if (res.status === 401) throw new AppError(`GitLab (${host}) refuse ce jeton (invalide, expiré, révoqué ou d'une autre instance)`);
  if (!res.ok) throw new AppError(`GitLab (${host}) : vérification impossible (${res.status})`);
  const user = (await res.json()) as { id: number; username: string; name?: string; avatar_url?: string; commit_email?: string; public_email?: string; email?: string };
  let scopes: string[] = [];
  let expiresAt: Date | null = null;
  try {
    // Jeton personnel : ses portées et son expiration ; jeton OAuth : ses portées.
    const pat = await gitlabFetch(host, '/api/v4/personal_access_tokens/self', { token });
    if (pat.ok) {
      const t = (await pat.json()) as { scopes?: string[]; expires_at?: string | null };
      scopes = t.scopes ?? [];
      expiresAt = t.expires_at ? new Date(`${t.expires_at}T23:59:59Z`) : null;
    } else {
      const info = await gitlabFetch(host, '/oauth/token/info', { token });
      if (info.ok) scopes = ((await info.json()) as { scope?: string[] }).scope ?? [];
    }
  } catch (err) {
    log.warn(`[gitlab] portées illisibles pour ${user.username}@${host} : ${(err as Error).message}`);
  }
  const groups = new Set<string>();
  try {
    const res = await gitlabFetch(host, '/api/v4/groups?min_access_level=10&per_page=100', { token });
    if (res.ok) for (const g of (await res.json()) as Array<{ full_path: string }>) groups.add(g.full_path.split('/')[0]);
  } catch (err) {
    log.warn(`[gitlab] groupes illisibles pour ${user.username}@${host} : ${(err as Error).message}`);
  }
  return {
    login: user.username,
    name: user.name ?? null,
    email: user.commit_email || user.public_email || user.email || `${user.id}-${user.username}@users.noreply.${hostname(host)}`,
    avatarUrl: user.avatar_url ?? null,
    scopes,
    groups: [...groups],
    expiresAt,
  };
}

/** Renouvellement d'un jeton OAuth (2 h chez GitLab) ; GitLab remet un nouveau jeton de renouvellement à chaque fois. */
async function refreshRequest(host: string, clientId: string, refreshToken: string): Promise<GitlabTokenResponse> {
  const params: Record<string, string> = { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken };
  const secret = process.env.GITLAB_CLIENT_SECRET?.trim();
  if (secret) params.client_secret = secret;
  const res = await gitlabFetch(host, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = (await res.json().catch(() => ({}))) as GitlabTokenResponse;
  if (!res.ok || data.error || !data.access_token) throw new AppError(`GitLab : ${data.error_description ?? data.error ?? `renouvellement impossible (${res.status})`}`);
  return data;
}

/**
 * Jeton en clair d'un compte, lu dans son élément du coffre (la personne doit encore pouvoir l'utiliser),
 * renouvelé d'abord s'il expire bientôt. Null s'il est inutilisable ou plus renouvelable.
 */
async function freshToken(a: GitlabAccountRecord, actor: Omit<VaultActor, 'userId'> = {}): Promise<string | null> {
  let used: Awaited<ReturnType<typeof vaultService.useToken>>;
  try {
    used = await vaultService.useToken(a.userId, a.vaultItemId, ['gitlab'], { ...actor, userId: a.userId, purpose: `Compte GitLab ${a.login}@${a.host}` });
  } catch (err) {
    log.warn(`[gitlab] jeton inutilisable pour ${a.login}@${a.host} : ${(err as Error).message}`);
    return null;
  }
  const { item, secrets } = used;
  const token = secrets.token;
  if (!a.tokenExpiresAt || a.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return token;
  const clientId = secrets.clientId;
  if (!secrets.refreshToken || !clientId) {
    if (a.tokenExpiresAt.getTime() <= Date.now()) log.warn(`[gitlab] jeton expiré pour ${a.login}@${a.host} : reconnexion nécessaire`);
    return a.tokenExpiresAt.getTime() > Date.now() ? token : null;
  }
  try {
    const t = await refreshRequest(a.host, clientId, secrets.refreshToken);
    const expiry = { tokenExpiresAt: inSeconds(t.expires_in), refreshTokenExpiresAt: null };
    await vaultService.refreshToken(item, { token: t.access_token!, refreshToken: t.refresh_token ?? secrets.refreshToken, clientId }, { tokenExpiresAt: expiry.tokenExpiresAt, refreshExpiresAt: null });
    await gitlabAccountRepository.updateExpiry(a.id, expiry);
    return t.access_token!;
  } catch (err) {
    log.warn(`[gitlab] renouvellement du jeton de ${a.login}@${a.host} impossible : ${(err as Error).message}`);
    return a.tokenExpiresAt.getTime() > Date.now() ? token : null;
  }
}

/** Compte d'un jeton obtenu par le device flow : le jeton va dans le coffre personnel de la personne. */
export async function storeGitlabOAuthAccount(userId: string, host: string, t: GitlabTokenResponse, clientId: string): Promise<GitlabAccount> {
  const info = await readGitlabAccount(host, t.access_token!);
  const previous = (await gitlabAccountRepository.listByUser(userId)).find((a) => a.host === host && a.login.toLowerCase() === info.login.toLowerCase());
  const tokenExpiresAt = inSeconds(t.expires_in);
  const item = await vaultService.storeOauthToken(userId, {
    service: 'gitlab',
    name: `gitlab-${info.login.toLowerCase()}${host === GITLAB_COM ? '' : `-${hostname(host).split('.')[0]}`}`,
    account: `${info.login}@${host}`,
    secrets: { token: t.access_token!, ...(t.refresh_token ? { refreshToken: t.refresh_token, clientId } : {}) },
    tokenExpiresAt,
    refreshExpiresAt: null,
    existingId: previous?.method === 'oauth' ? previous.vaultItemId : null,
  });
  const account = await gitlabAccountRepository.upsert(userId, {
    host,
    login: info.login,
    name: info.name,
    email: info.email,
    avatarUrl: info.avatarUrl,
    groups: info.groups,
    scopes: t.scope ? t.scope.split(/[ ,]+/).filter(Boolean) : info.scopes,
    method: 'oauth',
    vaultItemId: item.id,
    tokenExpiresAt,
    refreshTokenExpiresAt: null,
  });
  log.info(`[gitlab] compte ${account.login}@${host} connecté (code) pour ${userId}`);
  void refreshKnownGitlabHosts({ force: true });
  return toPublic(account);
}

/** Identifiants git transmis aux commandes et aux agents pour une instance GitLab. */
export interface GitlabGitAuth {
  host: string;
  token: string;
  name: string;
  email: string;
}

export const gitlabService = {
  /** Jeton d'accès personnel gardé dans un élément du coffre que la personne peut utiliser : vérifié auprès de l'instance, puis son compte connecté. */
  async connectFromVault(userId: string, itemId: string, hostInput?: string | null): Promise<GitlabAccount> {
    const host = normalizeGitlabHost(hostInput);
    if (!host) throw new AppError(`Adresse d'instance GitLab invalide : « ${hostInput} » (exemple : gitlab.exemple.fr)`);
    const { item, secrets } = await vaultService.useToken(userId, itemId, ['gitlab'], { userId, purpose: 'Connexion du compte GitLab' });
    const info = await readGitlabAccount(host, secrets.token);
    const account = await gitlabAccountRepository.upsert(userId, {
      host,
      login: info.login,
      name: info.name,
      email: info.email,
      avatarUrl: info.avatarUrl,
      groups: info.groups,
      scopes: info.scopes,
      method: 'pat',
      vaultItemId: item.id,
      tokenExpiresAt: info.expiresAt,
      refreshTokenExpiresAt: null,
    });
    log.info(`[gitlab] compte ${account.login}@${host} connecté (jeton du coffre) pour ${userId}`);
    void refreshKnownGitlabHosts({ force: true });
    return toPublic(account);
  },

  async accounts(userId: string): Promise<GitlabAccount[]> {
    return (await gitlabAccountRepository.listByUser(userId)).map(toPublic);
  },

  async status(userId: string, device: { available: boolean; host: string | null }): Promise<GitlabAuthStatus> {
    const accounts = await this.accounts(userId);
    return { connected: accounts.length > 0, accounts, deviceAvailable: device.available, deviceHost: device.host };
  },

  async setDefault(userId: string, accountId: string): Promise<void> {
    if (!(await gitlabAccountRepository.findById(userId, accountId))) throw new NotFoundError('Compte GitLab introuvable');
    await gitlabAccountRepository.setDefault(userId, accountId);
  },

  /** Oublie un compte (tous sans `accountId`). Le jeton obtenu par une connexion est retiré du coffre avec lui ; un jeton personnel y reste. */
  async disconnect(userId: string, accountId?: string | null): Promise<void> {
    const accounts = (await gitlabAccountRepository.listByUser(userId)).filter((a) => !accountId || a.id === accountId);
    if (accountId && !accounts.length) throw new NotFoundError('Compte GitLab introuvable');
    for (const a of accounts) {
      await gitlabAccountRepository.delete(userId, a.id);
      if (a.method === 'oauth') await vaultService.deleteOauthToken(userId, a.vaultItemId);
    }
  },

  /** Instances des comptes de la personne (pour reconnaître les URL de dépôts auto-hébergés). */
  async hosts(userId: string | null | undefined): Promise<string[]> {
    if (!userId) return [];
    return [...new Set((await gitlabAccountRepository.listByUser(userId)).map((a) => a.host))];
  },

  /** Jetons en clair de chaque compte de la personne (renouvelés si besoin), les inutilisables écartés ; `host` limite à une instance. */
  async credentials(userId: string | null | undefined, actor: Omit<VaultActor, 'userId'> = {}, host?: string | null): Promise<GitlabCredential[]> {
    if (!userId) return [];
    const out: GitlabCredential[] = [];
    for (const a of await gitlabAccountRepository.listByUser(userId)) {
      if (host && a.host !== host) continue;
      const token = await freshToken(a, actor);
      if (token) out.push({ host: a.host, login: a.login, name: a.name, email: a.email, token, owners: [a.login, ...a.groups].map((o) => o.toLowerCase()), isDefault: a.isDefault });
    }
    return out;
  },

  /**
   * Identifiants git d'une personne pour un dépôt GitLab : jeton du compte de l'instance du dépôt qui en possède
   * l'espace (sinon le compte par défaut de l'instance). Pour une URL qui n'est pas GitLab, le compte par défaut
   * (pour que les agents atteignent ses dépôts). Null sans compte utilisable.
   */
  async gitAuth(userId: string | null | undefined, repoUrl?: string | null, actor: Omit<VaultActor, 'userId'> = {}): Promise<GitlabGitAuth | null> {
    if (!userId) return null;
    const repo = gitlabRepoOf(repoUrl, await this.hosts(userId));
    const creds = await this.credentials(userId, actor, repo?.host ?? null);
    const main = pickCredential(creds, repo?.namespace);
    if (!main) return null;
    return { host: main.host, token: main.token, name: main.name || main.login, email: main.email ?? `${main.login}@users.noreply.${hostname(main.host)}` };
  },

  /**
   * Jeton d'API d'une personne pour un dépôt d'une instance : le compte de cette instance qui possède l'espace du
   * dépôt, sinon son compte par défaut sur l'instance. Null sans compte utilisable sur l'instance.
   */
  async apiToken(userId: string | null | undefined, host: string, namespace?: string | null): Promise<string | null> {
    return pickCredential(await this.credentials(userId, {}, host), namespace)?.token ?? null;
  },

  /** Arguments `-c` à ajouter aux commandes git pour authentifier les URL https d'un dépôt GitLab ; vides pour une autre URL ou sans compte. */
  async gitConfigArgs(userId: string | null | undefined, repoUrl?: string | null): Promise<string[]> {
    if (!userId || !gitlabRepoOf(repoUrl, await this.hosts(userId))) return [];
    const auth = await this.gitAuth(userId, repoUrl);
    if (!auth) return [];
    const basic = Buffer.from(`oauth2:${auth.token}`).toString('base64');
    return ['-c', `http.https://${auth.host}/.extraheader=AUTHORIZATION: basic ${basic}`];
  },

  /** Dépôts dont la personne est membre, sur toutes ses instances, les plus récemment actifs d'abord ; `query` cherche dans le nom et l'espace. */
  async listRepositories(userId: string, query?: string | null): Promise<GitlabRepository[]> {
    const creds = await this.credentials(userId);
    if (!creds.length) throw new AppError('GitLab non connecté : connectez un compte dans Paramètres → GitLab', 'GITLAB_NOT_CONNECTED');
    const q = query?.trim();
    const byName = new Map<string, GitlabRepository>();
    for (const cred of [...creds].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))) {
      for (let page = 1; page <= 3; page++) {
        const params = new URLSearchParams({ membership: 'true', order_by: 'last_activity_at', per_page: '100', page: String(page) });
        if (q) {
          params.set('search', q);
          params.set('search_namespaces', 'true');
        }
        let res: Response;
        try {
          res = await gitlabFetch(cred.host, `/api/v4/projects?${params}`, { token: cred.token });
        } catch (err) {
          log.warn(`[gitlab] dépôts indisponibles pour ${cred.login}@${cred.host} : ${(err as Error).message}`);
          break;
        }
        if (!res.ok) {
          log.warn(`[gitlab] dépôts indisponibles pour ${cred.login}@${cred.host} (${res.status})`);
          break;
        }
        const list = (await res.json()) as Array<{ path_with_namespace: string; name: string; namespace?: { full_path?: string }; description: string | null; visibility?: string; default_branch?: string | null; http_url_to_repo: string; web_url: string; last_activity_at?: string | null }>;
        for (const r of list) {
          const key = `${cred.host}/${r.path_with_namespace.toLowerCase()}`;
          if (byName.has(key)) continue;
          byName.set(key, {
            fullName: r.path_with_namespace,
            name: r.name,
            namespace: r.namespace?.full_path ?? r.path_with_namespace.split('/').slice(0, -1).join('/'),
            description: r.description || null,
            private: r.visibility !== 'public',
            defaultBranch: r.default_branch ?? null,
            cloneUrl: r.http_url_to_repo,
            htmlUrl: r.web_url,
            pushedAt: r.last_activity_at ? new Date(r.last_activity_at) : null,
            host: cred.host,
            account: cred.login,
          });
        }
        if (list.length < 100) break;
      }
    }
    return [...byName.values()].sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0));
  },
};
