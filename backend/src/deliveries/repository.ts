import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Delivery, DeliveryKind, DeliveryStatus, DeliveryStep, DeployConfig, DeployConfigInput } from './types.js';

interface Row {
  id: string;
  project_id: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  requested_by_id: string | null;
  joined_by_ids: string[] | null;
  session_id: string | null;
  worksession_id: string | null;
  task_id: string | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  sha: string | null;
  steps: DeliveryStep[] | null;
  output: string | null;
  error: string | null;
  instance_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export const toDelivery = (r: Row): Delivery => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  status: r.status,
  requestedById: r.requested_by_id,
  joinedByIds: r.joined_by_ids ?? [],
  sessionId: r.session_id,
  worksessionId: r.worksession_id,
  taskId: r.task_id,
  branch: r.branch,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  sha: r.sha,
  steps: r.steps ?? [],
  output: r.output,
  error: r.error,
  instanceId: r.instance_id,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

interface ConfigRow {
  project_id: string;
  vault_item: string;
  command: string;
  branch: string | null;
  timeout_minutes: number;
  updated_by_id: string | null;
  updated_at: Date;
}
const toConfig = (r: ConfigRow): DeployConfig => ({ projectId: r.project_id, vaultItem: r.vault_item, command: r.command, branch: r.branch, timeoutMinutes: r.timeout_minutes, updatedById: r.updated_by_id, updatedAt: r.updated_at });

/** Erreur d'unicité PostgreSQL (verrou d'un index partiel). */
export const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export interface NewDelivery {
  projectId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  requestedById: string | null;
  sessionId?: string | null;
  worksessionId?: string | null;
  taskId?: string | null;
  branch?: string | null;
  instanceId?: string | null;
  steps?: DeliveryStep[];
}

export type DeliveryPatch = Partial<Pick<Delivery, 'status' | 'sessionId' | 'taskId' | 'branch' | 'prNumber' | 'prUrl' | 'sha' | 'output' | 'error' | 'startedAt' | 'finishedAt'>>;

const COLUMNS: Record<keyof DeliveryPatch, string> = {
  status: 'status',
  sessionId: 'session_id',
  taskId: 'task_id',
  branch: 'branch',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  sha: 'sha',
  output: 'output',
  error: 'error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

export const deliveryRepository = {
  async create(d: NewDelivery): Promise<Delivery> {
    const running = d.status === 'running';
    const { rows } = await pool.query<Row>(
      `INSERT INTO deliveries (project_id, kind, status, requested_by_id, session_id, worksession_id, task_id, branch, instance_id, steps, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, ${running ? 'now()' : 'NULL'}) RETURNING *`,
      [d.projectId, d.kind, d.status, d.requestedById, d.sessionId ?? null, d.worksessionId ?? null, d.taskId ?? null, d.branch ?? null, d.instanceId ?? null, toJson(d.steps ?? [])],
    );
    return toDelivery(rows[0]);
  },

  async get(id: string): Promise<Delivery | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM deliveries WHERE id = $1', [id]);
    return rows[0] ? toDelivery(rows[0]) : null;
  },

  async list(filter: { projectId?: string; worksessionId?: string; taskId?: string; kind?: DeliveryKind; limit?: number }): Promise<Delivery[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (filter.projectId) add('project_id = ?', filter.projectId);
    if (filter.worksessionId) add('worksession_id = ?', filter.worksessionId);
    if (filter.taskId) add('task_id = ?', filter.taskId);
    if (filter.kind) add('kind = ?', filter.kind);
    args.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    const { rows } = await pool.query<Row>(`SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    return rows.map(toDelivery);
  },

  /** Met à jour une livraison encore active (une livraison annulée ou finie ne change plus) ; null si elle ne l'est plus. */
  async updateActive(id: string, patch: DeliveryPatch): Promise<Delivery | null> {
    const keys = (Object.keys(patch) as (keyof DeliveryPatch)[]).filter((k) => patch[k] !== undefined);
    if (!keys.length) return this.get(id);
    const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`);
    const { rows } = await pool.query<Row>(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`, [id, ...keys.map((k) => patch[k])]);
    return rows[0] ? toDelivery(rows[0]) : null;
  },

  async appendStep(id: string, step: DeliveryStep): Promise<void> {
    await pool.query(`UPDATE deliveries SET steps = steps || $2::jsonb WHERE id = $1`, [id, toJson([step])]);
  },

  /** Déploiement en attente du projet (le lot suivant), s'il y en a un. */
  async queuedDeploy(projectId: string): Promise<Delivery | null> {
    const { rows } = await pool.query<Row>(`SELECT * FROM deliveries WHERE project_id = $1 AND kind = 'deploy' AND status = 'queued'`, [projectId]);
    return rows[0] ? toDelivery(rows[0]) : null;
  },

  async runningDeploy(projectId: string): Promise<Delivery | null> {
    const { rows } = await pool.query<Row>(`SELECT * FROM deliveries WHERE project_id = $1 AND kind = 'deploy' AND status = 'running'`, [projectId]);
    return rows[0] ? toDelivery(rows[0]) : null;
  },

  /** Ajoute une personne au lot en attente (sans doublon). */
  async join(id: string, userId: string): Promise<Delivery | null> {
    const { rows } = await pool.query<Row>(
      `UPDATE deliveries SET joined_by_ids = CASE WHEN requested_by_id = $2 OR $2 = ANY(joined_by_ids) THEN joined_by_ids ELSE array_append(joined_by_ids, $2) END
        WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id, userId],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  },

  /**
   * Passe le déploiement en attente du projet en cours, si aucun autre ne l'est : l'index unique partiel
   * `deliveries_deploy_running_idx` garantit qu'il n'y en a jamais deux (verrou par projet, entre instances).
   */
  async startQueuedDeploy(projectId: string, instanceId: string): Promise<Delivery | null> {
    try {
      const { rows } = await pool.query<Row>(
        `UPDATE deliveries SET status = 'running', started_at = now(), instance_id = $2
          WHERE id = (SELECT id FROM deliveries WHERE project_id = $1 AND kind = 'deploy' AND status = 'queued' LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM deliveries WHERE project_id = $1 AND kind = 'deploy' AND status = 'running')
          RETURNING *`,
        [projectId, instanceId],
      );
      return rows[0] ? toDelivery(rows[0]) : null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  },

  /** Termine une livraison en cours (statut final), sauf si elle a été annulée entre-temps. */
  async finish(id: string, status: DeliveryStatus, patch: DeliveryPatch = {}): Promise<Delivery | null> {
    return this.updateActive(id, { ...patch, status, finishedAt: new Date() });
  },

  /** Livraisons en cours menées par une instance qui n'est plus vivante : marquées en échec ; renvoie leurs projets. */
  async failOrphans(liveInstanceIds: string[], message: string): Promise<{ id: string; projectId: string; kind: DeliveryKind; sessionId: string | null }[]> {
    const { rows } = await pool.query<{ id: string; project_id: string; kind: DeliveryKind; session_id: string | null }>(
      `UPDATE deliveries SET status = 'failed', error = $2, finished_at = now(),
              steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'message', $2::text, 'level', 'error'))
        WHERE status = 'running' AND (instance_id IS NULL OR NOT (instance_id = ANY($1::uuid[])))
        RETURNING id, project_id, kind, session_id`,
      [liveInstanceIds, message],
    );
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, kind: r.kind, sessionId: r.session_id }));
  },

  /** Projets qui ont un déploiement en attente. */
  async projectsWithQueuedDeploy(): Promise<string[]> {
    const { rows } = await pool.query<{ project_id: string }>(`SELECT DISTINCT project_id FROM deliveries WHERE kind = 'deploy' AND status = 'queued'`);
    return rows.map((r) => r.project_id);
  },

  async getConfig(projectId: string): Promise<DeployConfig | null> {
    const { rows } = await pool.query<ConfigRow>('SELECT * FROM deploy_configs WHERE project_id = $1', [projectId]);
    return rows[0] ? toConfig(rows[0]) : null;
  },

  async setConfig(projectId: string, input: DeployConfigInput, userId: string): Promise<DeployConfig> {
    const { rows } = await pool.query<ConfigRow>(
      `INSERT INTO deploy_configs (project_id, vault_item, command, branch, timeout_minutes, updated_by_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (project_id) DO UPDATE SET vault_item = EXCLUDED.vault_item, command = EXCLUDED.command, branch = EXCLUDED.branch,
         timeout_minutes = EXCLUDED.timeout_minutes, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()
       RETURNING *`,
      [projectId, input.vaultItem, input.command, input.branch ?? null, input.timeoutMinutes ?? 30, userId],
    );
    return toConfig(rows[0]);
  },

  async deleteConfig(projectId: string): Promise<void> {
    await pool.query('DELETE FROM deploy_configs WHERE project_id = $1', [projectId]);
  },
};
