import { pool } from '../db/pool.js';
import { trackedPullRequestService } from '../pullRequests/service.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest } from '../requests/types.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { STALLED_SINCE_SQL, taskRepository } from '../tasks/repository.js';
import type { Task } from '../tasks/types.js';

/**
 * File « À traiter » : ce qui attend une action humaine sur l'ensemble des projets de la personne.
 * Les compteurs (sondés en continu par la sidebar) tiennent en une requête SQL ; la liste des éléments
 * n'est chargée que par la page. Mêmes critères que la section « À traiter » du tableau de bord.
 */

export interface InboxCounts {
  /** Demandes d'autorisation, questions et saisies en attente de réponse. */
  requests: number;
  /** Sessions dont l'agent attend des instructions (hors celles qui ont une demande en attente). */
  idleSessions: number;
  /** Sessions en erreur depuis 24 h. */
  failedSessions: number;
  /** Sessions coupées en plein tour (redémarrage) depuis 24 h. */
  interruptedSessions: number;
  /** Tâches en cours dont l'agent s'est arrêté sans les terminer (`Task.stalledSince`). */
  stalledTasks: number;
  /** Pull requests ouvertes (à fusionner, brouillons compris). */
  pullRequests: number;
  total: number;
}

export interface Inbox {
  generatedAt: Date;
  counts: InboxCounts;
  requests: HumanRequest[];
  /** Sessions à reprendre ou à relancer : en attente d'instructions, en erreur ou interrompues. */
  sessions: Session[];
  /** Tâches « agent arrêté », la plus anciennement arrêtée d'abord. */
  tasks: Task[];
  pullRequests: TrackedPullRequest[];
}

/** Fenêtre au-delà de laquelle une session en erreur ou interrompue ne compte plus. */
const RECENT = "interval '24 hours'";
const ITEM_LIMIT = 100;

const IDLE_SQL = `status = 'running' AND activity IS DISTINCT FROM 'busy'
  AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.session_id = sessions.id AND q.status = 'pending')`;
const FAILED_SQL = `status = 'failed' AND COALESCE(ended_at, updated_at) >= now() - ${RECENT}`;
const INTERRUPTED_SQL = `status = 'interrupted' AND activity = 'busy' AND COALESCE(ended_at, updated_at) >= now() - ${RECENT}`;

export function totalOf(c: Omit<InboxCounts, 'total'>): number {
  return c.requests + c.idleSessions + c.failedSessions + c.interruptedSessions + c.stalledTasks + c.pullRequests;
}

export const inboxService = {
  async counts(projectIds: string[]): Promise<InboxCounts> {
    if (!projectIds.length) return { requests: 0, idleSessions: 0, failedSessions: 0, interruptedSessions: 0, stalledTasks: 0, pullRequests: 0, total: 0 };
    const [{ rows }, prs] = await Promise.all([
      pool.query<{ requests: string; idle: string; failed: string; interrupted: string; stalled: string }>(
        `SELECT
           (SELECT count(*) FROM requests q JOIN sessions s ON s.id = q.session_id
             WHERE q.status = 'pending' AND s.project_id = ANY($1::uuid[]))::text AS requests,
           (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ${IDLE_SQL})::text AS idle,
           (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ${FAILED_SQL})::text AS failed,
           (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ${INTERRUPTED_SQL})::text AS interrupted,
           (SELECT count(*) FROM tasks t WHERE t.project_id = ANY($1::uuid[]) AND t.status = 'in_progress' AND ${STALLED_SINCE_SQL} IS NOT NULL)::text AS stalled`,
        [projectIds],
      ),
      trackedPullRequestService.countPending(projectIds),
    ]);
    const c = {
      requests: Number(rows[0].requests),
      idleSessions: Number(rows[0].idle),
      failedSessions: Number(rows[0].failed),
      interruptedSessions: Number(rows[0].interrupted),
      stalledTasks: Number(rows[0].stalled),
      pullRequests: prs.open,
    };
    return { ...c, total: totalOf(c) };
  },

  async build(projectIds: string[], now = new Date()): Promise<Inbox> {
    if (!projectIds.length) {
      return { generatedAt: now, counts: await inboxService.counts(projectIds), requests: [], sessions: [], tasks: [], pullRequests: [] };
    }
    const [counts, requests, sessionIds, stalled, pullRequests] = await Promise.all([
      inboxService.counts(projectIds),
      requestService.list({ projectIds, status: 'pending', limit: ITEM_LIMIT }),
      pool.query<{ id: string }>(
        `SELECT id FROM sessions
          WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ((${IDLE_SQL}) OR (${FAILED_SQL}) OR (${INTERRUPTED_SQL}))
          ORDER BY COALESCE(ended_at, updated_at) LIMIT ${ITEM_LIMIT}`,
        [projectIds],
      ),
      taskRepository.list({ projectIds, status: ['in_progress'], stalled: true, limit: ITEM_LIMIT }),
      trackedPullRequestService.list({ projectIds, stage: ['to_merge', 'draft'], limit: ITEM_LIMIT }),
    ]);
    const sessions = (await Promise.all(sessionIds.rows.map((r) => sessionService.get(r.id)))).filter((s): s is Session => s !== null);
    const tasks = [...stalled].sort((a, b) => (a.stalledSince?.getTime() ?? 0) - (b.stalledSince?.getTime() ?? 0));
    return { generatedAt: now, counts, requests, sessions, tasks, pullRequests };
  },
};
