import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { RELAUNCH_SESSION } from '../graphql/sessions';
import { canAutoFocus } from '../lib/device';

/** Libellé de l'action, partagé par les boutons qui ouvrent cette modale. */
export const RELAUNCH_LABEL = 'Repartir à neuf';
/** Infobulle des boutons « Repartir à neuf », à opposer à « Reprendre ». */
export const RELAUNCH_TITLE =
  "Nouvelle session sur le même dossier et la même branche, avec une conversation neuve : l'agent ne reçoit que les derniers échanges de celle-ci, en lecture. Utile quand la conversation est devenue trop longue ou s'est égarée. Pour continuer la même conversation, utilisez « Reprendre », « Redémarrer » ou écrivez un message.";

/**
 * « Repartir à neuf » (mutation relaunchSession) : une nouvelle session démarre avec une conversation neuve, les
 * derniers échanges de la session d'origine en contexte, dans le même dossier de travail et sur la même branche
 * (un nouveau dossier si le sien a été supprimé) ; la session d'origine est archivée (une seule session par dossier).
 * À ne pas confondre avec « Reprendre », qui continue la même conversation dans la même session.
 */
export default function RelaunchModal({
  session,
  projectName,
  onClose,
}: {
  session: { id: string; name: string; archivedAt?: string | null; status?: string; kind?: string; worksession?: { branch: string } | null };
  projectName: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(session.name);
  const [instruction, setInstruction] = useState('');
  const [relaunch, { loading, error }] = useMutation<{ relaunchSession: { id: string } }>(RELAUNCH_SESSION, {
    refetchQueries: ['Sidebar', 'Sessions', 'ArchivedSessions'],
    onCompleted: (res) => {
      onClose();
      navigate(`/sessions/${res.relaunchSession.id}`);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    relaunch({ variables: { id: session.id, input: { name: name.trim() || null, instruction: instruction.trim() || null } } });
  };
  const chat = session.kind === 'CHAT';
  const running = session.status === 'RUNNING' || session.status === 'QUEUED';
  const folder = chat
    ? null
    : session.worksession
      ? <>le même dossier de travail, sur la branche <code>{session.worksession.branch}</code> : les fichiers et commits sont conservés</>
      : <>un nouveau dossier de travail (celui de la session a été supprimé)</>;
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Repartir à neuf dans une nouvelle session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small mb-2">
            L'agent repart d'une conversation neuve, plus légère : utile quand celle-ci est devenue trop longue, coûteuse ou s'est égarée.
          </p>
          <ul className="small text-secondary ps-3 mb-2">
            <li>Une nouvelle session de {projectName} démarre{folder && <>, dans {folder}</>}.</li>
            <li>L'agent n'a pas la mémoire de « {session.name} » : il en reçoit les derniers échanges, en texte, pour contexte.</li>
            <li>
              {session.archivedAt
                ? "« " + session.name + " » reste dans l'historique."
                : `« ${session.name} » est ${running ? 'arrêtée puis ' : ''}archivée ; elle reste consultable dans l'historique.`}
            </li>
          </ul>
          <p className="small text-secondary">
            Pour continuer <strong>la même conversation</strong>, fermez cette fenêtre et écrivez simplement un message à la session (ou « Reprendre ») ;
            pour seulement recharger ses outils (serveurs MCP, coffre, réglages) en gardant tout son contexte, utilisez « Redémarrer ».
          </p>
          <Form.Group className="mb-3">
            <Form.Label>Nom de la nouvelle session</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={name} onChange={(e) => setName(e.target.value)} />
          </Form.Group>
          <Form.Group>
            <Form.Label>Première instruction</Form.Label>
            <Form.Control as="textarea" rows={3} placeholder="Facultatif : par défaut, l'agent continue le travail là où il s'est arrêté" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          </Form.Group>
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? 'Lancement…' : 'Démarrer la nouvelle session'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
