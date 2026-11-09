import { pool } from '../db/pool.js';
import type { OpenItems, ProjectMember, ProjectRole, User, UserIdentity, UserKind } from './types.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  avatar_url: string | null;
  google_sub: string | null;
  is_admin: boolean;
  is_super_admin: boolean;
  is_cto?: boolean | null;
  guest?: boolean | null;
  created_at: Date;
  last_login_at: Date | null;
  password_set_at?: Date | null;
}

interface IdentityRow {
  provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

const toIdentity = (r: IdentityRow): UserIdentity => ({ provider: r.provider, subject: r.subject, userId: r.user_id, email: r.email, createdAt: r.created_at, lastUsedAt: r.last_used_at });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: string[] | null | undefined) => [...new Set((ids ?? []).map((s) => s.toLowerCase()).filter((s) => UUID_RE.test(s)))];

interface MemberRow {
  project_id: string;
  user_id: string;
  role: ProjectRole;
  invited_by: string | null;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  kind: r.kind ?? 'person',
  avatarUrl: r.avatar_url,
  googleSub: r.google_sub,
  isAdmin: r.is_admin,
  isSuperAdmin: Boolean(r.is_super_admin),
  isCto: Boolean(r.is_cto),
  isGuest: Boolean(r.guest),
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
  passwordSetAt: r.password_set_at ?? null,
});

const toMember = (r: MemberRow): ProjectMember => ({
  projectId: r.project_id,
  userId: r.user_id,
  role: r.role,
  invitedById: r.invited_by,
  createdAt: r.created_at,
});

