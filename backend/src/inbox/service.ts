import { pool } from '../db/pool.js';
import { trackedPullRequestService } from '../pullRequests/service.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest } from '../requests/types.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';

/**
 * File « À traiter » : ce qui attend une action humaine sur l'ensemble des projets de la personne.
 * Les compteurs (sondés en continu par la sidebar) tiennent en une requête SQL ; la liste des éléments
 * n'est chargée que par la page. Mêmes critères que la section « À traiter » du tableau de bord.
 *
 * Une session dont l'agent a fini son tour et attend des instructions n'y figure pas : elle ne demande
 * rien (le travail est fait ou la personne y reviendra quand elle voudra). Seul ce qui bloque un agent
 * (demande) ou un travail à reprendre (erreur, interruption) ou à fusionner (PR) est « à traiter ».
 */

export interface InboxCounts {
  /** Demandes d'autorisation, questions et saisies en attente de réponse. */
  requests: number;
  /** Sessions en erreur depuis 24 h. */
  failedSessions: number;
  /** Sessions coupées en plein tour (redémarrage) depuis 24 h. */
  interruptedSessions: number;
  /** Pull requests ouvertes (à fusionner, brouillons compris). */
  pullRequests: number;
  total: number;
}

export interface Inbox {
  generatedAt: Date;
  counts: InboxCounts;
  requests: HumanRequest[];
  /** Sessions à reprendre ou à relancer : en erreur ou interrompues. */
  sessions: Session[];
  pullRequests: TrackedPullRequest[];
}

/** Fenêtre au-delà de laquelle une session en erreur ou interrompue ne compte plus. */
const RECENT = "interval '24 hours'";
const ITEM_LIMIT = 100;

const FAILED_SQL = `status = 'failed' AND COALESCE(ended_at, updated_at) >= now() - ${RECENT}`;
const INTERRUPTED_SQL = `status = 'interrupted' AND activity = 'busy' AND COALESCE(ended_at, updated_at) >= now() - ${RECENT}`;

export function totalOf(c: Omit<InboxCounts, 'total'>): number {
  return c.requests + c.failedSessions + c.interruptedSessions + c.pullRequests;
}

export const inboxService = {
  async counts(projectIds: string[]): Promise<InboxCounts> {
    if (!projectIds.length) return { requests: 0, failedSessions: 0, interruptedSessions: 0, pullRequests: 0, total: 0 };
    const [{ rows }, prs] = await Promise.all([
      pool.query<{ requests: string; failed: string; interrupted: string }>(
        `SELECT
           (SELECT count(*) FROM requests q JOIN sessions s ON s.id = q.session_id
             WHERE q.status = 'pending' AND s.project_id = ANY($1::uuid[]))::text AS requests,
           (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ${FAILED_SQL})::text AS failed,
           (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ${INTERRUPTED_SQL})::text AS interrupted`,
        [projectIds],
      ),
      trackedPullRequestService.countPending(projectIds),
    ]);
    const c = {
      requests: Number(rows[0].requests),
      failedSessions: Number(rows[0].failed),
      interruptedSessions: Number(rows[0].interrupted),
      pullRequests: prs.open,
    };
    return { ...c, total: totalOf(c) };
  },

  async build(projectIds: string[], now = new Date()): Promise<Inbox> {
    if (!projectIds.length) {
      return { generatedAt: now, counts: await inboxService.counts(projectIds), requests: [], sessions: [], pullRequests: [] };
    }
    const [counts, requests, sessionIds, pullRequests] = await Promise.all([
      inboxService.counts(projectIds),
      requestService.list({ projectIds, status: 'pending', limit: ITEM_LIMIT }),
      pool.query<{ id: string }>(
        `SELECT id FROM sessions
          WHERE project_id = ANY($1::uuid[]) AND kind = 'session' AND ((${FAILED_SQL}) OR (${INTERRUPTED_SQL}))
          ORDER BY COALESCE(ended_at, updated_at) LIMIT ${ITEM_LIMIT}`,
        [projectIds],
      ),
      trackedPullRequestService.list({ projectIds, stage: ['to_merge', 'draft'], limit: ITEM_LIMIT }),
    ]);
    const sessions = (await Promise.all(sessionIds.rows.map((r) => sessionService.get(r.id)))).filter((s): s is Session => s !== null);
    return { generatedAt: now, counts, requests, sessions, pullRequests };
  },
};
