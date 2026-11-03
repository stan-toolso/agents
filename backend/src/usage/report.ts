import { pool } from '../db/pool.js';
import { projectBudget } from '../projects/budget.js';

/**
 * Relevé de consommation sur une période (page « Consommation » : Paramètres pour les administrateurs, onglet d'un
 * projet pour ses membres). Une seule source, `usage_ledger` (un enregistrement par tour facturé d'une session) :
 * les totaux par projet, par jour, par semaine et par session se recoupent ; la ventilation par modèle vient de la
 * colonne `models` de chaque tour (à l'arrondi près).
 *
 * Les jours sont ceux du fuseau du processus Node (comme la page Facturation), les semaines commencent le lundi.
 */

export interface UsageAmount {
  usd: number;
  turns: number;
}
export interface UsageReportDay extends UsageAmount {
  /** AAAA-MM-JJ ; pour une semaine, son lundi. */
  day: string;
}
export interface UsageReportProject extends UsageAmount {
  /** Null : projet supprimé depuis (les tours restent comptés). */
  projectId: string | null;
  projectName: string;
  isPersonal: boolean;
  sessions: number;
  /** Consommation du mois calendaire en cours (celle que le budget compare), indépendante de la période. */
  monthUsd: number;
  monthlyBudgetUsd: number | null;
}
export interface UsageReportModel extends UsageAmount {
  model: string;
}
export interface UsageReportSession extends UsageAmount {
  sessionId: string | null;
  sessionName: string | null;
  projectId: string | null;
  projectName: string | null;
  ownerName: string | null;
}
export interface UsageReport extends UsageAmount {
  from: Date;
  to: Date;
  days: number;
  sessions: number;
  byProject: UsageReportProject[];
  byModel: UsageReportModel[];
  byDay: UsageReportDay[];
  byWeek: UsageReportDay[];
  topSessions: UsageReportSession[];
}

export const MAX_REPORT_DAYS = 366;
const TOP_SESSIONS = 15;

const pad = (n: number) => String(n).padStart(2, '0');
/** AAAA-MM-JJ d'une date dans le fuseau du processus. */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Début de la période : minuit (fuseau du processus) du premier des `days` derniers jours, aujourd'hui compris. */
export function periodStart(days: number, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
}

/** Tous les jours de la période, à zéro quand rien n'a été consommé. */
export function fillDays(rows: UsageReportDay[], from: Date, now = new Date()): UsageReportDay[] {
  const byKey = new Map(rows.map((r) => [r.day, r]));
  const out: UsageReportDay[] = [];
  const last = dayKey(now);
  for (let d = new Date(from); ; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const key = dayKey(d);
    const r = byKey.get(key);
    out.push({ day: key, usd: r?.usd ?? 0, turns: r?.turns ?? 0 });
    if (key >= last) break;
  }
  return out;
}

/** Lundi (AAAA-MM-JJ) de la semaine d'un jour AAAA-MM-JJ. */
export function weekOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const shift = (date.getDay() + 6) % 7; // lundi = 0
  return dayKey(new Date(y, m - 1, d - shift));
}

/** Regroupe les jours par semaine (la première et la dernière peuvent être partielles). */
export function weeksOf(days: UsageReportDay[]): UsageReportDay[] {
  const out = new Map<string, UsageReportDay>();
  for (const d of days) {
    const key = weekOf(d.day);
    const w = out.get(key) ?? { day: key, usd: 0, turns: 0 };
    w.usd += d.usd;
    w.turns += d.turns;
    out.set(key, w);
  }
  return [...out.values()];
}

const n = (v: string | number | null | undefined) => Number(v ?? 0);

/**
 * Relevé des `days` derniers jours. `projectIds` null : tous les projets (administrateurs) ; sinon les projets donnés.
 */
