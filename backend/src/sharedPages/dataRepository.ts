import { pool } from '../db/pool.js';
import type { DataSource, DataSourceKind, DataSourceStatus, ScriptSourceConfig, SqlSourceConfig } from './dataSources.js';

interface Row {
  id: string;
  page_id: string;
  name: string;
  kind: DataSourceKind;
  config: SqlSourceConfig | ScriptSourceConfig;
  position: number;
  data: unknown;
  row_count: number | null;
  status: DataSourceStatus;
  error: string | null;
  duration_ms: number | null;
  refreshed_at: Date | null;
  attempted_at: Date | null;
}

const toSource = (r: Row): DataSource => ({
  id: r.id,
  pageId: r.page_id,
  name: r.name,
  kind: r.kind,
  config: r.config,
  position: r.position,
  data: r.data ?? null,
  rowCount: r.row_count,
  status: r.status,
  error: r.error,
  durationMs: r.duration_ms,
  refreshedAt: r.refreshed_at,
  attemptedAt: r.attempted_at,
});

const META = 'id, page_id, name, kind, config, position, NULL::jsonb AS data, row_count, status, error, duration_ms, refreshed_at, attempted_at';

/** Colonnes jsonb : toujours passer par JSON.stringify (un tableau JS serait pris pour un tableau PostgreSQL). */
const toJson = (v: unknown) => JSON.stringify(v ?? null);

export const dataSourceRepository = {
  /** Sources d'un artefact, dans l'ordre ; `withData` : avec leurs dernières données (sinon seulement l'état). */
  async list(pageId: string, withData = false): Promise<DataSource[]> {
    const { rows } = await pool.query<Row>(`SELECT ${withData ? '*' : META} FROM shared_page_sources WHERE page_id = $1 ORDER BY position, name`, [pageId]);
    return rows.map(toSource);
  },

  /**
   * Remplace les sources d'un artefact. Une source gardée (même nom, même type, même définition) garde ses données et
   * son état ; une source modifiée repart à « jamais rafraîchie » ; les autres sont supprimées.
   */
  async replace(pageId: string, sources: { name: string; kind: DataSourceKind; config: SqlSourceConfig | ScriptSourceConfig }[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM shared_page_sources WHERE page_id = $1 AND NOT (name = ANY($2::text[]))', [pageId, sources.map((s) => s.name)]);
      for (const [position, s] of sources.entries()) {
        await client.query(
          `INSERT INTO shared_page_sources (page_id, name, kind, config, position) VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (page_id, name) DO UPDATE SET position = EXCLUDED.position, kind = EXCLUDED.kind, config = EXCLUDED.config, updated_at = now(),
             status = CASE WHEN shared_page_sources.kind = EXCLUDED.kind AND shared_page_sources.config = EXCLUDED.config THEN shared_page_sources.status ELSE 'pending' END,
             data = CASE WHEN shared_page_sources.kind = EXCLUDED.kind AND shared_page_sources.config = EXCLUDED.config THEN shared_page_sources.data ELSE NULL END,
             error = CASE WHEN shared_page_sources.kind = EXCLUDED.kind AND shared_page_sources.config = EXCLUDED.config THEN shared_page_sources.error ELSE NULL END`,
          [pageId, s.name, s.kind, toJson(s.config), position],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async saveSuccess(id: string, data: unknown, rowCount: number | null, durationMs: number): Promise<void> {
    await pool.query(
      `UPDATE shared_page_sources SET data = $2::jsonb, row_count = $3, status = 'ok', error = NULL, duration_ms = $4, refreshed_at = now(), attempted_at = now(), updated_at = now() WHERE id = $1`,
      [id, toJson(data), rowCount, durationMs],
    );
  },

  /** Échec ou source sautée : les dernières données réussies sont gardées (la page reste lisible). */
  async saveFailure(id: string, status: 'error' | 'skipped', error: string, durationMs: number | null): Promise<void> {
    await pool.query(`UPDATE shared_page_sources SET status = $2, error = $3, duration_ms = $4, attempted_at = now(), updated_at = now() WHERE id = $1`, [id, status, error.slice(0, 2000), durationMs]);
  },

  /** Données de toutes les sources d'un artefact : `{ nom: données }`. */
  async dataOf(pageId: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<{ name: string; data: unknown }>('SELECT name, data FROM shared_page_sources WHERE page_id = $1 ORDER BY position, name', [pageId]);
    return Object.fromEntries(rows.map((r) => [r.name, r.data ?? null]));
  },
};
