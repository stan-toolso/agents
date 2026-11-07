import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { settingsRepository } from '../settings/repository.js';
import { describeSlots, SLOT_HOURS } from './ctoTime.js';
import { computeStatement, monthKey, monthStartOf, nextMonthStart, RECENT_DAYS } from './statement.js';
import { defaultBillingSettings, type BillingSettings, type BillingStatement, type CtoTimeEntry, type CtoTimeEntryInput } from './types.js';

const KEY = 'billing';

const NUMERIC_FIELDS = ['baseMonthlyEur', 'includedProjects', 'extraProjectEur', 'creditPriceEur', 'creditsPerUsd', 'creditsPerManDay', 'ctoDailyRateEur', 'ctoHoursPerDay', 'usdToEur'] as const;

/** Valide un réglage de facturation : nombres positifs ou nuls, projets compris entiers, nom non vide. */
export function validateBillingSettings(value: BillingSettings): BillingSettings {
  for (const f of NUMERIC_FIELDS) {
    const n = value[f];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new AppError(`Facturation : ${f} doit être un nombre positif ou nul`);
  }
  if (!Number.isInteger(value.includedProjects)) throw new AppError('Facturation : le nombre de projets compris doit être entier');
  if (value.ctoHoursPerDay <= 0 || value.ctoHoursPerDay > 24) throw new AppError("Facturation : une journée de CTO compte entre 0 et 24 heures");
  const planName = value.planName.trim();
  if (!planName) throw new AppError("Facturation : nom de l'offre requis");
  return { ...value, planName };
}

interface CtoRow {
  id: string;
  day: string;
  hours: string;
  project_id: string | null;
  project_name: string | null;
  description: string;
  created_by_name: string | null;
  created_at: Date;
  source: 'manual' | 'auto';
  user_name: string | null;
  slots: number | null;
}

const toEntry = (r: CtoRow): CtoTimeEntry => ({
  id: r.id,
  day: r.day,
  hours: Number(r.hours),
  projectId: r.project_id,
  projectName: r.project_name,
  description: r.description,
  createdByName: r.created_by_name,
  createdAt: r.created_at,
  source: r.source,
  userName: r.user_name,
  slots: r.slots,
});

const ENTRY_SELECT = `SELECT e.id, to_char(e.day, 'YYYY-MM-DD') AS day, e.hours::text AS hours, e.project_id, p.name AS project_name,
                             e.description, u.name AS created_by_name, e.created_at, e.source,
                             COALESCE(NULLIF(c.name, ''), c.email) AS user_name, e.slots
                        FROM cto_time_entries e
                        LEFT JOIN projects p ON p.id = e.project_id
                        LEFT JOIN users u ON u.id = e.created_by
                        LEFT JOIN users c ON c.id = e.user_id`;

/** Tranches du suivi des CTO pas encore consolidées, par jour, personne et projet : des saisies provisoires. */
async function pendingCtoEntries(monthStart: Date, monthEnd: Date, timeZone: string): Promise<CtoTimeEntry[]> {
  const { rows } = await pool.query<{ day: string; user_id: string; user_name: string | null; project_id: string | null; project_name: string | null; slots: number; last_at: Date }>(
    `SELECT to_char(s.slot_start AT TIME ZONE $3, 'YYYY-MM-DD') AS day, s.user_id, COALESCE(NULLIF(u.name, ''), u.email) AS user_name,
            s.project_id, p.name AS project_name, count(*)::int AS slots, max(s.slot_start) AS last_at
       FROM cto_activity_slots s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.consolidated_at IS NULL AND s.slot_start >= $1 AND s.slot_start < $2
      GROUP BY 1, 2, 3, 4, 5`,
    [monthStart, monthEnd, timeZone],
  );
  return rows.map((r) => ({
    id: `pending:${r.day}:${r.user_id}:${r.project_id ?? 'none'}`,
    day: r.day,
    hours: Math.round(r.slots * SLOT_HOURS * 100) / 100,
    projectId: r.project_id,
    projectName: r.project_name,
    description: `${describeSlots(r.slots)}, consolidé en fin de journée`,
    createdByName: null,
    createdAt: r.last_at,
    source: 'pending',
    userName: r.user_name,
    slots: r.slots,
  }));
}

