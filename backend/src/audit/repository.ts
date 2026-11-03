import { toJson } from '../db/json.js';
import { pool, type Queryable } from '../db/pool.js';
import { actorKindOf, type AuditEntry, type AuditFilter, type AuditInput } from './types.js';

interface Row {
  id: string;
  project_id: string | null;
  actor_user_id: string | null;
  session_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  created_at: Date;
}

const toEntry = (r: Row): AuditEntry => {
  const base = { actorUserId: r.actor_user_id, sessionId: r.session_id };
  return {
    id: String(r.id),
    projectId: r.project_id,
    ...base,
    actorLabel: r.actor_label,
    actorKind: actorKindOf(base),
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: r.target_label,
    details: r.details ?? {},
    createdAt: r.created_at,
  };
};

/** Clause WHERE des filtres (paramètres numérotés à partir de $1). Exportée pour les tests. */
export function filterSql(f: AuditFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [f.projectId];
  const clauses = ['project_id = $1'];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    clauses.push(sql(params.length));
  };
  if (f.actorUserId) add((n) => `actor_user_id = $${n}`, f.actorUserId);
  if (f.sessionId) add((n) => `session_id = $${n}`, f.sessionId);
  if (f.actorKind === 'agent') clauses.push('session_id IS NOT NULL');
  else if (f.actorKind === 'human') clauses.push('session_id IS NULL AND actor_user_id IS NOT NULL');
  else if (f.actorKind === 'system') clauses.push('session_id IS NULL AND actor_user_id IS NULL');
  if (f.targetType) add((n) => `target_type = $${n}`, f.targetType);
  if (f.action) add((n) => `action = $${n}`, f.action);
  if (f.from) add((n) => `created_at >= $${n}`, f.from);
  if (f.to) add((n) => `created_at < $${n}`, f.to);
  if (f.before && /^\d+$/.test(f.before)) add((n) => `id < $${n}`, f.before);
  return { where: clauses.join(' AND '), params };
}

export const auditRepository = {
  async insert(e: AuditInput, db: Queryable = pool): Promise<void> {
    const actor = e.actor ?? {};
    // Session d'agent sans personne indiquée : la personne (ou l'agent de projet) qui la porte, et son nom de session.
    await db.query(
      `INSERT INTO audit_log (project_id, actor_user_id, session_id, actor_label, action, target_type, target_id, target_label, details)
       SELECT $1, COALESCE($2::uuid, s.owner_id), $3::uuid, COALESCE($4, s.name, u.name, u.email), $5, $6, $7, $8, $9
       FROM (SELECT 1) one
       LEFT JOIN sessions s ON s.id = $3::uuid
       LEFT JOIN users u ON u.id = COALESCE($2::uuid, s.owner_id)`,
      [e.projectId, actor.userId ?? null, actor.sessionId ?? null, actor.label ?? null, e.action, e.targetType, e.targetId ?? null, e.targetLabel ?? null, toJson(e.details ?? {})],
    );
  },

  async list(f: AuditFilter, db: Queryable = pool): Promise<AuditEntry[]> {
    const { where, params } = filterSql(f);
    params.push(Math.max(1, Math.min(f.limit ?? 100, 10_000)));
    const { rows } = await db.query<Row>(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
    return rows.map(toEntry);
  },

  /** Acteurs et types de cible présents dans le journal du projet (listes des filtres). */
  async facets(projectId: string, db: Queryable = pool): Promise<{ actorUserIds: string[]; targetTypes: string[]; actions: string[] }> {
    const [actors, types] = await Promise.all([
      db.query<{ actor_user_id: string }>('SELECT DISTINCT actor_user_id FROM audit_log WHERE project_id = $1 AND actor_user_id IS NOT NULL', [projectId]),
      db.query<{ target_type: string; action: string }>('SELECT DISTINCT target_type, action FROM audit_log WHERE project_id = $1 ORDER BY target_type, action', [projectId]),
    ]);
    return {
      actorUserIds: actors.rows.map((r) => r.actor_user_id),
      targetTypes: [...new Set(types.rows.map((r) => r.target_type))],
      actions: types.rows.map((r) => r.action),
    };
  },
};
