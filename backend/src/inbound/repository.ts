import { pool } from '../db/pool.js';

/** Événement reçu par le point d'entrée entrant (table inbound_events). */
export interface InboundEvent {
  id: string;
  projectId: string;
  apiKeyId: string | null;
  keyName: string;
  idempotencyKey: string | null;
  requestHash: string;
  source: string | null;
  taskId: string | null;
  sessionId: string | null;
  agentId: string | null;
  triage: boolean;
  status: 'processing' | 'done' | 'failed';
  error: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  project_id: string;
  api_key_id: string | null;
  key_name: string;
  idempotency_key: string | null;
  request_hash: string;
  source: string | null;
  task_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  triage: boolean;
  status: InboundEvent['status'];
  error: string | null;
  created_at: Date;
}

const toEvent = (r: Row): InboundEvent => ({
  id: r.id,
  projectId: r.project_id,
  apiKeyId: r.api_key_id,
  keyName: r.key_name,
  idempotencyKey: r.idempotency_key,
  requestHash: r.request_hash,
  source: r.source,
  taskId: r.task_id,
  sessionId: r.session_id,
  agentId: r.agent_id,
  triage: r.triage,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

export const inboundRepository = {
  async findByIdempotencyKey(projectId: string, key: string): Promise<InboundEvent | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM inbound_events WHERE project_id = $1 AND idempotency_key = $2', [projectId, key]);
    return rows[0] ? toEvent(rows[0]) : null;
  },

  /** Insère un événement « en cours » ; null si la clé d'idempotence est déjà prise (appel concurrent). */
  async insert(e: { projectId: string; apiKeyId: string; keyName: string; idempotencyKey: string | null; requestHash: string; source: string | null; triage: boolean }): Promise<InboundEvent | null> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO inbound_events (project_id, api_key_id, key_name, idempotency_key, request_hash, source, triage)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [e.projectId, e.apiKeyId, e.keyName, e.idempotencyKey, e.requestHash, e.source, e.triage],
    );
    return rows[0] ? toEvent(rows[0]) : null;
  },

  /** Reprend un événement en échec (nouvel essai avec la même clé d'idempotence) ; null si un autre essai l'a déjà repris. */
  async retry(id: string): Promise<InboundEvent | null> {
    const { rows } = await pool.query<Row>(`UPDATE inbound_events SET status = 'processing', error = NULL WHERE id = $1 AND status = 'failed' RETURNING *`, [id]);
    return rows[0] ? toEvent(rows[0]) : null;
  },

  async attachTask(id: string, taskId: string): Promise<void> {
    await pool.query('UPDATE inbound_events SET task_id = $2 WHERE id = $1', [id, taskId]);
  },

  async finish(id: string, patch: { status: 'done' | 'failed'; taskId?: string | null; sessionId?: string | null; agentId?: string | null; error?: string | null }): Promise<InboundEvent> {
    const { rows } = await pool.query<Row>(
      `UPDATE inbound_events SET status = $2, task_id = COALESCE($3, task_id), session_id = COALESCE($4, session_id), agent_id = COALESCE($5, agent_id), error = $6
       WHERE id = $1 RETURNING *`,
      [id, patch.status, patch.taskId ?? null, patch.sessionId ?? null, patch.agentId ?? null, patch.error ?? null],
    );
    return toEvent(rows[0]);
  },

  /** Nombre d'événements reçus par une clé depuis `sinceSeconds` (tous, ou les triages seulement). */
  async countRecent(apiKeyId: string, sinceSeconds: number, triageOnly = false): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM inbound_events WHERE api_key_id = $1 AND created_at > now() - make_interval(secs => $2) ${triageOnly ? 'AND triage' : ''}`,
      [apiKeyId, sinceSeconds],
    );
    return Number(rows[0]?.n ?? 0);
  },

  async listByProject(projectId: string, limit = 50): Promise<InboundEvent[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM inbound_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2', [projectId, Math.min(limit, 200)]);
    return rows.map(toEvent);
  },
};
