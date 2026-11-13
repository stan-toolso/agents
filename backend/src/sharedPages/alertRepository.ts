import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { AlertConfig, AlertState, DataAlert, ParsedAlert } from './alerts.js';

interface Row {
  id: string;
  page_id: string;
  name: string;
  source: string;
  config: AlertConfig;
  position: number;
  state: AlertState;
  streak: number;
  last_value: unknown;
  evaluated_at: Date | null;
  triggered_at: Date | null;
  resolved_at: Date | null;
  fire_count: number;
  session_id: string | null;
  session_at: Date | null;
  error: string | null;
}

const toAlert = (r: Row): DataAlert => ({
  id: r.id,
  pageId: r.page_id,
  name: r.name,
  source: r.source,
  config: r.config,
  position: r.position,
  state: r.state,
  streak: r.streak,
  lastValue: r.last_value ?? null,
  evaluatedAt: r.evaluated_at,
  triggeredAt: r.triggered_at,
  resolvedAt: r.resolved_at,
  fireCount: r.fire_count,
  sessionId: r.session_id,
  sessionAt: r.session_at,
  error: r.error,
});

export const alertRepository = {
  async list(pageId: string): Promise<DataAlert[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_page_alerts WHERE page_id = $1 ORDER BY position, name', [pageId]);
    return rows.map(toAlert);
  },

  /**
   * Remplace les règles d'un artefact. Une règle gardée (même nom, même source, même définition) garde son état ; une
   * règle modifiée repart à « jamais évaluée » (sans événement à la première évaluation normale) ; les autres sont supprimées.
   */
  async replace(pageId: string, alerts: ParsedAlert[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM shared_page_alerts WHERE page_id = $1 AND NOT (name = ANY($2::text[]))', [pageId, alerts.map((a) => a.name)]);
      for (const [position, a] of alerts.entries()) {
        await client.query(
          `INSERT INTO shared_page_alerts (page_id, name, source, config, position) VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (page_id, name) DO UPDATE SET position = EXCLUDED.position, source = EXCLUDED.source, config = EXCLUDED.config, updated_at = now(),
             state = CASE WHEN shared_page_alerts.source = EXCLUDED.source AND shared_page_alerts.config = EXCLUDED.config THEN shared_page_alerts.state ELSE 'unknown' END,
             streak = CASE WHEN shared_page_alerts.source = EXCLUDED.source AND shared_page_alerts.config = EXCLUDED.config THEN shared_page_alerts.streak ELSE 0 END,
             last_value = CASE WHEN shared_page_alerts.source = EXCLUDED.source AND shared_page_alerts.config = EXCLUDED.config THEN shared_page_alerts.last_value ELSE NULL END,
             evaluated_at = CASE WHEN shared_page_alerts.source = EXCLUDED.source AND shared_page_alerts.config = EXCLUDED.config THEN shared_page_alerts.evaluated_at ELSE NULL END,
             error = CASE WHEN shared_page_alerts.source = EXCLUDED.source AND shared_page_alerts.config = EXCLUDED.config THEN shared_page_alerts.error ELSE NULL END`,
          [pageId, a.name, a.source, toJson(a.config), position],
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

  /** Résultat d'une évaluation : nouvel état, anti-rebond, valeur, et dates du franchissement s'il y en a un. */
  async saveEvaluation(id: string, s: { state: AlertState; streak: number; value: unknown; event: 'triggered' | 'resolved' | null; error: string | null }): Promise<void> {
    await pool.query(
      `UPDATE shared_page_alerts SET state = $2, streak = $3, last_value = $4::jsonb, evaluated_at = now(), error = $5, updated_at = now(),
         triggered_at = CASE WHEN $6 = 'triggered' THEN now() ELSE triggered_at END,
         resolved_at = CASE WHEN $6 = 'resolved' THEN now() ELSE resolved_at END,
         fire_count = fire_count + CASE WHEN $6 = 'triggered' THEN 1 ELSE 0 END
       WHERE id = $1`,
      [id, s.state, s.streak, toJson(s.value), s.error?.slice(0, 1000) ?? null, s.event ?? ''],
    );
  },

  /** Retire les alertes dont la source a disparu ou est devenue vivante (graphql) ; renvoie leurs noms. */
  async pruneMissingSources(pageId: string): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>(
      `DELETE FROM shared_page_alerts a WHERE a.page_id = $1
         AND NOT EXISTS (SELECT 1 FROM shared_page_sources s WHERE s.page_id = a.page_id AND s.name = a.source AND s.kind <> 'graphql')
       RETURNING a.name`,
      [pageId],
    );
    return rows.map((r) => r.name);
  },

  async markSession(id: string, sessionId: string): Promise<void> {
    await pool.query('UPDATE shared_page_alerts SET session_id = $2, session_at = now(), updated_at = now() WHERE id = $1', [id, sessionId]);
  },

  async setError(id: string, error: string | null): Promise<void> {
    await pool.query('UPDATE shared_page_alerts SET error = $2, updated_at = now() WHERE id = $1', [id, error?.slice(0, 1000) ?? null]);
  },
};
