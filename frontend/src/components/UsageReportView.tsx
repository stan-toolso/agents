import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, ButtonGroup, Card, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { SET_PROJECT_BUDGET, USAGE_REPORT, type UsageReport, type UsageReportDay, type UsageReportProject } from '../graphql/usage';
import { costUnitLabel, formatCost, getCostUnit } from '../lib/humanize';
import { useElementWidth } from '../lib/useElementWidth';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';
import PageLoading from './PageLoading';
import '../pages/dashboard.css';
import '../pages/usage.css';

/**
 * Relevé de consommation (query usageReport) : tuiles, coût par jour et par semaine, par projet (avec le budget
 * mensuel), par modèle, et les sessions les plus coûteuses. Une seule source côté serveur (usage_ledger), donc des
 * totaux qui se recoupent. Partagé par Paramètres › Consommation (tous les projets) et l'onglet Consommation d'un projet.
 */

export const USAGE_PERIODS = [7, 30, 90] as const;
const PERIOD_KEY = 'skipper.usage.days';

/** Période choisie (7, 30 ou 90 jours), mémorisée dans le navigateur. */
export function useUsagePeriod(): [number, (d: number) => void] {
  const [days, setDays] = useState(() => {
    const saved = Number(localStorage.getItem(PERIOD_KEY));
    return (USAGE_PERIODS as readonly number[]).includes(saved) ? saved : 30;
  });
  return [
    days,
    (d: number) => {
      localStorage.setItem(PERIOD_KEY, String(d));
      setDays(d);
    },
  ];
}

const n = (v: number) => v.toLocaleString('fr-FR');
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

export function PeriodPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <ButtonGroup size="sm" aria-label="Période">
      {USAGE_PERIODS.map((d) => (
        <Button key={d} variant={d === days ? 'primary' : 'outline-secondary'} onClick={() => onChange(d)}>
          {d} jours
        </Button>
      ))}
    </ButtonGroup>
  );
}

/** Colonnes d'une seule série (couleur d'accent) ; infobulle par colonne, valeur du pic écrite au-dessus. */
function CostBars({ rows, label, ariaLabel, lastLabel }: { rows: UsageReportDay[]; label: (r: UsageReportDay) => string; ariaLabel: string; lastLabel?: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  if (!rows.length) return null;
  const height = 120;
  const padTop = 16;
  const padBottom = 16;
  const plotH = height - padTop - padBottom;
  const max = Math.max(...rows.map((d) => d.usd), 0.01);
  const slot = width / rows.length;
  const barW = Math.min(28, Math.max(3, slot - 2));
  const peak = rows.reduce((a, b) => (b.usd > a.usd ? b : a), rows[0]);
  const last = rows[rows.length - 1];
  return (
    <div ref={ref} className="dash-chart-wrap">
      {width > 0 && (
        <svg className="dash-chart usage-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
          <line x1={0} x2={width} y1={height - padBottom} y2={height - padBottom} />
          {rows.map((d, i) => {
            const h = d.usd > 0 ? Math.max(2, (d.usd / max) * plotH) : 0;
            const x = i * slot + (slot - barW) / 2;
            const y = height - padBottom - h;
            return (
              <g key={d.day}>
                <rect x={x} y={y} width={barW} height={h} rx={Math.min(4, barW / 2)} className={d === last ? 'bar today' : 'bar'} />
                <rect x={i * slot} y={0} width={slot} height={height} className="hit">
                  <title>{`${label(d)} : ${formatCost(d.usd)} · ${d.turns} tour${d.turns > 1 ? 's' : ''}`}</title>
                </rect>
                {d === peak && d.usd > 0 && (
                  <text x={Math.min(width - 4, Math.max(4, x + barW / 2))} y={Math.max(10, y - 3)} textAnchor={i < rows.length / 4 ? 'start' : i > (rows.length * 3) / 4 ? 'end' : 'middle'}>
                    {formatCost(d.usd)}
                  </text>
                )}
              </g>
            );
          })}
          <text x={2} y={height - 3}>{label(rows[0])}</text>
          <text x={width - 2} y={height - 3} textAnchor="end">{lastLabel ?? label(last)}</text>
        </svg>
      )}
    </div>
  );
}

/** Jauge du budget du mois : accent, puis avertissement à 80 %, puis rouge une fois atteint (toujours avec le texte). */
export function BudgetMeter({ monthUsd, budget }: { monthUsd: number; budget: number | null }) {
  if (!budget) return <span className="text-secondary small">Aucun budget</span>;
  const p = pct(monthUsd, budget);
  const state = p >= 100 ? 'over' : p >= 80 ? 'warn' : '';
  return (
    <div className="usage-budget" title={`${formatCost(monthUsd)} consommés ce mois-ci sur un budget de ${formatCost(budget)}`}>
      <div className="dash-meter">
        <div className={state} style={{ width: `${Math.min(100, p)}%` }} />
      </div>
      <span className={`small${state === 'over' ? ' text-danger fw-semibold' : state === 'warn' ? ' text-warning' : ' text-secondary'}`}>
        {state === 'over' && <i className="bi bi-exclamation-octagon me-1" />}
        {state === 'warn' && <i className="bi bi-exclamation-triangle me-1" />}
        {p} % de {formatCost(budget)}
      </span>
    </div>
  );
}

/** Saisie du budget mensuel d'un projet (fenêtre de l'application) ; vide ou 0 : aucun budget. */
export function useEditBudget() {
  const { prompt, showError } = useDialogs();
  const [setBudget] = useMutation(SET_PROJECT_BUDGET, { refetchQueries: ['UsageReport'] });
  return async (projectId: string, projectName: string, current: number | null) => {
    const value = await prompt({
      title: `Budget mensuel · ${projectName}`,
      message: (
        <>
          En {costUnitLabel()} par mois calendaire, toutes les sessions du projet confondues. Les membres sont prévenus à 80 % ; une fois le budget atteint, le projet ne lance plus de session ni de tour. Vide ou 0 : aucun budget.
        </>
      ),
      defaultValue: current ? String(current) : '',
      placeholder: 'ex. 200',
      confirmLabel: 'Enregistrer',
      required: false,
    });
    if (value === null) return;
    const amount = value === '' ? null : Number(value.replace(',', '.').replace(/\s/g, ''));
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      showError(new Error('Montant invalide : un nombre positif, ou vide pour retirer le budget'));
      return;
    }
    await setBudget({ variables: { projectId, monthlyBudgetUsd: amount || null } }).catch(showError);
  };
}

