import { Button, Form } from 'react-bootstrap';
import type { SharedPage, SharedPageSource } from '../../graphql/misc';
import { timeAgo } from '../../lib/humanize';
import './pageData.css';

/** Intervalles proposés pour le rafraîchissement automatique (minutes) ; 0 = à la demande. */
export const REFRESH_CHOICES: [number, string][] = [
  [0, 'À la demande'],
  [5, 'Toutes les 5 minutes'],
  [15, 'Toutes les 15 minutes'],
  [60, 'Toutes les heures'],
  [360, 'Toutes les 6 heures'],
  [1440, 'Tous les jours'],
  [10080, 'Toutes les semaines'],
];

export function refreshLabel(minutes: number | null): string {
  if (!minutes) return 'à la demande';
  const known = REFRESH_CHOICES.find(([m]) => m === minutes);
  if (known) return known[1].toLowerCase();
  return minutes % 1440 === 0 ? `tous les ${minutes / 1440} jours` : minutes % 60 === 0 ? `toutes les ${minutes / 60} heures` : `toutes les ${minutes} minutes`;
}

const STATE: Record<SharedPageSource['status'], { label: string; icon: string }> = {
  ok: { label: 'À jour', icon: 'bi-check2' },
  error: { label: 'Erreur', icon: 'bi-x-circle' },
  skipped: { label: 'Non rafraîchie', icon: 'bi-pause-circle' },
  pending: { label: 'Jamais rafraîchie', icon: 'bi-hourglass' },
};

function SourceCard({ s, full }: { s: SharedPageSource; full: boolean }) {
  const st = STATE[s.status];
  const where = s.kind === 'sql' ? `${s.item ?? '?'}${s.database ? ` · ${s.database}` : ''}` : `script ${s.interpreter ?? ''}`;
  const code = s.kind === 'sql' ? s.query : s.code;
  return (
    <div className="pd-src">
      <div className="pd-src-head">
        <span className="pd-src-kind" title={s.kind === 'sql' ? 'Requête SQL (coffre)' : "Script lancé dans l'environnement du projet"}>
          <i className={`bi ${s.kind === 'sql' ? 'bi-database' : 'bi-terminal'}`} />
        </span>
        <span className="pd-src-name" title={`Skipper.data.${s.name}`}>
          {s.name}
        </span>
        <span className="pd-src-where" title={where}>
          {where}
        </span>
        <span className={`pd-state ${s.status}`}>
          <i className={`bi ${st.icon}`} /> {st.label}
        </span>
      </div>
      <div className="pd-src-meta">
        {s.refreshedAt && <span title={new Date(s.refreshedAt).toLocaleString()}>Données {timeAgo(s.refreshedAt)}</span>}
        {s.rowCount != null && <span>{s.rowCount} ligne{s.rowCount > 1 ? 's' : ''}</span>}
        {s.durationMs != null && s.status !== 'pending' && <span>{s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(1)} s` : `${s.durationMs} ms`}</span>}
        {s.status === 'error' && s.refreshedAt && <span>Dernières données conservées</span>}
      </div>
      {s.error && <div className={`pd-src-error${s.status === 'skipped' ? ' skipped' : ''}`}>{s.error}</div>}
      {full && code && (
        <details className="pd-src-code">
          <summary>
            <i className="bi bi-chevron-right" /> {s.kind === 'sql' ? 'Requête' : 'Script'}
          </summary>
          <pre>{code}</pre>
        </details>
      )}
    </div>
  );
}

export interface PageDataProps {
  page: SharedPage;
  /** Propriétaire ou administrateur : rafraîchir, régler l'intervalle, voir les requêtes. */
  manage: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSetRefresh: (minutes: number) => void;
  /** Demander une modification à l'agent (propriétaire d'une page avec session, transmission non désactivée). */
  onAskAgent?: () => void;
  onClose: () => void;
}

/** Panneau « Données » : rafraîchissement (bouton, intervalle) et état de chaque source. */
export default function PageData({ page, manage, refreshing, onRefresh, onSetRefresh, onAskAgent, onClose }: PageDataProps) {
  const failing = page.sources.filter((s) => s.status === 'error' || s.status === 'skipped').length;
  return (
    <aside className="pc-panel pd-panel" aria-label="Données de l'artefact">
      <div className="pc-head">
        <span className="pc-title">
          <i className="bi bi-bar-chart-line" /> Données
          {failing > 0 && <span className="pc-count" title={`${failing} source${failing > 1 ? 's' : ''} en défaut`}>{failing}</span>}
        </span>
        <Button variant="link" size="sm" className="pc-close ms-auto text-secondary" onClick={onClose} aria-label="Fermer le panneau des données">
          <i className="bi bi-x-lg" />
        </Button>
      </div>
      <div className="pd-refresh">
        <div className="pd-refresh-text">
          {page.dataRefreshedAt ? (
            <>
              <strong>Mis à jour {timeAgo(page.dataRefreshedAt)}</strong>
              <br />
              Rafraîchissement {refreshLabel(page.refreshMinutes)}
              {page.refreshMinutes ? ' · en veille après 14 jours sans lecture' : ''}
            </>
          ) : (
            <>
              <strong>Pas encore rafraîchi</strong>
              <br />
              Rafraîchissement {refreshLabel(page.refreshMinutes)}
            </>
          )}
        </div>
        {manage && (
          <Button size="sm" variant="primary" onClick={onRefresh} disabled={refreshing || !page.sources.length} title="Exécuter toutes les sources maintenant">
            <i className={`bi bi-arrow-repeat${refreshing ? ' spin' : ''}`} /> {refreshing ? 'En cours…' : 'Rafraîchir'}
          </Button>
        )}
      </div>
      {manage && (
        <div className="pd-refresh" style={{ paddingTop: 0, borderBottom: '1px solid var(--cc-border)' }}>
          <Form.Select size="sm" value={page.refreshMinutes ?? 0} onChange={(e) => onSetRefresh(Number(e.target.value))} aria-label="Rafraîchissement automatique">
            {REFRESH_CHOICES.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
            {page.refreshMinutes && !REFRESH_CHOICES.some(([m]) => m === page.refreshMinutes) ? <option value={page.refreshMinutes}>Toutes les {page.refreshMinutes} minutes</option> : null}
          </Form.Select>
          <span className="pd-refresh-text">Rafraîchissement automatique</span>
        </div>
      )}
      <div className="pd-list">
        {page.sources.length === 0 ? <div className="pd-empty">Aucune source de données : la page n'a rien à afficher. Demandez à l'agent d'en déclarer (pages.publish, sources).</div> : page.sources.map((s) => <SourceCard key={s.id} s={s} full={manage} />)}
      </div>
      <div className="pd-foot">
        Les sources sont exécutées au nom du propriétaire, en lecture seule ; une source en erreur garde ses dernières données.
        {onAskAgent && (
          <>
            {' '}
            <button type="button" className="btn btn-link p-0 align-baseline" onClick={onAskAgent}>
              Demander une modification à l'agent
            </button>
            .
          </>
        )}
      </div>
    </aside>
  );
}
