import { toJson } from '../db/json.js';
import { pool } from '../db/pool.js';
import type { CommentAnchor, SharedPageComment } from './types.js';

interface Row {
  id: string;
  page_id: string;
  parent_id: string | null;
  author_id: string;
  session_id: string | null;
  body: string;
  anchor: CommentAnchor | null;
  version: number;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
  updated_at: Date;
}
const toComment = (r: Row): SharedPageComment => ({
  id: r.id,
  pageId: r.page_id,
  parentId: r.parent_id,
  authorId: r.author_id,
  sessionId: r.session_id,
  body: r.body,
  anchor: r.anchor,
  version: r.version,
  resolvedAt: r.resolved_at,
  resolvedById: r.resolved_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const sharedPageCommentRepository = {
  async findById(id: string): Promise<SharedPageComment | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_page_comments WHERE id = $1', [id]);
    return rows[0] ? toComment(rows[0]) : null;
  },

  /** Tous les commentaires d'une page (racines et réponses), du plus ancien au plus récent. */
  async listOfPage(pageId: string): Promise<SharedPageComment[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_page_comments WHERE page_id = $1 ORDER BY created_at, id', [pageId]);
    return rows.map(toComment);
  },

  /** Réponses d'un commentaire racine, de la plus ancienne à la plus récente. */
  async replies(parentId: string): Promise<SharedPageComment[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_page_comments WHERE parent_id = $1 ORDER BY created_at, id', [parentId]);
    return rows.map(toComment);
  },

  /** Nombre de commentaires racines non traités d'une page. */
  async countOpen(pageId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM shared_page_comments WHERE page_id = $1 AND parent_id IS NULL AND resolved_at IS NULL', [pageId]);
    return Number(rows[0]?.n ?? 0);
  },

  /** Commentaires non traités de plusieurs pages (absente : aucun). */
  async countOpenByPages(pageIds: string[]): Promise<Map<string, number>> {
    if (!pageIds.length) return new Map();
    const { rows } = await pool.query<{ page_id: string; n: string }>(
      'SELECT page_id, count(*)::text AS n FROM shared_page_comments WHERE page_id = ANY($1::uuid[]) AND parent_id IS NULL AND resolved_at IS NULL GROUP BY page_id',
      [pageIds],
    );
    return new Map(rows.map((r) => [r.page_id, Number(r.n)]));
  },

  async create(input: { pageId: string; parentId: string | null; authorId: string; sessionId: string | null; body: string; anchor: CommentAnchor | null; version: number }): Promise<SharedPageComment> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO shared_page_comments (page_id, parent_id, author_id, session_id, body, anchor, version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [input.pageId, input.parentId, input.authorId, input.sessionId, input.body, input.anchor ? toJson(input.anchor) : null, input.version],
    );
    return toComment(rows[0]);
  },

  async updateBody(id: string, body: string): Promise<SharedPageComment | null> {
    const { rows } = await pool.query<Row>('UPDATE shared_page_comments SET body = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, body]);
    return rows[0] ? toComment(rows[0]) : null;
  },

  /** Marque un commentaire racine traité (par qui) ou le rouvre. */
  async setResolved(id: string, resolvedBy: string | null): Promise<SharedPageComment | null> {
    const { rows } = await pool.query<Row>(
      resolvedBy
        ? 'UPDATE shared_page_comments SET resolved_at = now(), resolved_by = $2, updated_at = now() WHERE id = $1 RETURNING *'
        : 'UPDATE shared_page_comments SET resolved_at = NULL, resolved_by = NULL, updated_at = now() WHERE id = $1 RETURNING *',
      resolvedBy ? [id, resolvedBy] : [id],
    );
    return rows[0] ? toComment(rows[0]) : null;
  },

  /** Supprime un commentaire (et ses réponses, par cascade). */
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM shared_page_comments WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Supprime tous les commentaires de la page (réponses comprises) ; renvoie le nombre de commentaires racines supprimés. */
  async deleteAllOfPage(pageId: string): Promise<number> {
    const { rows } = await pool.query<{ roots: number }>(
      'WITH d AS (DELETE FROM shared_page_comments WHERE page_id = $1 RETURNING parent_id) SELECT count(*) FILTER (WHERE parent_id IS NULL)::int AS roots FROM d',
      [pageId],
    );
    return rows[0]?.roots ?? 0;
  },
};