export const userRepository = {
  async findById(id: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  /** Utilisateurs de ces identifiants (chargement groupé par requête GraphQL), sans ordre garanti. */
  async findByIds(ids: string[]): Promise<User[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toUser);
  },

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async findByGoogleSub(sub: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE google_sub = $1', [sub]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  /**
   * Crée un utilisateur « invité » (pas encore connecté), un invité des pages partagées (`guest`, sans aucun autre
   * droit), ou un agent de projet (`kind: 'agent'`, identifiant imposé).
   */
  async create(input: { id?: string | null; email: string; name: string; isAdmin?: boolean; kind?: UserKind | null; guest?: boolean }): Promise<User> {
    const { rows } = await pool.query<UserRow>(
      'INSERT INTO users (id, email, name, is_admin, kind, guest) VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6) RETURNING *',
      [input.id ?? null, input.email.toLowerCase(), input.name, Boolean(input.isAdmin), input.kind ?? 'person', Boolean(input.guest)],
    );
    return toUser(rows[0]);
  },

  async rename(id: string, name: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('UPDATE users SET name = $2 WHERE id = $1 RETURNING *', [id, name]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async setAdmin(id: string, isAdmin: boolean): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING *', [id, isAdmin]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  /** Un super administrateur est toujours administrateur. */
  async setSuperAdmin(id: string, isSuperAdmin: boolean): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('UPDATE users SET is_super_admin = $2, is_admin = CASE WHEN $2 THEN true ELSE is_admin END WHERE id = $1 RETURNING *', [id, isSuperAdmin]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  /** Profil CTO : interventions comptées en temps facturé (billing/ctoTime.ts). */
  async setCto(id: string, isCto: boolean): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('UPDATE users SET is_cto = $2 WHERE id = $1 RETURNING *', [id, isCto]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async countAppAdmins(): Promise<{ admins: number; superAdmins: number }> {
    const { rows } = await pool.query<{ a: string; s: string }>('SELECT count(*) FILTER (WHERE is_admin)::text AS a, count(*) FILTER (WHERE is_super_admin)::text AS s FROM users');
    return { admins: Number(rows[0].a), superAdmins: Number(rows[0].s) };
  },

  /** Projets qui contiennent les éléments donnés (onglets ouverts d'un super administrateur). */
  async projectIdsHolding(open: OpenItems): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = ANY($1::uuid[])
       UNION SELECT project_id FROM worksessions WHERE id = ANY($2::uuid[])
       UNION SELECT project_id FROM sessions WHERE id = ANY($3::uuid[])
       UNION SELECT project_id FROM terminals WHERE id = ANY($4::uuid[])
       UNION SELECT project_id FROM tasks WHERE id = ANY($5::uuid[])`,
      [uuids(open.projectIds), uuids(open.worksessionIds), uuids(open.sessionIds), uuids(open.terminalIds), uuids(open.taskIds)],
    );
    return rows.map((r) => r.id);
  },

  /** Personnes partageant au moins un projet avec la personne (candidats au partage) ; les agents n'en sont pas. */
  async listColleagues(userId: string): Promise<User[]> {
    const { rows } = await pool.query<UserRow>(
      `SELECT DISTINCT u.* FROM users u JOIN project_members m ON m.user_id = u.id
       WHERE u.id <> $1 AND u.kind = 'person' AND m.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1) ORDER BY u.email`,
      [userId],
    );
    return rows.map(toUser);
  },

  /** À chaque connexion : relie le compte Google et rafraîchit nom et avatar. */
  async recordLogin(id: string, input: { googleSub: string; name?: string | null; avatarUrl?: string | null }): Promise<User> {
    const { rows } = await pool.query<UserRow>(
      `UPDATE users SET google_sub = $2, name = COALESCE($3, name), avatar_url = COALESCE($4, avatar_url), last_login_at = now()
       WHERE id = $1 RETURNING *`,
      [id, input.googleSub, input.name || null, input.avatarUrl || null],
    );
    return toUser(rows[0]);
  },

  /** Connexion sans Google (mot de passe, Microsoft, GitHub) : date de connexion, et nom ou avatar s'ils manquaient. */
  async touchLogin(id: string, input: { name?: string | null; avatarUrl?: string | null } = {}): Promise<User> {
    const { rows } = await pool.query<UserRow>(
      `UPDATE users SET name = CASE WHEN last_login_at IS NULL AND $2::text IS NOT NULL THEN $2 ELSE name END,
         avatar_url = COALESCE(avatar_url, $3), last_login_at = now()
       WHERE id = $1 RETURNING *`,
      [id, input.name || null, input.avatarUrl || null],
    );
    return toUser(rows[0]);
  },

  // ---- Mot de passe --------------------------------------------------------------------------

  async passwordHash(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [id]);
    return rows[0]?.password_hash ?? null;
  },

  /** Enregistre (ou retire, avec null) l'empreinte du mot de passe. */
  async setPasswordHash(id: string, hash: string | null): Promise<User> {
    const { rows } = await pool.query<UserRow>(
      'UPDATE users SET password_hash = $2, password_set_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1 RETURNING *',
      [id, hash],
    );
    return toUser(rows[0]);
  },

  async createPasswordToken(tokenHash: string, userId: string, expiresAt: Date, createdById: string | null): Promise<void> {
    await pool.query('INSERT INTO password_tokens (token_hash, user_id, expires_at, created_by) VALUES ($1, $2, $3, $4)', [tokenHash, userId, expiresAt, createdById]);
  },

  /** Utilisateur d'un lien valide (ni expiré ni utilisé), ou null. */
  async findPasswordTokenUser(tokenHash: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>(
      `SELECT u.* FROM password_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ? toUser(rows[0]) : null;
  },

  /** Marque le lien utilisé ; faux s'il ne l'était plus (déjà utilisé, expiré). */
  async consumePasswordToken(tokenHash: string): Promise<boolean> {
    const { rowCount } = await pool.query('UPDATE password_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [tokenHash]);
    return (rowCount ?? 0) > 0;
  },

  /** Rend caducs tous les liens encore ouverts d'une personne. */
  async revokePasswordTokens(userId: string): Promise<void> {
    await pool.query('UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  },

  /** Date du dernier lien demandé par « mot de passe oublié » (anti-rafale). */
  async lastSelfServiceTokenAt(userId: string): Promise<Date | null> {
    const { rows } = await pool.query<{ at: Date | null }>('SELECT max(created_at) AS at FROM password_tokens WHERE user_id = $1 AND created_by IS NULL', [userId]);
    return rows[0]?.at ?? null;
  },

  async deleteExpiredPasswordTokens(): Promise<number> {
    const { rowCount } = await pool.query(`DELETE FROM password_tokens WHERE expires_at <= now() - interval '7 days'`);
    const links = await pool.query(`DELETE FROM login_links WHERE expires_at <= now() - interval '30 days'`);
    return (rowCount ?? 0) + (links.rowCount ?? 0);
  },

  // ---- Liens de connexion directe (invités des pages partagées) -------------------------------

  async createLoginLink(tokenHash: string, userId: string, nextPath: string, expiresAt: Date, createdById: string | null): Promise<void> {
    await pool.query('INSERT INTO login_links (token_hash, user_id, next_path, expires_at, created_by) VALUES ($1, $2, $3, $4, $5)', [tokenHash, userId, nextPath, expiresAt, createdById]);
  },

  /** Lien encore valable, ou null ; un lien expiré donne seulement son chemin (pour proposer d'en recevoir un autre). */
  async findLoginLink(tokenHash: string): Promise<{ user: User; nextPath: string; expired: boolean } | null> {
    const { rows } = await pool.query<UserRow & { link_next_path: string; link_expired: boolean }>(
      `SELECT u.*, l.next_path AS link_next_path, (l.expires_at <= now()) AS link_expired FROM login_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { user: toUser(row), nextPath: row.link_next_path, expired: row.link_expired } : null;
  },

  async touchLoginLink(tokenHash: string): Promise<void> {
    await pool.query('UPDATE login_links SET last_used_at = now() WHERE token_hash = $1', [tokenHash]);
  },

  /** Date du dernier lien demandé par l'invité lui-même (anti-rafale). */
  async lastSelfServiceLoginLinkAt(userId: string): Promise<Date | null> {
    const { rows } = await pool.query<{ at: Date | null }>('SELECT max(created_at) AS at FROM login_links WHERE user_id = $1 AND created_by IS NULL', [userId]);
    return rows[0]?.at ?? null;
  },

  // ---- Comptes externes (Microsoft, GitHub) ---------------------------------------------------

  async findIdentity(provider: string, subject: string): Promise<UserIdentity | null> {
    const { rows } = await pool.query<IdentityRow>('SELECT * FROM user_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
    return rows[0] ? toIdentity(rows[0]) : null;
  },

  async listIdentities(userId: string): Promise<UserIdentity[]> {
    const { rows } = await pool.query<IdentityRow>('SELECT * FROM user_identities WHERE user_id = $1 ORDER BY provider, created_at', [userId]);
    return rows.map(toIdentity);
  },

  /** Relie un compte externe à la personne ; un seul compte par fournisseur (le précédent est remplacé). */
  async linkIdentity(input: { provider: string; subject: string; userId: string; email: string | null }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_identities WHERE user_id = $1 AND provider = $2 AND subject <> $3', [input.userId, input.provider, input.subject]);
      await client.query(
        `INSERT INTO user_identities (provider, subject, user_id, email, last_used_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (provider, subject) DO UPDATE SET email = COALESCE(EXCLUDED.email, user_identities.email), last_used_at = now()
         WHERE user_identities.user_id = EXCLUDED.user_id`,
        [input.provider, input.subject, input.userId, input.email],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },

  async unlinkIdentity(userId: string, provider: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM user_identities WHERE user_id = $1 AND provider = $2', [userId, provider]);
    return (rowCount ?? 0) > 0;
  },

  async unlinkGoogle(userId: string): Promise<User> {
    const { rows } = await pool.query<UserRow>('UPDATE users SET google_sub = NULL WHERE id = $1 RETURNING *', [userId]);
    return toUser(rows[0]);
  },

  /** Ferme toutes les sessions de connexion d'une personne, sauf éventuellement une. */
  async deleteUserSessions(userId: string, exceptTokenHash: string | null = null): Promise<void> {
    await pool.query('DELETE FROM user_sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)', [userId, exceptTokenHash]);
  },

  /** Personnes (les agents de projet ne sont pas des comptes à administrer). */
  async list(): Promise<User[]> {
    const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE kind = 'person' ORDER BY name ASC, email ASC`);
    return rows.map(toUser);
  },

  // ---- Appartenance aux projets ------------------------------------------------------------

  async findMembership(projectId: string, userId: string): Promise<ProjectMember | null> {
    const { rows } = await pool.query<MemberRow>('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return rows[0] ? toMember(rows[0]) : null;
  },

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const { rows } = await pool.query<MemberRow>(
      `SELECT m.* FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.role ASC, u.name ASC`,
      [projectId],
    );
    return rows.map(toMember);
  },

  /** Identifiants des projets auxquels l'utilisateur appartient. */
  async projectIdsForUser(userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ project_id: string }>('SELECT project_id FROM project_members WHERE user_id = $1', [userId]);
    return rows.map((r) => r.project_id);
  },

  /** Ajoute ou met à jour une appartenance ; un invité des pages partagées qui entre dans un projet devient une personne ordinaire. */
  async upsertMembership(input: { projectId: string; userId: string; role: ProjectRole; invitedById?: string | null }): Promise<ProjectMember> {
    await this.clearGuest(input.userId);
    const { rows } = await pool.query<MemberRow>(
      `INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING *`,
      [input.projectId, input.userId, input.role, input.invitedById ?? null],
    );
    return toMember(rows[0]);
  },

  /** L'invité des pages partagées devient une personne ordinaire (invitation sur un projet ou dans l'application). */
  async clearGuest(id: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('UPDATE users SET guest = false WHERE id = $1 AND guest RETURNING *', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async removeMembership(projectId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return (rowCount ?? 0) > 0;
  },

  async countAdmins(projectId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM project_members WHERE project_id = $1 AND role = 'admin'`, [projectId]);
    return Number(rows[0].n);
  },

  // ---- Sessions de connexion -----------------------------------------------------------------

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await pool.query('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
  },

  /** Renvoie l'utilisateur d'une session valide (non expirée), ou null. */
  async findSessionUser(tokenHash: string): Promise<{ user: User; lastSeenAt: Date } | null> {
    const { rows } = await pool.query<UserRow & { last_seen_at: Date }>(
      `SELECT u.*, s.last_seen_at FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ? { user: toUser(rows[0]), lastSeenAt: rows[0].last_seen_at } : null;
  },

  async touchSession(tokenHash: string, expiresAt: Date): Promise<void> {
    await pool.query('UPDATE user_sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1', [tokenHash, expiresAt]);
  },

  async deleteSession(tokenHash: string): Promise<void> {
    await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
  },

  async deleteExpiredSessions(): Promise<number> {
    const { rowCount } = await pool.query('DELETE FROM user_sessions WHERE expires_at <= now()');
    return rowCount ?? 0;
  },
};