/** Facturation de la cellule : réglages (super administrateur), temps CTO et relevé mensuel. */
export const billingService = {
  /** Réglages enregistrés, ou null tant qu'un super administrateur ne les a pas saisis. */
  async stored(): Promise<BillingSettings | null> {
    const value = await settingsRepository.get<Partial<BillingSettings>>(KEY);
    return value ? { ...defaultBillingSettings, ...value } : null;
  },

  async settings(): Promise<BillingSettings> {
    return (await this.stored()) ?? defaultBillingSettings;
  },

  async update(patch: Partial<BillingSettings>): Promise<BillingSettings> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null));
    const next = validateBillingSettings({ ...(await this.settings()), ...defined });
    await settingsRepository.set(KEY, next);
    return next;
  },

  async addCtoTime(input: CtoTimeEntryInput, userId: string): Promise<CtoTimeEntry> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new AppError('Date invalide (AAAA-MM-JJ attendu)');
    if (!(input.hours > 0 && input.hours <= 24)) throw new AppError('Durée invalide : entre 0 et 24 heures');
    const { rows } = await pool.query<{ id: string }>('INSERT INTO cto_time_entries (day, hours, project_id, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      input.day,
      input.hours,
      input.projectId || null,
      (input.description ?? '').trim(),
      userId,
    ]);
    const entry = await pool.query<CtoRow>(`${ENTRY_SELECT} WHERE e.id = $1`, [rows[0].id]);
    return toEntry(entry.rows[0]);
  },

  async deleteCtoTime(id: string): Promise<boolean> {
    if (id.startsWith('pending:')) throw new AppError('Temps en cours de suivi : il se supprime une fois consolidé, en fin de journée');
    const { rowCount } = await pool.query('DELETE FROM cto_time_entries WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundError('Saisie de temps introuvable');
    return true;
  },

  /** Relevé du mois `AAAA-MM` (mois courant par défaut). `withOperator` : coût réel et marge (super administrateur). */
  async statement(month: string | null | undefined, withOperator: boolean, now = new Date()): Promise<BillingStatement> {
    let monthStart: Date;
    try {
      monthStart = monthStartOf(month, now);
    } catch (err) {
      throw new AppError((err as Error).message);
    }
    const monthEnd = nextMonthStart(monthStart);
    // Jours du graphique : ceux du fuseau du serveur Node (celui de monthStart), quel que soit celui de la base ;
    // ils s'arrêtent à aujourd'hui pour le mois courant.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const days: string[] = [];
    for (let d = new Date(monthStart); d < monthEnd && d <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      days.push(`${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`);
    }
    const [stored, projects, byProject, byDay, recent, entries, pending] = await Promise.all([
      this.stored(),
      pool.query<{ n: string }>('SELECT count(*) AS n FROM projects WHERE personal_owner_id IS NULL AND created_at < $1', [now < monthEnd ? now : monthEnd]),
      pool.query<{ project_id: string | null; project_name: string | null; usd: string }>(
        `SELECT p.id AS project_id, p.name AS project_name, sum(l.cost_usd)::text AS usd
           FROM usage_ledger l
           LEFT JOIN sessions s ON s.id = l.session_id
           LEFT JOIN projects p ON p.id = COALESCE(l.project_id, s.project_id)
          WHERE l.recorded_at >= $1 AND l.recorded_at < $2
          GROUP BY p.id, p.name`,
        [monthStart, monthEnd],
      ),
      pool.query<{ day: string; usd: string }>(
        `SELECT to_char(recorded_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, sum(cost_usd)::text AS usd
           FROM usage_ledger WHERE recorded_at >= $1 AND recorded_at < $2
          GROUP BY 1`,
        [monthStart, monthEnd, timeZone],
      ),
      pool.query<{ usd: string }>('SELECT COALESCE(sum(cost_usd), 0)::text AS usd FROM usage_ledger WHERE recorded_at > $1 AND recorded_at <= $2', [new Date(now.getTime() - RECENT_DAYS * 86_400_000), now]),
      pool.query<CtoRow>(`${ENTRY_SELECT} WHERE e.day >= $1::date AND e.day < $2::date ORDER BY e.day DESC, e.created_at DESC`, [`${monthKey(monthStart)}-01`, `${monthKey(monthEnd)}-01`]),
      pendingCtoEntries(monthStart, monthEnd, timeZone),
    ]);
    return computeStatement(
      stored ?? defaultBillingSettings,
      stored !== null,
      {
        monthStart,
        now,
        projectCount: Number(projects.rows[0].n),
        usageByProject: byProject.rows.map((r) => ({ projectId: r.project_id, projectName: r.project_name, usd: Number(r.usd) })),
        usageByDay: days.map((day) => ({ day, usd: Number(byDay.rows.find((r) => r.day === day)?.usd ?? 0) })),
        recentUsd: Number(recent.rows[0].usd),
        ctoEntries: [...pending, ...entries.rows.map(toEntry)].sort((a, b) => b.day.localeCompare(a.day)),
      },
      withOperator,
    );
  },
};
