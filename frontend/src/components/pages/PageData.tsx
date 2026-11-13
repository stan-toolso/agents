import { Button, Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import type { SharedPage, SharedPageAlert, SharedPageSource } from '../../graphql/misc';
import { timeAgo } from '../../lib/humanize';
import { REFRESH_CHOICES, refreshLabel } from '../../lib/refreshChoices';
import './pageData.css';

export { REFRESH_CHOICES, refreshLabel };

const STATE: Record<SharedPageSource['status'], { label: string; icon: string }> = {
  ok: { label: 'À jour', icon: 'bi-check2' },
  error: { label: 'Erreur', icon: 'bi-x-circle' },
  skipped: { label: 'Non rafraîchie', icon: 'bi-pause-circle' },
  pending: { label: 'Jamais rafraîchie', icon: 'bi-hourglass' },
  inactive: { label: 'Modifiée depuis', icon: 'bi-clock-history' },
  live: { label: 'Vivante', icon: 'bi-lightning-charge' },
  running: { label: 'En calcul', icon: 'bi-robot' },
};

const KIND: Record<SharedPageSource['kind'], { icon: string; title: string }> = {
  sql: { icon: 'bi-database', title: 'Requête SQL (coffre)' },
  script: { icon: 'bi-terminal', title: "Script lancé dans l'environnement du projet" },
  graphql: { icon: 'bi-lightning-charge', title: "Requête GraphQL sur l'API de Skipper, exécutée à chaque lecture avec les droits de la personne qui regarde" },
  agent: { icon: 'bi-robot', title: 'Calculée par une session à chaque rafraîchissement, qui écrit le résultat (pages.set_data)' },
};

function SourceCard({ s, full }: { s: SharedPageSource; full: boolean }) {
  const st = STATE[s.status];
  const where =
    s.kind === 'sql'
      ? `${s.item ?? '?'}${s.database ? ` · ${s.database}` : ''}`
      : s.kind === 'graphql'
        ? 'API de Skipper · droits de la personne qui regarde'
        : s.kind === 'agent'
          ? `session ${s.agent ? `de ${s.agent}` : 'du propriétaire'}`
          : `script ${s.interpreter ?? ''}`;
  const code = s.kind === 'script' ? s.code : s.kind === 'agent' ? s.prompt : s.query;
  const kind = KIND[s.kind] ?? KIND.script;
  return (
    <div className="pd-src">
      <div className="pd-src-head">
        <span className="pd-src-kind" title={kind.title}>
          <i className={`bi ${kind.icon}`} />
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
        {s.kind === 'agent' && s.sessionId && (
          <Link to={`/sessions/${s.sessionId}`} title="Session lancée pour calculer la source">
            {s.status === 'running' ? 'Session en cours' : 'Dernière session'}
          </Link>
        )}
      </div>
      {s.error && <div className={`pd-src-error${s.status === 'skipped' ? ' skipped' : ''}`}>{s.error}</div>}
      {full && code && (
        <details className="pd-src-code">
          <summary>
            <i className="bi bi-chevron-right" /> {s.kind === 'script' ? 'Script' : s.kind === 'agent' ? 'Consigne' : 'Requête'}
          </summary>
          <pre>{code}</pre>
          {s.kind === 'graphql' && s.variables && Object.keys(s.variables).length > 0 && <pre>{`variables : ${JSON.stringify(s.variables, null, 1)}`}</pre>}
        </details>
      )}
    </div>
  );
}

const ALERT_STATE: Record<SharedPageAlert['state'], { label: string; icon: string }> = {
  firing: { label: 'Déclenchée', icon: 'bi-exclamation-triangle-fill' },
  ok: { label: 'Normale', icon: 'bi-check2' },
  unknown: { label: 'Pas encore évaluée', icon: 'bi-hourglass' },
};

const shortJson = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/** Une règle d'alerte : condition, actions, état (déclenchée ou normale) et dernière valeur évaluée. */
function AlertCard({ a, full }: { a: SharedPageAlert; full: boolean }) {
  const st = ALERT_STATE[a.state] ?? ALERT_STATE.unknown;
  const actions = [a.notify === 'owner' ? 'notifie le propriétaire' : a.notify === 'project' ? 'notifie le projet' : null, a.agent ? `convoque ${a.agent}` : a.launchesSession ? 'lance une session' : null].filter(Boolean).join(' · ');
  return (
    <div className={`pd-src pd-alert ${a.state}`}>
      <div className="pd-src-head">
        <span className="pd-src-kind" title="Règle d'alerte">
          <i className="bi bi-bell" />
        </span>
        <span className="pd-src-name" title={a.name}>
          {a.name}
        </span>
        <span className={`pd-state alert-${a.state}`}>
          <i className={`bi ${st.icon}`} /> {st.label}
        </span>
      </div>
      <div className="pd-alert-cond" title={a.condition}>
        Si {a.condition}
      </div>
      <div className="pd-src-meta">
        {a.message && <span>{a.message}</span>}
        {actions && <span>{actions}</span>}
        {a.state === 'firing' && a.triggeredAt && <span title={new Date(a.triggeredAt).toLocaleString()}>Depuis {timeAgo(a.triggeredAt)}</span>}
        {a.state === 'ok' && a.resolvedAt && <span title={new Date(a.resolvedAt).toLocaleString()}>Revenue à la normale {timeAgo(a.resolvedAt)}</span>}
        {a.evaluatedAt && a.lastValue != null && <span title={typeof a.lastValue === 'string' ? a.lastValue : JSON.stringify(a.lastValue)}>Valeur {shortJson(a.lastValue)}</span>}
        {a.streak > 0 && a.for > 1 && <span title="Anti-rebond : évaluations de suite nécessaires pour basculer">{a.streak}/{a.for} avant bascule</span>}
        {a.fireCount > 0 && <span>Déclenchée {a.fireCount} fois</span>}
        {a.sessionId && (
          <Link to={`/sessions/${a.sessionId}`} title="Dernière session lancée par l'alerte">
            Dernière session
          </Link>
        )}
      </div>
      {a.error && <div className="pd-src-error skipped">{a.error}</div>}
      {full && a.prompt && (
        <details className="pd-src-code">
          <summary>
            <i className="bi bi-chevron-right" /> Consigne
          </summary>
          <pre>{a.prompt}</pre>
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
  /** Ancienne version affichée : ses sources (lecture seule), le rafraîchissement agit sur la dernière version. */
  oldVersion?: number | null;
}

/** Panneau « Données » : rafraîchissement (bouton, intervalle) et état de chaque source. */
export default function PageData({ page, manage: canManage, refreshing, onRefresh, onSetRefresh, onAskAgent, onClose, oldVersion = null }: PageDataProps) {
  // Une ancienne version se consulte : rafraîchir et régler l'intervalle restent sur la dernière version.
  const manage = canManage && !oldVersion;
  const failing = page.sources.filter((s) => s.status === 'error' || s.status === 'skipped').length;
  // Une source agent lance une session à chaque rafraîchissement : une heure au moins entre deux.
  const hasAgent = page.sources.some((s) => s.kind === 'agent');
  // Alertes : celles de la dernière version (une ancienne version se consulte sans elles).
  const alerts = oldVersion ? [] : (page.alerts ?? []);
  const firing = alerts.filter((a) => a.state === 'firing').length;
  return (
    <aside className="pc-panel pd-panel" aria-label="Données de l'artefact">
      <div className="pc-head">
        <span className="pc-title">
          <i className="bi bi-bar-chart-line" /> Données
          {failing > 0 && <span className="pc-count" title={`${failing} source${failing > 1 ? 's' : ''} en défaut`}>{failing}</span>}
          {firing > 0 && (
            <span className="pc-count pd-firing" title={`${firing} alerte${firing > 1 ? 's' : ''} déclenchée${firing > 1 ? 's' : ''}`}>
              <i className="bi bi-bell-fill" /> {firing}
            </span>
          )}
        </span>
        <Button variant="link" size="sm" className="pc-close ms-auto text-secondary" onClick={onClose} aria-label="Fermer le panneau des données">
          <i className="bi bi-x-lg" />
        </Button>
      </div>
      {oldVersion && (
        <div className="pd-version-note">
          <i className="bi bi-clock-history" /> Sources de la version {oldVersion}. Celles qui n’ont pas changé depuis reçoivent les données actuelles ; les autres sont marquées « Modifiée depuis ».
        </div>
      )}
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
            {REFRESH_CHOICES.filter(([m]) => !hasAgent || m === 0 || m >= 60).map(([m, label]) => (
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
        {page.sources.length === 0 ? <div className="pd-empty">Aucune source de données : la page n'a rien à afficher. Demandez à l'agent d'en déclarer (pages.publish, sources).</div> : page.sources.map((s) => <SourceCard key={s.id} s={s} full={canManage} />)}
        {alerts.length > 0 && (
          <>
            <div className="pd-section">
              <i className="bi bi-bell" /> Alertes
            </div>
            {alerts.map((a) => (
              <AlertCard key={a.id} a={a} full={canManage} />
            ))}
          </>
        )}
      </div>
      <div className="pd-foot">
        Les sources sont exécutées au nom du propriétaire, en lecture seule ; une source en erreur garde ses dernières données.
        {hasAgent && ' Une source « agent » lance une session à chaque rafraîchissement (bouton ou intervalle) : elle consomme comme une session.'}
        {alerts.length > 0 && ' Les alertes sont évaluées à chaque rafraîchissement et ne préviennent qu’au franchissement (déclenchée, puis revenue à la normale).'}
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
