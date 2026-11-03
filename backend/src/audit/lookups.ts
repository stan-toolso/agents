import { pool } from '../db/pool.js';

/** Projet et libellé d'une cible, lus avant la mutation (une suppression ne laisse plus rien à lire après). */
export interface TargetInfo {
  projectId: string | null;
  label: string | null;
}

/** Une requête par type de cible : `$1` est l'identifiant ; colonnes `project_id` et `label`. */
const QUERIES = {
  project: 'SELECT id AS project_id, name AS label FROM projects WHERE id = $1',
  session: 'SELECT project_id, name AS label FROM sessions WHERE id = $1',
  session_share: 'SELECT s.project_id, s.name AS label FROM session_shares sh JOIN sessions s ON s.id = sh.session_id WHERE sh.id = $1',
  task: 'SELECT project_id, title AS label FROM tasks WHERE id = $1',
  request: 'SELECT s.project_id, r.title AS label FROM requests r JOIN sessions s ON s.id = r.session_id WHERE r.id = $1',
  worksession: `SELECT project_id, COALESCE(NULLIF(label, ''), name) || ' (' || branch || ')' AS label FROM worksessions WHERE id = $1`,
  vault_item: 'SELECT owner_project_id AS project_id, name AS label FROM vault_items WHERE id = $1',
  vault_link: 'SELECT l.project_id, i.name AS label FROM vault_item_links l JOIN vault_items i ON i.id = l.item_id WHERE l.id = $1',
  permission_rule: `SELECT project_id, tool_name || COALESCE('(' || NULLIF(rule_content, '') || ')', '') AS label FROM project_permission_rules WHERE id = $1`,
  api_key: 'SELECT project_id, name AS label FROM project_api_keys WHERE id = $1',
  notification_channel: "SELECT project_id, kind || ' ' || target_hint AS label FROM notification_channels WHERE id = $1",
  pull_request: `SELECT project_id, '#' || number || ' ' || COALESCE(title, '') AS label FROM pull_requests WHERE id = $1`,
  agent: 'SELECT a.project_id, COALESCE(u.name, u.email) AS label FROM agent_profiles a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1',
  env_file: 'SELECT project_id, path AS label FROM project_env_files WHERE id = $1',
  context_folder: 'SELECT project_id, name AS label FROM context_folders WHERE id = $1',
  context_instruction: 'SELECT project_id, name AS label FROM context_instructions WHERE id = $1',
  workflow: 'SELECT project_id, name AS label FROM workflows WHERE id = $1',
  workflow_run: 'SELECT r.project_id, w.name AS label FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1',
  conversation: 'SELECT project_id, name AS label FROM conversations WHERE id = $1',
  shared_page: 'SELECT project_id, title AS label FROM shared_pages WHERE id = $1',
  user: 'SELECT NULL::uuid AS project_id, COALESCE(NULLIF(name, \'\'), email) AS label FROM users WHERE id = $1',
} as const;

export type TargetKind = keyof typeof QUERIES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function lookupTarget(kind: TargetKind, id: string | null | undefined): Promise<TargetInfo | null> {
  if (!id || !UUID.test(id)) return null;
  const { rows } = await pool.query<{ project_id: string | null; label: string | null }>(QUERIES[kind], [id]);
  return rows[0] ? { projectId: rows[0].project_id, label: rows[0].label } : null;
}
