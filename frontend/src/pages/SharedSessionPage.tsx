import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useParams } from 'react-router-dom';
import { apiBaseUrl } from '../apollo';
import Transcript from '../components/Transcript';
import type { SessionEvent } from '../graphql/operations';
import { sessionStatusLabels } from '../lib/humanize';
import '../components/terminal.css';
import '../components/chat.css';
import './shared-session.css';

/** Réponse de GET /api/share/<token> (backend/src/sessionShares/route.ts). */
interface SharedSessionView {
  session: { name: string; projectName: string; ownerName: string | null; status: string; createdAt: string };
  expiresAt: string;
  truncated: boolean;
  events: SessionEvent[];
}

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error'; message: string } | { kind: 'ok'; view: SharedSessionView };

/**
 * Page publique `/share/<token>` : transcript d'une session partagée par lien, en lecture seule, sans connexion.
 * Rendue hors de l'application (ni sidebar, ni Apollo, ni compte) : une seule lecture HTTP, aucune mutation.
 */
export default function SharedSessionPage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [technical, setTechnical] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/api/share/${encodeURIComponent(token)}`, { credentials: 'omit' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) return setState({ kind: 'missing' });
        if (!res.ok) return setState({ kind: 'error', message: `Le serveur a répondu ${res.status}.` });
        setState({ kind: 'ok', view: (await res.json()) as SharedSessionView });
      })
      .catch((err: Error) => !cancelled && setState({ kind: 'error', message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    document.title = state.kind === 'ok' ? `${state.view.session.name} · session partagée` : 'Session partagée · Skipper';
  }, [state]);

  if (state.kind === 'loading')
    return (
      <div className="shared-session-center">
        <Spinner animation="border" size="sm" />
      </div>
    );
  if (state.kind !== 'ok')
    return (
      <div className="shared-session-center">
        <div>
          <h1 className="h5">Session introuvable</h1>
          <p className="text-secondary mb-0">{state.kind === 'missing' ? "Ce lien de partage n'existe pas, a expiré ou a été révoqué." : `Impossible de charger la session (${state.message}).`}</p>
        </div>
      </div>
    );

  const { session, expiresAt, truncated, events } = state.view;
  const status = (sessionStatusLabels as Record<string, string>)[session.status.toUpperCase()] ?? session.status;
  return (
    <div className="shared-session">
      <div className="cc">
        <div className="cc-header">
          <div className="cc-header-main">
            <span className="cc-title" title={session.name}>
              ✻ {session.name}
            </span>
            <span className="cc-meta">
              {' '}
              · {session.projectName}
              {session.ownerName && ` · ${session.ownerName}`} · {status.toLowerCase()}
            </span>
          </div>
          <span className="cc-meta shared-session-badge" title={`Lien valable jusqu'au ${new Date(expiresAt).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}`}>
            <i className="bi bi-eye" /> Lecture seule · expire le {new Date(expiresAt).toLocaleDateString('fr-FR', { dateStyle: 'medium' })}
          </span>
        </div>
        <div className="cc-toggle d-flex">
          <label>
            <input type="checkbox" checked={technical} onChange={() => setTechnical((v) => !v)} /> Afficher les détails techniques
          </label>
        </div>
        {truncated && <div className="cc-note warn px-3">Session très longue : seul le début du transcript est montré.</div>}
        <Transcript events={events} autoScroll={false} technical={technical} />
        <div className="cc-status">
          <span className="cc-dim">Session partagée depuis Skipper · secrets masqués · réflexion de l'agent et coûts non montrés</span>
        </div>
      </div>
    </div>
  );
}
