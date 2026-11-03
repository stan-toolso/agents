import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';

/** Lien public de lecture d'une session (`/share/<token>`), valable jusqu'à `expiresAt`. */
export interface SessionShare {
  id: string;
  sessionId: string;
  token: string;
  expiresAt: Date;
  createdById: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  session_id: string;
  token: string;
  expires_at: Date;
  created_by: string | null;
  created_at: Date;
}
const toShare = (r: Row): SessionShare => ({ id: r.id, sessionId: r.session_id, token: r.token, expiresAt: r.expires_at, createdById: r.created_by, createdAt: r.created_at });

/** Durées proposées (jours) ; au-delà d'un mois, on recrée un lien. */
export const SHARE_MAX_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

/** Jeton du lien : 32 octets aléatoires en base64url (43 caractères), impossible à deviner. */
export const newShareToken = (): string => randomBytes(32).toString('base64url');
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const sessionShareService = {
  async create(sessionId: string, createdById: string, expiresInDays: number, now = new Date()): Promise<SessionShare> {
    if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > SHARE_MAX_DAYS) {
      throw new AppError(`La durée d'un lien de partage va de quelques heures à ${SHARE_MAX_DAYS} jours`);
    }
    const expiresAt = new Date(now.getTime() + expiresInDays * DAY_MS);
    const { rows } = await pool.query<Row>('INSERT INTO session_shares (session_id, token, expires_at, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [sessionId, newShareToken(), expiresAt, createdById]);
    return toShare(rows[0]);
  },

  /** Liens encore valables d'une session, les plus récents d'abord (les liens expirés sont supprimés au passage). */
  async listActive(sessionId: string): Promise<SessionShare[]> {
    await pool.query('DELETE FROM session_shares WHERE session_id = $1 AND expires_at <= now()', [sessionId]);
    const { rows } = await pool.query<Row>('SELECT * FROM session_shares WHERE session_id = $1 ORDER BY created_at DESC', [sessionId]);
    return rows.map(toShare);
  },

  async get(id: string): Promise<SessionShare> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_shares WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundError('Lien de partage introuvable');
    return toShare(rows[0]);
  },

  /** Révoque le lien : il est supprimé, l'URL renvoie 404. */
  async revoke(id: string): Promise<void> {
    await pool.query('DELETE FROM session_shares WHERE id = $1', [id]);
  },

  /** Lien valable portant ce jeton, ou null (inconnu, révoqué ou expiré). */
  async resolve(token: string): Promise<SessionShare | null> {
    if (!SHARE_TOKEN_RE.test(token)) return null;
    const { rows } = await pool.query<Row>('SELECT * FROM session_shares WHERE token = $1 AND expires_at > now()', [token]);
    return rows[0] ? toShare(rows[0]) : null;
  },
};
