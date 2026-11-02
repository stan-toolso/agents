import { pool } from '../db/pool.js';

/** Compte GitLab connecté par une personne (`user_gitlab_accounts`) ; son jeton vit dans l'élément du coffre `vaultItemId`. */
export interface GitlabAccountRecord {
  id: string;
  userId: string;
  /** Instance (nom d'hôte, éventuellement avec port), jointe en https. */
  host: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  method: 'oauth' | 'pat';
  vaultItemId: string;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  groups: string[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitlabAccountInput {
  host: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  method: 'oauth' | 'pat';
  /** Élément du coffre (jeton applicatif 'gitlab') qui détient le jeton. */
  vaultItemId: string;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  groups: string[];
}

interface Row {
  id: string;
  user_id: string;
  host: string;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  method: 'oauth' | 'pat';
  vault_item_id: string;
  token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
  scopes: string[];
  groups: string[];
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const toAccount = (r: Row): GitlabAccountRecord => ({
  id: r.id,
  userId: r.user_id,
  host: r.host,
  login: r.login,
  name: r.name,
  email: r.email,
  avatarUrl: r.avatar_url,
  method: r.method,
  vaultItemId: r.vault_item_id,
  tokenExpiresAt: r.token_expires_at,
  refreshTokenExpiresAt: r.refresh_token_expires_at,
  scopes: r.scopes ?? [],
  groups: r.groups ?? [],
  isDefault: r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const gitlabAccountRepository = {
  /** Instances où au moins une personne a connecté un compte (pour reconnaître les dépôts auto-hébergés des projets). */
  async allHosts(): Promise<string[]> {
    const { rows } = await pool.query<{ host: string }>("SELECT DISTINCT host FROM user_gitlab_accounts ORDER BY host");
    return rows.map((r) => r.host);
  },

  async listByUser(userId: string): Promise<GitlabAccountRecord[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM user_gitlab_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at, host, login', [userId]);
    return rows.map(toAccount);
  },

  async findById(userId: string, id: string): Promise<GitlabAccountRecord | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM user_gitlab_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    return rows[0] ? toAccount(rows[0]) : null;
  },

  /** Crée le compte, ou remplace le jeton du même identifiant sur la même instance (reconnexion). Le premier compte d'une personne devient son compte par défaut. */
  async upsert(userId: string, input: GitlabAccountInput): Promise<GitlabAccountRecord> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO user_gitlab_accounts (user_id, host, login, name, email, avatar_url, method, vault_item_id, token_expires_at, refresh_token_expires_at, scopes, groups, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOT EXISTS (SELECT 1 FROM user_gitlab_accounts WHERE user_id = $1))
       ON CONFLICT (user_id, host, lower(login)) DO UPDATE SET
         login = EXCLUDED.login, name = EXCLUDED.name, email = EXCLUDED.email, avatar_url = EXCLUDED.avatar_url, method = EXCLUDED.method,
         vault_item_id = EXCLUDED.vault_item_id, token_expires_at = EXCLUDED.token_expires_at, refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         scopes = EXCLUDED.scopes, groups = EXCLUDED.groups, updated_at = now()
       RETURNING *`,
      [userId, input.host, input.login, input.name, input.email, input.avatarUrl, input.method, input.vaultItemId, input.tokenExpiresAt, input.refreshTokenExpiresAt, input.scopes, input.groups],
    );
    return toAccount(rows[0]);
  },

  /** Expiration du nouveau couple de jetons après un renouvellement (les jetons eux-mêmes sont dans le coffre). */
  async updateExpiry(id: string, t: Pick<GitlabAccountInput, 'tokenExpiresAt' | 'refreshTokenExpiresAt'>): Promise<void> {
    await pool.query('UPDATE user_gitlab_accounts SET token_expires_at = $2, refresh_token_expires_at = $3, updated_at = now() WHERE id = $1', [id, t.tokenExpiresAt, t.refreshTokenExpiresAt]);
  },

  async setDefault(userId: string, id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE user_gitlab_accounts SET is_default = false WHERE user_id = $1 AND is_default AND id <> $2', [userId, id]);
      await client.query('UPDATE user_gitlab_accounts SET is_default = true, updated_at = now() WHERE user_id = $1 AND id = $2', [userId, id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Retire le compte ; s'il était le compte par défaut, le plus ancien restant prend le relais. */
  async delete(userId: string, id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_gitlab_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
      await client.query(
        `UPDATE user_gitlab_accounts SET is_default = true
         WHERE id = (SELECT id FROM user_gitlab_accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM user_gitlab_accounts WHERE user_id = $1 AND is_default)`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
