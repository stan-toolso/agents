import { pool } from '../db/pool.js';
import type { AgentHandoff, SharedPage, SharedPageMember, SharedPageVersion } from './types.js';

interface Row {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  link_access: boolean;
  version: number;
  project_id: string | null;
  session_id: string | null;
  source_path: string | null;
  agent_handoff: AgentHandoff;
  history_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}
const toPage = (r: Row): SharedPage => ({
  id: r.id,
  ownerId: r.owner_id,
  title: r.title,
  description: r.description,
  linkAccess: r.link_access,
  version: r.version,
  projectId: r.project_id,
  sessionId: r.session_id,
  sourcePath: r.source_path,
  agentHandoff: r.agent_handoff ?? 'manual',
  historyEnabled: r.history_enabled ?? true,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface VersionRow {
  page_id: string;
  version: number;
  size: number;
  created_by: string | null;
  session_id: string | null;
  created_at: Date;
}
const toVersion = (r: VersionRow): SharedPageVersion => ({ pageId: r.page_id, version: r.version, size: r.size, createdById: r.created_by, sessionId: r.session_id, createdAt: r.created_at });

interface MemberRow {
  page_id: string;
  user_id: string;
  added_by: string | null;
  message: string | null;
  created_at: Date;
}
const toMember = (r: MemberRow): SharedPageMember => ({ pageId: r.page_id, userId: r.user_id, addedById: r.added_by, message: r.message ?? null, createdAt: r.created_at });

export const sharedPageRepository = {
  async findById(id: string): Promise<SharedPage | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_pages WHERE id = $1', [id]);
    return rows[0] ? toPage(rows[0]) : null;
  },

  /** Pages possédées par la personne ou partagées avec elle, les plus récemment mises à jour d'abord. */
  async listFor(userId: string): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>(
      `SELECT p.* FROM shared_pages p WHERE p.owner_id = $1 OR EXISTS (SELECT 1 FROM shared_page_members m WHERE m.page_id = p.id AND m.user_id = $1) ORDER BY p.updated_at DESC`,
      [userId],
    );
    return rows.map(toPage);
  },

  async listOwned(userId: string, limit: number): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_pages WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2', [userId, limit]);
    return rows.map(toPage);
  },

  /** Crée la page et sa première version dans une même transaction. */
  async create(input: { ownerId: string; title: string; description: string | null; linkAccess: boolean; projectId: string | null; sessionId: string | null; sourcePath: string | null; html: Buffer }): Promise<SharedPage> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `INSERT INTO shared_pages (owner_id, title, description, link_access, project_id, session_id, source_path) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [input.ownerId, input.title, input.description, input.linkAccess, input.projectId, input.sessionId, input.sourcePath],
      );
      await client.query('INSERT INTO shared_page_versions (page_id, version, html, size, created_by, session_id) VALUES ($1, 1, $2, $3, $4, $5)', [rows[0].id, input.html, input.html.length, input.ownerId, input.sessionId]);
      await client.query('COMMIT');
      return toPage(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Nouvelle version (la ligne est verrouillée : deux publications concurrentes se suivent). */
  async addVersion(pageId: string, input: { title: string; description: string | null | undefined; linkAccess: boolean | null; projectId: string | null; sessionId: string | null; sourcePath: string | null; html: Buffer; createdBy: string }): Promise<SharedPage | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `UPDATE shared_pages SET version = version + 1, title = $2, description = COALESCE($3, description), link_access = COALESCE($4, link_access),
                project_id = COALESCE($5, project_id), session_id = $6, source_path = $7, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [pageId, input.title, input.description ?? null, input.linkAccess, input.projectId, input.sessionId, input.sourcePath],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('INSERT INTO shared_page_versions (page_id, version, html, size, created_by, session_id) VALUES ($1, $2, $3, $4, $5, $6)', [pageId, rows[0].version, input.html, input.html.length, input.createdBy, input.sessionId]);
      await client.query('COMMIT');
      return toPage(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async update(id: string, patch: { title?: string; description?: string | null; linkAccess?: boolean; agentHandoff?: AgentHandoff; historyEnabled?: boolean }): Promise<SharedPage | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (patch.title !== undefined) sets.push(`title = $${params.push(patch.title)}`);
    if (patch.description !== undefined) sets.push(`description = $${params.push(patch.description)}`);
    if (patch.linkAccess !== undefined) sets.push(`link_access = $${params.push(patch.linkAccess)}`);
    if (patch.agentHandoff !== undefined) sets.push(`agent_handoff = $${params.push(patch.agentHandoff)}`);
    if (patch.historyEnabled !== undefined) sets.push(`history_enabled = $${params.push(patch.historyEnabled)}`);
    const { rows } = await pool.query<Row>(`UPDATE shared_pages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toPage(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM shared_pages WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async content(pageId: string, version: number): Promise<Buffer | null> {
    const { rows } = await pool.query<{ html: Buffer }>('SELECT html FROM shared_page_versions WHERE page_id = $1 AND version = $2', [pageId, version]);
    return rows[0]?.html ?? null;
  },

  async versions(pageId: string): Promise<SharedPageVersion[]> {
    const { rows } = await pool.query<VersionRow>('SELECT page_id, version, size, created_by, session_id, created_at FROM shared_page_versions WHERE page_id = $1 ORDER BY version DESC', [pageId]);
    return rows.map(toVersion);
  },

  async members(pageId: string): Promise<SharedPageMember[]> {
    const { rows } = await pool.query<MemberRow>('SELECT * FROM shared_page_members WHERE page_id = $1 ORDER BY created_at', [pageId]);
    return rows.map(toMember);
  },

  /**
   * Pages publiées par chacune des sessions (au moins une version publiée depuis elle : une page republiée par une autre
   * session reste aussi celle de la première) et que `viewerId` peut voir (propriétaire, membre, ou lien ouvert ; un invité
   * des pages ne voit jamais de session). Par session, les plus récemment mises à jour d'abord.
   */
  async listForSessions(sessionIds: string[], viewerId: string): Promise<Map<string, SharedPage[]>> {
    const out = new Map<string, SharedPage[]>();
    if (!sessionIds.length) return out;
    const { rows } = await pool.query<Row & { by_session: string }>(
      `SELECT p.*, s.by_session FROM shared_pages p
         JOIN (SELECT DISTINCT page_id, session_id AS by_session FROM shared_page_versions WHERE session_id = ANY($1::uuid[])) s ON s.page_id = p.id
        WHERE p.owner_id = $2 OR p.link_access OR EXISTS (SELECT 1 FROM shared_page_members m WHERE m.page_id = p.id AND m.user_id = $2)
        ORDER BY p.updated_at DESC`,
      [sessionIds, viewerId],
    );
    for (const r of rows) {
      const list = out.get(r.by_session) ?? [];
      list.push(toPage(r));
      out.set(r.by_session, list);
    }
    return out;
  },

  async isMember(pageId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('SELECT 1 FROM shared_page_members WHERE page_id = $1 AND user_id = $2', [pageId, userId]);
    return (rowCount ?? 0) > 0;
  },

  /** Ajoute un membre (ou remplace son message s'il en est donné un) ; false s'il l'était déjà. */
  async addMember(pageId: string, userId: string, addedBy: string, message: string | null = null): Promise<boolean> {
    const { rows } = await pool.query<{ inserted: boolean }>(
      `INSERT INTO shared_page_members (page_id, user_id, added_by, message) VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id, user_id) DO UPDATE SET message = COALESCE(EXCLUDED.message, shared_page_members.message)
       RETURNING (xmax = 0) AS inserted`,
      [pageId, userId, addedBy, message],
    );
    return Boolean(rows[0]?.inserted);
  },

  async removeMember(pageId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM shared_page_members WHERE page_id = $1 AND user_id = $2', [pageId, userId]);
    return (rowCount ?? 0) > 0;
  },
};
