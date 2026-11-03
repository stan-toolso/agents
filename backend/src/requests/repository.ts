import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { CreateRequestInput, HumanRequest, RequestStatus } from './types.js';

interface RequestRow {
  id: string;
  session_id: string;
  type: string;
  status: RequestStatus;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  answered_by: string | null;
  created_at: Date;
  answered_at: Date | null;
}

function toRequest(row: RequestRow): HumanRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    title: row.title,
    message: row.message,
    payload: row.payload ?? {},
    response: row.response,
    answeredById: row.answered_by ?? null,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

export const requestRepository = {
  async create(sessionId: string, input: CreateRequestInput): Promise<HumanRequest> {
    const { rows } = await pool.query<RequestRow>(
      `INSERT INTO requests (session_id, type, title, message, payload)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [sessionId, input.type, input.title, input.message ?? null, toJson(input.payload ?? {})],
    );
    return toRequest(rows[0]);
  },

  async findById(id: string): Promise<HumanRequest | null> {
    const { rows } = await pool.query<RequestRow>('SELECT * FROM requests WHERE id = $1', [id]);
    return rows[0] ? toRequest(rows[0]) : null;
  },

  async list(filter: { sessionId?: string; projectIds?: string[]; status?: RequestStatus; limit?: number; newestFirst?: boolean } = {}): Promise<HumanRequest[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      params.push(filter.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (filter.projectIds) {
      params.push(filter.projectIds);
      where.push(`session_id IN (SELECT id FROM sessions WHERE project_id = ANY($${params.length}::uuid[]))`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 100, 500));
    const { rows } = await pool.query<RequestRow>(
      `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ${filter.newestFirst ? 'DESC' : 'ASC'} LIMIT $${params.length}`,
      params,
    );
    return rows.map(toRequest);
  },

  async countPending(sessionId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM requests WHERE session_id = $1 AND status = 'pending'`,
      [sessionId],
    );
    return Number(rows[0].n);
  },

  /** Demandes en attente par session (chargement groupé par requête GraphQL) ; une session sans demande est absente. */
  async countPendingBySessions(sessionIds: string[]): Promise<Map<string, number>> {
    if (!sessionIds.length) return new Map();
    const { rows } = await pool.query<{ session_id: string; n: string }>(
      `SELECT session_id, count(*)::text AS n FROM requests WHERE session_id = ANY($1::uuid[]) AND status = 'pending' GROUP BY session_id`,
      [sessionIds],
    );
    return new Map(rows.map((r) => [r.session_id, Number(r.n)]));
  },

  /** Passe une demande en attente à `status` ; renvoie null si elle n'était plus en attente. */
  async settle(id: string, status: Exclude<RequestStatus, 'pending'>, response: Record<string, unknown> | null, answeredBy: string | null = null): Promise<HumanRequest | null> {
    const { rows } = await pool.query<RequestRow>(
      `UPDATE requests SET status = $2, response = $3, answered_at = now(), answered_by = $4
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status, response === null ? null : toJson(response), answeredBy],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  },

  /** Demandes d'accord (approvals/service.ts) encore en attente pour une tâche. */
  async pendingApprovalsForTask(taskId: string): Promise<HumanRequest[]> {
    const { rows } = await pool.query<RequestRow>(
      `SELECT * FROM requests WHERE type = 'approval' AND status = 'pending' AND payload->>'taskId' = $1 ORDER BY created_at`,
      [taskId],
    );
    return rows.map(toRequest);
  },

  /**
   * Règle les demandes en attente d'une session qui s'arrête. Les demandes d'accord n'attendent pas le processus de
   * l'agent (la réponse lui revient par le fil de la tâche) : elles survivent à l'arrêt de la session.
   */
  async settleAllPending(sessionId: string, status: 'cancelled' | 'expired'): Promise<HumanRequest[]> {
    const { rows } = await pool.query<RequestRow>(
      `UPDATE requests SET status = $2, answered_at = now()
       WHERE session_id = $1 AND status = 'pending' AND type <> 'approval' RETURNING *`,
      [sessionId, status],
    );
    return rows.map(toRequest);
  },

  /**
   * Au redémarrage : une demande encore en attente n'a plus de processus pour la consommer, sauf si sa session tourne
   * sur une autre instance vivante du backend (déploiement bleu/vert). Les demandes d'accord ne dépendent d'aucun processus.
   */
  async expireAllPending(liveInstanceIds: string[] = []): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE requests r SET status = 'expired', answered_at = now()
       WHERE r.status = 'pending' AND r.type <> 'approval'
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.session_id AND s.status = 'running' AND s.instance_id = ANY($1::uuid[]))`,
      [liveInstanceIds],
    );
    return rowCount ?? 0;
  },
};
