import { pool } from '../db/pool.js';
import type { DeliveryAuthorRow, ExistingLink, QualityTaskCandidate, ReferenceDelivery } from './quality.js';

export interface QualitySettingsRow {
  tags: string[];
  windowHours: number;
  updatedById: string | null;
  updatedAt: Date;
}

export interface DeliveryTaskLink {
  taskId: string;
  deliveryId: string | null;
  source: 'auto' | 'manual';
  linkedById: string | null;
  createdAt: Date;
}

interface LinkRow {
  task_id: string;
  delivery_id: string | null;
  source: 'auto' | 'manual';
  linked_by_id: string | null;
  created_at: Date;
}
const toLink = (r: LinkRow): DeliveryTaskLink => ({ taskId: r.task_id, deliveryId: r.delivery_id, source: r.source, linkedById: r.linked_by_id, createdAt: r.created_at });

/**
 * Livraisons de référence d'un projet (réussies) : ses déploiements, ou ses fusions s'il n'a jamais déployé. `at` :
 * fin de la livraison (date de création pour un déploiement déclaré, créé déjà terminé).
 */
const REFERENCES = `
  SELECT id, coalesce(finished_at, created_at) AS at FROM deliveries
   WHERE project_id = $1 AND status = 'succeeded'
     AND kind = CASE WHEN EXISTS (SELECT 1 FROM deliveries WHERE project_id = $1 AND kind = 'deploy' AND status = 'succeeded') THEN 'deploy' ELSE 'merge' END`;