function ProjectsTable({ projects, total, canEditBudget }: { projects: UsageReportProject[]; total: number; canEditBudget: boolean }) {
  const editBudget = useEditBudget();
  return (
    <Table size="sm" responsive className="mb-0 usage-table">
      <thead>
        <tr>
          <th>Projet</th>
          <th className="text-end">Coût</th>
          <th className="text-end d-none d-md-table-cell">Part</th>
          <th className="text-end d-none d-md-table-cell">Tours</th>
          <th className="text-end d-none d-md-table-cell">Sessions</th>
          <th>Budget du mois</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p, i) => (
          <tr key={p.projectId ?? `deleted-${i}`}>
            <td className="text-truncate" style={{ maxWidth: 240 }}>
              {p.projectId ? <Link to={`/projects/${p.projectId}/usage`}>{p.isPersonal ? `${p.projectName} (espace personnel)` : p.projectName}</Link> : <span className="text-secondary">{p.projectName}</span>}
            </td>
            <td className="text-end text-nowrap">{formatCost(p.usd)}</td>
            <td className="text-end d-none d-md-table-cell text-secondary">{pct(p.usd, total)} %</td>
            <td className="text-end d-none d-md-table-cell">{n(p.turns)}</td>
            <td className="text-end d-none d-md-table-cell">{n(p.sessions)}</td>
            <td style={{ minWidth: 170 }}>
              <div className="d-flex align-items-center gap-2">
                <div className="flex-grow-1">{p.projectId && <BudgetMeter monthUsd={p.monthUsd} budget={p.monthlyBudgetUsd} />}</div>
                {canEditBudget && p.projectId && (
                  <Button size="sm" variant="link" className="p-0" title="Modifier le budget mensuel" aria-label={`Modifier le budget de ${p.projectName}`} onClick={() => void editBudget(p.projectId!, p.projectName, p.monthlyBudgetUsd)}>
                    <i className="bi bi-pencil" />
                  </Button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ModelBars({ report }: { report: UsageReport }) {
  const max = Math.max(...report.byModel.map((m) => m.usd), 0.0001);
  const sum = report.byModel.reduce((a, m) => a + m.usd, 0);
  if (!report.byModel.length) return <div className="text-secondary small">Aucun modèle sur la période.</div>;
  return (
    <div className="usage-bars">
      {report.byModel.map((m) => (
        <div key={m.model} className="usage-bars-row" title={`${m.model} : ${formatCost(m.usd)} · ${n(m.turns)} tours`}>
          <span className="usage-bars-label text-truncate">{m.model}</span>
          <span className="usage-bars-track">
            <span className="usage-bars-fill" style={{ width: `${Math.max(1, (m.usd / max) * 100)}%` }} />
          </span>
          <span className="usage-bars-value">
            {formatCost(m.usd)} <span className="text-secondary">· {pct(m.usd, sum)} %</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function DataTable({ rows, label }: { rows: UsageReportDay[]; label: (r: UsageReportDay) => string }) {
  return (
    <details className="usage-data mt-2">
      <summary className="small text-secondary">Voir les données</summary>
      <Table size="sm" className="mb-0 mt-1">
        <thead>
          <tr>
            <th>Période</th>
            <th className="text-end">Coût</th>
            <th className="text-end">Tours</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.day}>
              <td>{label(r)}</td>
              <td className="text-end">{formatCost(r.usd)}</td>
              <td className="text-end">{n(r.turns)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </details>
  );
}

/**
 * Relevé d'un projet (projectId) ou de tous les projets (projectId null : administrateurs). `canEditBudget` : bouton de
 * modification du budget sur chaque ligne de projet.
 */
export default function UsageReportView({ projectId, days, canEditBudget }: { projectId: string | null; days: number; canEditBudget: boolean }) {
  const { data, loading, error } = usePollingQuery<{ usageReport: UsageReport }>(USAGE_REPORT, { variables: { projectId, days }, pollInterval: 60_000, fetchPolicy: 'cache-and-network' });
  if (loading && !data) return <PageLoading />;
  if (error && !data) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const r = data?.usageReport;
  if (!r) return null;
  const weekLabel = (w: UsageReportDay) => `semaine du ${dayLabel(w.day)}`;
  const unitNote = getCostUnit() === 'CREDIT' ? 'en crédits' : 'estimation au tarif API';
  return (
    <>
      <div className="dash-tiles mb-3">
        <div className="dash-tile">
          <div className="dash-tile-label"><i className="bi bi-coin" /> Coût sur {r.days} jours</div>
          <div className="dash-tile-value">{formatCost(r.usd)}</div>
          <div className="dash-tile-sub">{unitNote}</div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label"><i className="bi bi-arrow-repeat" /> Tours</div>
          <div className="dash-tile-value">{n(r.turns)}</div>
          <div className="dash-tile-sub">{r.turns ? `${formatCost(r.usd / r.turns)} par tour en moyenne` : 'aucun tour'}</div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label"><i className="bi bi-chat-square-text" /> Sessions</div>
          <div className="dash-tile-value">{n(r.sessions)}</div>
          <div className="dash-tile-sub">{r.sessions ? `${formatCost(r.usd / r.sessions)} par session en moyenne` : 'aucune session'}</div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label"><i className="bi bi-calendar-day" /> Aujourd’hui</div>
          <div className="dash-tile-value">{formatCost(r.byDay[r.byDay.length - 1]?.usd ?? 0)}</div>
          <div className="dash-tile-sub">{n(r.byDay[r.byDay.length - 1]?.turns ?? 0)} tours</div>
        </div>
      </div>

      <div className="usage-grid">
        <section className="dash-section">
          <h2 className="dash-section-title"><span>Par jour</span></h2>
          <Card>
            <Card.Body className="pb-2">
              <CostBars rows={r.byDay} label={(d) => dayLabel(d.day)} lastLabel="aujourd’hui" ariaLabel={`Coût par jour sur ${r.days} jours`} />
              <DataTable rows={r.byDay} label={(d) => dayLabel(d.day)} />
            </Card.Body>
          </Card>
        </section>
        <section className="dash-section">
          <h2 className="dash-section-title"><span>Par semaine</span></h2>
          <Card>
            <Card.Body className="pb-2">
              <CostBars rows={r.byWeek} label={weekLabel} lastLabel="cette semaine" ariaLabel={`Coût par semaine sur ${r.days} jours`} />
              <DataTable rows={r.byWeek} label={weekLabel} />
            </Card.Body>
          </Card>
        </section>
      </div>

      <section className="dash-section">
        <h2 className="dash-section-title"><span>{projectId ? 'Budget du projet' : 'Par projet'}</span></h2>
        <Card>
          <Card.Body className="py-2">
            {r.byProject.length ? <ProjectsTable projects={r.byProject} total={r.usd} canEditBudget={canEditBudget} /> : <div className="text-secondary small">Aucune consommation sur la période.</div>}
          </Card.Body>
        </Card>
      </section>

      <section className="dash-section">
        <h2 className="dash-section-title"><span>Par modèle</span></h2>
        <Card>
          <Card.Body>
            <ModelBars report={r} />
          </Card.Body>
        </Card>
      </section>

      <section className="dash-section">
        <h2 className="dash-section-title"><span>Sessions les plus coûteuses</span></h2>
        <Card>
          <Card.Body className="py-2">
            {r.topSessions.length ? (
              <Table size="sm" responsive className="mb-0 usage-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    {!projectId && <th className="d-none d-md-table-cell">Projet</th>}
                    <th className="d-none d-md-table-cell">Par</th>
                    <th className="text-end">Tours</th>
                    <th className="text-end">Coût</th>
                  </tr>
                </thead>
                <tbody>
                  {r.topSessions.map((s, i) => (
                    <tr key={s.sessionId ?? `deleted-${i}`}>
                      <td className="text-truncate" style={{ maxWidth: 280 }}>
                        {s.sessionId && s.sessionName ? <Link to={`/sessions/${s.sessionId}`}>{s.sessionName}</Link> : <span className="text-secondary">Session supprimée</span>}
                      </td>
                      {!projectId && <td className="d-none d-md-table-cell text-secondary">{s.projectName ?? '—'}</td>}
                      <td className="d-none d-md-table-cell text-secondary">{s.ownerName ?? '—'}</td>
                      <td className="text-end">{n(s.turns)}</td>
                      <td className="text-end text-nowrap">{formatCost(s.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <div className="text-secondary small">Aucune session sur la période.</div>
            )}
          </Card.Body>
        </Card>
      </section>
    </>
  );
}

