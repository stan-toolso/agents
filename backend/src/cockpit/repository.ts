import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Layout, LayoutVersion, Scope } from './types.js';

export interface LayoutRow {
  id: string;
  scope: string;
  user_id: string | null;
  project_id: string | null;
  layout: Layout | null;
  version: number;
  updated_by: string | null;
  updated_at: Date;
}

interface VersionRow {
  version: number;
  layout: Layout;
  reset: boolean;
  author_id: string | null;
  session_id: string | null;
  note: string | null;
  created_at: Date;
}
const toVersion = (r: VersionRow): LayoutVersion => ({ version: r.version, layout: r.layout, reset: r.reset, authorId: r.author_id, sessionId: r.session_id, note: r.note, createdAt: r.created_at });

/** Clé de ligne d'une portée : « home » est propre à chaque personne, les autres portées sont partagées. */
const userKey = (scope: Scope, userId: string) => (scope.kind === 'home' ? userId : null);

export interface SaveInput {
  scope: Scope;
  userId: string;
  /** null : réinitialisation (l'agencement par défaut redevient actif ; `snapshot` est ce défaut, gardé dans l'historique). */
  layout: Layout | null;
  snapshot: Layout;
  authorId: string | null;
  sessionId: string | null;
  note: string | null;
}

export const cockpitRepository = {
  async find(scope: Scope, userId: string): Promise<LayoutRow | null> {
    const uk = userKey(scope, userId);
    const { rows } = await pool.query<LayoutRow>(uk ? 'SELECT * FROM cockpit_layouts WHERE scope = $1 AND user_id = $2' : 'SELECT * FROM cockpit_layouts WHERE scope = $1 AND user_id IS NULL', uk ? [scope.key, uk] : [scope.key]);
    return rows[0] ?? null;
  },

  /** Enregistre une nouvelle version (transaction : ligne de la portée + version figée). */
  async save(input: SaveInput): Promise<LayoutRow> {
    const uk = userKey(input.scope, input.userId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const layoutJson = input.layout === null ? null : toJson(input.layout);
      const existing = await client.query<{ id: string }>('SELECT id FROM cockpit_layouts WHERE scope = $1 AND user_id IS NOT DISTINCT FROM $2 FOR UPDATE', [input.scope.key, uk]);
      const { rows } = existing.rows[0]
        ? await client.query<LayoutRow>('UPDATE cockpit_layouts SET layout = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *', [existing.rows[0].id, layoutJson, input.authorId])
        : await client.query<LayoutRow>('INSERT INTO cockpit_layouts (scope, user_id, project_id, layout, version, updated_by) VALUES ($1, $2, $3, $4::jsonb, 1, $5) RETURNING *', [input.scope.key, uk, input.scope.projectId, layoutJson, input.authorId]);
      const row = rows[0];
      await client.query(
        `INSERT INTO cockpit_layout_versions (layout_id, version, layout, reset, author_id, session_id, note) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
        [row.id, row.version, toJson(input.snapshot), input.layout === null, input.authorId, input.sessionId, input.note],
      );
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async history(layoutId: string, limit = 50): Promise<LayoutVersion[]> {
    const { rows } = await pool.query<VersionRow>('SELECT version, layout, reset, author_id, session_id, note, created_at FROM cockpit_layout_versions WHERE layout_id = $1 ORDER BY version DESC LIMIT $2', [layoutId, limit]);
    return rows.map(toVersion);
  },

  async version(layoutId: string, version: number): Promise<LayoutVersion | null> {
    const { rows } = await pool.query<VersionRow>('SELECT version, layout, reset, author_id, session_id, note, created_at FROM cockpit_layout_versions WHERE layout_id = $1 AND version = $2', [layoutId, version]);
    return rows[0] ? toVersion(rows[0]) : null;
  },
};
