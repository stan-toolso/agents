import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { API_KEY_SCOPES, type ApiKeyScope, type ProjectApiKey } from '../tasks/types.js';

/**
 * Clés d'API d'un projet pour l'API REST des tâches et le point d'entrée entrant : `skp_` suivi de 40 caractères ;
 * seul le hachage est conservé, le secret n'est montré qu'à la création. Supprimer une clé la révoque aussitôt.
 * Chaque clé a ses portées (API_KEY_SCOPES) et, en option, un secret de signature (`whs_…`, chiffré en base car il
 * faut le relire pour vérifier la signature HMAC) et un agent de triage par défaut.
 */

const PREFIX = 'skp_';
const SIGNING_PREFIX = 'whs_';
const MAX_KEYS = 20;
const LAST_USED_THROTTLE_MS = 60_000;
/** Portées d'une clé créée sans précision : l'API des tâches, comme avant les portées. */
export const DEFAULT_SCOPES: ApiKeyScope[] = ['tasks:read', 'tasks:write'];

interface Row {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  scopes: string[] | null;
  signed: boolean;
  triage_agent_id: string | null;
}
const COLUMNS = 'id, project_id, name, key_prefix, created_by, created_at, last_used_at, scopes, signing_secret IS NOT NULL AS signed, triage_agent_id';
const toKey = (r: Row): ProjectApiKey => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  prefix: r.key_prefix,
  createdById: r.created_by,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  scopes: (r.scopes ?? []).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s)),
  signed: !!r.signed,
  triageAgentId: r.triage_agent_id,
});

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const lastUsedWritten = new Map<string, number>();

/** Portées valides, dédoublonnées, dans l'ordre de référence ; refuse une portée inconnue ou une liste vide. */
export function normalizeScopes(scopes: readonly string[] | null | undefined): ApiKeyScope[] {
  if (scopes == null) return [...DEFAULT_SCOPES];
  for (const s of scopes) if (!(API_KEY_SCOPES as readonly string[]).includes(s)) throw new AppError(`Portée inconnue : ${s} (portées : ${API_KEY_SCOPES.join(', ')})`);
  const set = new Set(scopes);
  const out = API_KEY_SCOPES.filter((s) => set.has(s));
  if (!out.length) throw new AppError('Une clé doit avoir au moins une portée');
  return out;
}

export interface ApiKeyInput {
  name: string;
  scopes?: readonly string[] | null;
  triageAgentId?: string | null;
  /** Génère aussi un secret de signature (renvoyé une seule fois). */
  signed?: boolean;
}

export const apiKeyService = {
  async list(projectId: string): Promise<ProjectApiKey[]> {
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM project_api_keys WHERE project_id = $1 ORDER BY created_at`, [projectId]);
    return rows.map(toKey);
  },

  async get(id: string): Promise<ProjectApiKey> {
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM project_api_keys WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundError("Clé d'API introuvable");
    return toKey(rows[0]);
  },

  /** Crée une clé ; le secret complet (et le secret de signature demandé) ne sont renvoyés que cette fois. */
  async create(projectId: string, input: ApiKeyInput | string, createdBy: string): Promise<{ key: ProjectApiKey; secret: string; signingSecret: string | null }> {
    const opts: ApiKeyInput = typeof input === 'string' ? { name: input } : input;
    const label = opts.name.trim();
    if (!label) throw new AppError('Le nom de la clé est obligatoire');
    if (label.length > 100) throw new AppError('Le nom de la clé dépasse 100 caractères');
    const scopes = normalizeScopes(opts.scopes);
    if ((await this.list(projectId)).length >= MAX_KEYS) throw new AppError(`Au plus ${MAX_KEYS} clés d'API par projet`);
    const secret = `${PREFIX}${randomBytes(30).toString('base64url')}`;
    const signingSecret = opts.signed ? `${SIGNING_PREFIX}${randomBytes(30).toString('base64url')}` : null;
    const { rows } = await pool.query<Row>(
      `INSERT INTO project_api_keys (project_id, name, key_prefix, key_hash, created_by, scopes, signing_secret, triage_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [projectId, label, secret.slice(0, PREFIX.length + 8), hash(secret), createdBy, scopes, signingSecret ? encryptSecret(signingSecret) : null, opts.triageAgentId ?? null],
    );
    return { key: toKey(rows[0]), secret, signingSecret };
  },

  /** Modifie le nom, les portées ou l'agent de triage d'une clé (le secret ne change pas). */
  async update(id: string, input: { name?: string | null; scopes?: readonly string[] | null; triageAgentId?: string | null }): Promise<ProjectApiKey> {
    const key = await this.get(id);
    const name = input.name != null ? input.name.trim() : key.name;
    if (!name) throw new AppError('Le nom de la clé est obligatoire');
    if (name.length > 100) throw new AppError('Le nom de la clé dépasse 100 caractères');
    const scopes = input.scopes != null ? normalizeScopes(input.scopes) : key.scopes;
    const triage = input.triageAgentId !== undefined ? input.triageAgentId || null : key.triageAgentId;
    const { rows } = await pool.query<Row>(`UPDATE project_api_keys SET name = $2, scopes = $3, triage_agent_id = $4 WHERE id = $1 RETURNING ${COLUMNS}`, [id, name, scopes, triage]);
    return toKey(rows[0]);
  },

  /** Génère (ou remplace) le secret de signature d'une clé, renvoyé cette seule fois ; `false` le retire. */
  async setSigning(id: string, enabled: boolean): Promise<{ key: ProjectApiKey; signingSecret: string | null }> {
    await this.get(id);
    const signingSecret = enabled ? `${SIGNING_PREFIX}${randomBytes(30).toString('base64url')}` : null;
    const { rows } = await pool.query<Row>(`UPDATE project_api_keys SET signing_secret = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, signingSecret ? encryptSecret(signingSecret) : null]);
    return { key: toKey(rows[0]), signingSecret };
  },

  /** Secret de signature en clair (vérification HMAC), null si la clé n'en a pas. */
  async signingSecret(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ signing_secret: string | null }>('SELECT signing_secret FROM project_api_keys WHERE id = $1', [id]);
    return rows[0]?.signing_secret ? decryptSecret(rows[0].signing_secret) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_api_keys WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Clé correspondant à un secret, ou null ; la dernière utilisation est notée au plus une fois par minute. */
  async authenticate(secret: string): Promise<ProjectApiKey | null> {
    if (!secret.startsWith(PREFIX)) return null;
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM project_api_keys WHERE key_hash = $1`, [hash(secret)]);
    if (!rows[0]) return null;
    const key = toKey(rows[0]);
    const now = Date.now();
    if (now - (lastUsedWritten.get(key.id) ?? 0) > LAST_USED_THROTTLE_MS) {
      lastUsedWritten.set(key.id, now);
      void pool.query('UPDATE project_api_keys SET last_used_at = now() WHERE id = $1', [key.id]).catch(() => undefined);
    }
    return key;
  },
};