export const deliveryQualityRepository = {
  async settings(projectId: string): Promise<QualitySettingsRow | null> {
    const { rows } = await pool.query<{ tags: string[]; window_hours: number; updated_by_id: string | null; updated_at: Date }>('SELECT * FROM delivery_quality_settings WHERE project_id = $1', [projectId]);
    const r = rows[0];
    return r ? { tags: r.tags, windowHours: r.window_hours, updatedById: r.updated_by_id, updatedAt: r.updated_at } : null;
  },

  async setSettings(projectId: string, s: { tags: string[]; windowHours: number } | null, userId: string): Promise<void> {
    if (!s) {
      await pool.query('DELETE FROM delivery_quality_settings WHERE project_id = $1', [projectId]);
      return;
    }
    await pool.query(
      `INSERT INTO delivery_quality_settings (project_id, tags, window_hours, updated_by_id, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (project_id) DO UPDATE SET tags = EXCLUDED.tags, window_hours = EXCLUDED.window_hours, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`,
      [projectId, s.tags, s.windowHours, userId],
    );
  },

  /** Livraisons de référence du projet terminées dans [from, to] (bornes facultatives). */
  async references(projectId: string, range: { from?: Date; to?: Date } = {}): Promise<ReferenceDelivery[]> {
    const { rows } = await pool.query<{ id: string; at: Date }>(
      `SELECT * FROM (${REFERENCES}) r WHERE ($2::timestamptz IS NULL OR r.at >= $2) AND ($3::timestamptz IS NULL OR r.at <= $3) ORDER BY r.at`,
      [projectId, range.from ?? null, range.to ?? null],
    );
    return rows.map((r) => ({ id: r.id, at: r.at }));
  },

  /** Tâches étiquetées du projet créées depuis `since` (candidates au rattrapage). */
  async taggedTasksSince(projectId: string, since: Date): Promise<QualityTaskCandidate[]> {
    const { rows } = await pool.query<{ id: string; tags: string[]; created_at: Date }>(
      `SELECT id, tags, created_at FROM tasks WHERE project_id = $1 AND created_at >= $2 AND cardinality(tags) > 0`,
      [projectId, since],
    );
    return rows.map((r) => ({ id: r.id, tags: r.tags, createdAt: r.created_at }));
  },

  /** Rattachements des tâches du projet. */
  async linksOfProject(projectId: string): Promise<Map<string, ExistingLink>> {
    const { rows } = await pool.query<LinkRow>(`SELECT dt.* FROM delivery_tasks dt JOIN tasks t ON t.id = dt.task_id WHERE t.project_id = $1`, [projectId]);
    return new Map(rows.map((r) => [r.task_id, { deliveryId: r.delivery_id, source: r.source }]));
  },

  async linkOf(taskId: string): Promise<DeliveryTaskLink | null> {
    const { rows } = await pool.query<LinkRow>('SELECT * FROM delivery_tasks WHERE task_id = $1', [taskId]);
    return rows[0] ? toLink(rows[0]) : null;
  },

  /** Rattachements (non nuls) de ces tâches, par tâche (chargement groupé). */
  async linksOfTasks(taskIds: string[]): Promise<Map<string, DeliveryTaskLink>> {
    if (!taskIds.length) return new Map();
    const { rows } = await pool.query<LinkRow>('SELECT * FROM delivery_tasks WHERE task_id = ANY($1::uuid[])', [taskIds]);
    return new Map(rows.map((r) => [r.task_id, toLink(r)]));
  },

  /** Tâches rattachées à ces livraisons, par livraison (chargement groupé). */
  async linksOfDeliveries(deliveryIds: string[]): Promise<Map<string, DeliveryTaskLink[]>> {
    const out = new Map<string, DeliveryTaskLink[]>();
    if (!deliveryIds.length) return out;
    const { rows } = await pool.query<LinkRow>(
      `SELECT dt.* FROM delivery_tasks dt JOIN tasks t ON t.id = dt.task_id WHERE dt.delivery_id = ANY($1::uuid[]) ORDER BY t.created_at`,
      [deliveryIds],
    );
    for (const r of rows) out.set(r.delivery_id!, [...(out.get(r.delivery_id!) ?? []), toLink(r)]);
    return out;
  },

  /** Rattachement automatique (ne remplace jamais un rattachement manuel). */
  async setAuto(taskId: string, deliveryId: string): Promise<void> {
    await pool.query(
      `INSERT INTO delivery_tasks (task_id, delivery_id, source) VALUES ($1, $2, 'auto')
       ON CONFLICT (task_id) DO UPDATE SET delivery_id = EXCLUDED.delivery_id, created_at = now() WHERE delivery_tasks.source = 'auto'`,
      [taskId, deliveryId],
    );
  },

  /** Retire un rattachement automatique. */
  async removeAuto(taskIds: string[]): Promise<void> {
    if (taskIds.length) await pool.query(`DELETE FROM delivery_tasks WHERE task_id = ANY($1::uuid[]) AND source = 'auto'`, [taskIds]);
  },

  /** Rattachement manuel (deliveryId null : la tâche n'est rattachée à aucune livraison). */
  async setManual(taskId: string, deliveryId: string | null, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO delivery_tasks (task_id, delivery_id, source, linked_by_id) VALUES ($1, $2, 'manual', $3)
       ON CONFLICT (task_id) DO UPDATE SET delivery_id = EXCLUDED.delivery_id, source = 'manual', linked_by_id = EXCLUDED.linked_by_id, created_at = now()`,
      [taskId, deliveryId, userId],
    );
  },

  async remove(taskId: string): Promise<void> {
    await pool.query('DELETE FROM delivery_tasks WHERE task_id = $1', [taskId]);
  },

  /** Nombre de tâches qualité par livraison. */
  async qualityCounts(deliveryIds: string[]): Promise<Map<string, number>> {
    if (!deliveryIds.length) return new Map();
    const { rows } = await pool.query<{ delivery_id: string; n: string }>(
      `SELECT delivery_id, count(*) AS n FROM delivery_tasks WHERE delivery_id = ANY($1::uuid[]) GROUP BY delivery_id`,
      [deliveryIds],
    );
    return new Map(rows.map((r) => [r.delivery_id, Number(r.n)]));
  },

  /**
   * PR emportées par ces livraisons et leur auteur : propriétaire de la session qui l'a ouverte (l'agent, pour une
   * session d'agent), sinon la personne. Déploiement : PR liées (delivery_pull_requests) ; fusion : la PR livrée.
   */
  async authors(deliveryIds: string[]): Promise<DeliveryAuthorRow[]> {
    if (!deliveryIds.length) return [];
    const { rows } = await pool.query<{ delivery_id: string; pull_request_id: string; author_id: string | null }>(
      `SELECT x.delivery_id, pr.id AS pull_request_id, coalesce(s.owner_id, pr.created_by_user_id) AS author_id
         FROM (SELECT dp.delivery_id, dp.pull_request_id FROM delivery_pull_requests dp WHERE dp.delivery_id = ANY($1::uuid[])
               UNION
               SELECT d.id, p.id FROM deliveries d JOIN pull_requests p ON p.project_id = d.project_id AND p.number = d.pr_number
                WHERE d.id = ANY($1::uuid[]) AND d.kind = 'merge') x
         JOIN pull_requests pr ON pr.id = x.pull_request_id
         LEFT JOIN sessions s ON s.id = pr.created_by_session_id`,
      [deliveryIds],
    );
    return rows.map((r) => ({ deliveryId: r.delivery_id, pullRequestId: r.pull_request_id, authorId: r.author_id }));
  },

  /** Projets qui ont au moins une livraison réussie (rattrapage au démarrage). */
  async projectsWithDeliveries(): Promise<string[]> {
    const { rows } = await pool.query<{ project_id: string }>(`SELECT DISTINCT project_id FROM deliveries WHERE status = 'succeeded'`);
    return rows.map((r) => r.project_id);
  },
};