export async function usageReport(projectIds: string[] | null, days = 30, now = new Date()): Promise<UsageReport> {
  const span = Math.min(Math.max(Math.round(days) || 30, 1), MAX_REPORT_DAYS);
  const from = periodStart(span, now);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Filtre commun : $1 période, $2 projets (null = tous).
  const scope = 'l.recorded_at >= $1 AND ($2::uuid[] IS NULL OR l.project_id = ANY($2::uuid[]))';
  const params = [from, projectIds];
  const [totals, byDay, byProject, byModel, top, budgeted] = await Promise.all([
    pool.query<{ usd: string; turns: string; sessions: string }>(`SELECT COALESCE(sum(l.cost_usd), 0)::text AS usd, count(*)::text AS turns, count(DISTINCT l.session_id)::text AS sessions FROM usage_ledger l WHERE ${scope}`, params),
    pool.query<{ day: string; usd: string; turns: string }>(
      `SELECT to_char(l.recorded_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, sum(l.cost_usd)::text AS usd, count(*)::text AS turns
         FROM usage_ledger l WHERE ${scope} GROUP BY 1`,
      [...params, timeZone],
    ),
    pool.query<{ project_id: string | null; project_name: string | null; personal: boolean | null; budget: string | null; usd: string; turns: string; sessions: string }>(
      `SELECT l.project_id, p.name AS project_name, p.personal_owner_id IS NOT NULL AS personal, p.monthly_budget_usd::text AS budget,
              sum(l.cost_usd)::text AS usd, count(*)::text AS turns, count(DISTINCT l.session_id)::text AS sessions
         FROM usage_ledger l LEFT JOIN projects p ON p.id = l.project_id
        WHERE ${scope}
        GROUP BY l.project_id, p.name, p.personal_owner_id, p.monthly_budget_usd
        ORDER BY sum(l.cost_usd) DESC`,
      params,
    ),
    pool.query<{ model: string; usd: string; turns: string }>(
      `SELECT m.key AS model, sum((m.value)::numeric)::text AS usd, count(*)::text AS turns
         FROM usage_ledger l, jsonb_each_text(l.models) AS m
        WHERE ${scope}
        GROUP BY m.key ORDER BY sum((m.value)::numeric) DESC`,
      params,
    ),
    pool.query<{ session_id: string | null; session_name: string | null; project_id: string | null; project_name: string | null; owner_name: string | null; usd: string; turns: string }>(
      `SELECT l.session_id, s.name AS session_name, l.project_id, p.name AS project_name, u.name AS owner_name,
              sum(l.cost_usd)::text AS usd, count(*)::text AS turns
         FROM usage_ledger l
         LEFT JOIN sessions s ON s.id = l.session_id
         LEFT JOIN projects p ON p.id = l.project_id
         LEFT JOIN users u ON u.id = s.owner_id
        WHERE ${scope}
        GROUP BY l.session_id, s.name, l.project_id, p.name, u.name
        ORDER BY sum(l.cost_usd) DESC LIMIT ${TOP_SESSIONS}`,
      params,
    ),
    // Projets avec un budget mais sans consommation sur la période : ils apparaissent quand même (jauge du budget).
    pool.query<{ id: string; name: string; personal: boolean; budget: string }>(
      `SELECT id, name, personal_owner_id IS NOT NULL AS personal, monthly_budget_usd::text AS budget
         FROM projects WHERE monthly_budget_usd IS NOT NULL AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
      [projectIds],
    ),
  ]);

  const projects: UsageReportProject[] = byProject.rows.map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name ?? 'Projet supprimé',
    isPersonal: Boolean(r.personal),
    usd: n(r.usd),
    turns: n(r.turns),
    sessions: n(r.sessions),
    monthUsd: 0,
    monthlyBudgetUsd: r.budget == null ? null : n(r.budget),
  }));
  for (const b of budgeted.rows) {
    if (!projects.some((p) => p.projectId === b.id)) projects.push({ projectId: b.id, projectName: b.name, isPersonal: b.personal, usd: 0, turns: 0, sessions: 0, monthUsd: 0, monthlyBudgetUsd: n(b.budget) });
  }
  const month = await projectBudget.monthSpentOf(projects.flatMap((p) => (p.projectId ? [p.projectId] : [])), now);
  for (const p of projects) if (p.projectId) p.monthUsd = month.get(p.projectId) ?? 0;

  const dayRows = fillDays(
    byDay.rows.map((r) => ({ day: r.day, usd: n(r.usd), turns: n(r.turns) })),
    from,
    now,
  );
  const t = totals.rows[0];
  return {
    from,
    to: now,
    days: span,
    usd: n(t.usd),
    turns: n(t.turns),
    sessions: n(t.sessions),
    byProject: projects,
    byModel: byModel.rows.map((r) => ({ model: r.model, usd: n(r.usd), turns: n(r.turns) })),
    byDay: dayRows,
    byWeek: weeksOf(dayRows),
    topSessions: top.rows.map((r) => ({ sessionId: r.session_id, sessionName: r.session_name, projectId: r.project_id, projectName: r.project_name, ownerName: r.owner_name, usd: n(r.usd), turns: n(r.turns) })),
  };
}
