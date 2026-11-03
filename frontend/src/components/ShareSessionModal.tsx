import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { CREATE_SESSION_SHARE, REVOKE_SESSION_SHARE, type SessionShare } from '../graphql/operations';
import { useDialogs } from './Dialogs';

/** Durées proposées pour un lien, en jours (le serveur accepte jusqu'à 30). */
export const SHARE_DURATIONS: Array<{ days: number; label: string }> = [
  { days: 1 / 24, label: '1 heure' },
  { days: 1, label: '1 jour' },
  { days: 7, label: '7 jours' },
  { days: 30, label: '30 jours' },
];

function expiry(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState<'ok' | 'ko' | null>(null);
  const copy = () => {
    const done = (r: 'ok' | 'ko') => {
      setCopied(r);
      window.setTimeout(() => setCopied(null), 2000);
    };
    if (!navigator.clipboard) return done('ko');
    navigator.clipboard.writeText(url).then(() => done('ok'), () => done('ko'));
  };
  return (
    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={copy} title="Copier le lien">
      <i className={`bi ${copied === 'ok' ? 'bi-check2' : 'bi-clipboard'} me-1`} />
      {copied === 'ok' ? 'Copié' : copied === 'ko' ? 'Copie refusée' : 'Copier'}
    </button>
  );
}

/**
 * Partage d'une session par lien public : quiconque a le lien lit le transcript sans se connecter, en lecture seule,
 * secrets masqués, jusqu'à l'expiration. Liste des liens valables, création (durée au choix) et révocation.
 */
export default function ShareSessionModal({ session, onClose }: { session: { id: string; name: string; shares?: SessionShare[] }; onClose: () => void }) {
  const { confirm } = useDialogs();
  const [days, setDays] = useState(SHARE_DURATIONS[2].days);
  const [create, { loading: creating, error: createError }] = useMutation(CREATE_SESSION_SHARE, { refetchQueries: ['Session'] });
  const [revoke, { error: revokeError }] = useMutation(REVOKE_SESSION_SHARE, { refetchQueries: ['Session'] });
  const shares = session.shares ?? [];
  const error = createError ?? revokeError;
  const onRevoke = async (share: SessionShare) => {
    const ok = await confirm({ title: 'Révoquer le lien', message: "Le lien cessera aussitôt de fonctionner pour tous ceux qui l'ont reçu.", confirmLabel: 'Révoquer', danger: true });
    if (ok) await revoke({ variables: { id: share.id } }).catch(() => undefined);
  };
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h6">Partager « {session.name} »</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="small text-secondary">
          Toute personne qui a le lien lit le transcript de la session (instructions, réponses, appels d'outils, demandes et réponses), sans se connecter et sans pouvoir agir. La
          réflexion de l'agent, les coûts et les fichiers joints ne sont pas montrés ; les secrets reconnus (jetons, mots de passe, clés) sont masqués.
        </p>
        <Form
          className="d-flex gap-2 align-items-end mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create({ variables: { sessionId: session.id, expiresInDays: days } }).catch(() => undefined);
          }}
        >
          <Form.Group>
            <Form.Label className="small mb-1">Valable</Form.Label>
            <Form.Select size="sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Durée du lien">
              {SHARE_DURATIONS.map((d) => (
                <option key={d.label} value={d.days}>
                  {d.label}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Button type="submit" size="sm" disabled={creating}>
            <i className="bi bi-link-45deg me-1" />
            {creating ? 'Création…' : 'Créer un lien'}
          </Button>
        </Form>
        {shares.length === 0 ? (
          <div className="small text-secondary">Aucun lien actif.</div>
        ) : (
          <ul className="list-unstyled mb-0 share-links">
            {shares.map((s) => (
              <li key={s.id} className="mb-2">
                <div className="d-flex gap-2 align-items-center">
                  <Form.Control size="sm" readOnly value={s.url} className="font-monospace" onFocus={(e) => e.currentTarget.select()} aria-label="Lien de partage" />
                  <CopyButton url={s.url} />
                  <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => void onRevoke(s)} title="Révoquer ce lien">
                    Révoquer
                  </button>
                </div>
                <div className="small text-secondary mt-1">
                  Expire le {expiry(s.expiresAt)}
                  {s.createdBy && ` · créé par ${s.createdBy.name}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onClose}>
          Fermer
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
