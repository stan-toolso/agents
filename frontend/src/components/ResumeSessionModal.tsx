import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { SEND_SESSION_MESSAGE } from '../graphql/operations';
import { UNARCHIVE_SESSION } from '../graphql/sessions';
import { canAutoFocus } from '../lib/device';

/** Message proposé pour reprendre une session arrêtée, modifiable. */
export const RESUME_SESSION_MESSAGE = "Continue là où tu t'étais arrêté.";

/**
 * Reprise d'une session arrêtée (terminée, en échec, arrêtée, archivée) : un message, modifiable, envoyé dans sa
 * conversation comme depuis sa page — même session, même nom, même historique, même dossier. Archivée, elle est
 * d'abord restaurée avec son dossier (refusé si une autre session y travaille). « Relancer » reste là pour repartir
 * d'une nouvelle session.
 */
export default function ResumeSessionModal({ session, onRelaunch, onClose }: { session: { id: string; name: string; archivedAt?: string | null }; onRelaunch?: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState(RESUME_SESSION_MESSAGE);
  const [unarchive, { loading: restoring, error: restoreError }] = useMutation(UNARCHIVE_SESSION, { refetchQueries: ['Sidebar', 'ArchivedSessions', 'HistoryProject'] });
  const [send, { loading: sending, error: sendError }] = useMutation(SEND_SESSION_MESSAGE, { refetchQueries: ['Sidebar'] });
  const loading = restoring || sending;
  const error = restoreError ?? sendError;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      if (session.archivedAt) await unarchive({ variables: { id: session.id } });
      await send({ variables: { id: session.id, text } });
    } catch {
      return; // affiché dans la modale
    }
    onClose();
    navigate(`/sessions/${session.id}`);
  };
  return (
    <Modal show onHide={() => !loading && onClose()} centered backdrop={loading ? 'static' : true}>
      <Form onSubmit={(e) => void submit(e)}>
        <Modal.Header closeButton={!loading}>
          <Modal.Title className="h6">Reprendre la session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Le message est envoyé dans la conversation de « {session.name} », qui reprend là où elle s'était arrêtée : même session, même historique, même dossier de travail.
            {session.archivedAt && ' Elle est d’abord restaurée parmi les sessions actives.'}
          </p>
          <Form.Group className="mb-2">
            <Form.Label>Message</Form.Label>
            <Form.Control as="textarea" rows={4} autoFocus={canAutoFocus()} value={text} onChange={(e) => setText(e.target.value)} />
          </Form.Group>
          {onRelaunch && (
            <button type="button" className="btn btn-link btn-sm p-0" disabled={loading} onClick={onRelaunch}>
              Repartir plutôt d'une nouvelle session (Relancer)
            </button>
          )}
          {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !text.trim()}>
            {loading ? 'Envoi…' : 'Reprendre'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
