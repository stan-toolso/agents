import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { PIN_ARTIFACT_TO_COCKPIT, type CockpitLayoutData } from '../graphql/cockpit';
import { REGION_LABELS, type Region } from './types';

/**
 * « Épingler dans un tableau de bord » depuis un artefact : choix de la portée (mon accueil ; le tableau de bord du
 * projet d'origine, connu du propriétaire), de la région et d'un titre. Le serveur ajoute le bloc en fin de région
 * (nouvelle version de l'agencement) et avertit si l'artefact n'est pas visible par toute l'équipe.
 */
export default function PinArtifactModal({ page, onClose }: { page: { id: string; title: string; linkAccess: boolean; projectAccess: boolean; project: { id: string; name: string } | null }; onClose: () => void }) {
  const { showError } = useDialogs();
  const [scope, setScope] = useState(page.project ? `project:${page.project.id}` : 'home');
  const [region, setRegion] = useState<Region>('full');
  const [title, setTitle] = useState('');
  const [done, setDone] = useState<CockpitLayoutData | null>(null);
  const [pin, { loading }] = useMutation<{ pinArtifactToCockpit: CockpitLayoutData }>(PIN_ARTIFACT_TO_COCKPIT, { refetchQueries: ['CockpitLayout'] });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await pin({ variables: { scope, artifactId: page.id, region, title: title.trim() || null } });
      if (res.data) setDone(res.data.pinArtifactToCockpit);
    } catch (err) {
      await showError(err);
    }
  };
  const target = scope === 'home' ? '/' : `/projects/${scope.slice('project:'.length)}`;
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Épingler « {page.title} »</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {done ? (
            <>
              <Alert variant="success" className="py-2">
                Bloc ajouté (version {done.version}). <Link to={target}>Voir le tableau de bord</Link>
              </Alert>
              {done.warnings.map((w) => (
                <Alert key={w} variant="warning" className="py-2 small">{w}</Alert>
              ))}
            </>
          ) : (
            <>
              <Form.Group className="mb-3">
                <Form.Label className="small mb-1">Où</Form.Label>
                <Form.Select size="sm" value={scope} onChange={(e) => setScope(e.target.value)}>
                  {page.project && <option value={`project:${page.project.id}`}>Tableau de bord du projet « {page.project.name} »</option>}
                  <option value="home">Mon accueil</option>
                </Form.Select>
                {scope !== 'home' && !page.linkAccess && !page.projectAccess && <Form.Text className="text-warning">L’artefact n’est ouvert ni aux membres du projet ni par le lien : les autres membres ne le verront pas. Ouvrez-le depuis « Partager ».</Form.Text>}
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label className="small mb-1">Région</Form.Label>
                <Form.Select size="sm" value={region} onChange={(e) => setRegion(e.target.value as Region)}>
                  {(['full', 'main', 'side', 'tiles'] as Region[]).map((r) => (
                    <option key={r} value={r}>{REGION_LABELS[r]}</option>
                  ))}
                </Form.Select>
              </Form.Group>
              <Form.Group>
                <Form.Label className="small mb-1">Titre du bloc</Form.Label>
                <Form.Control size="sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={page.title} />
              </Form.Group>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" size="sm" onClick={onClose}>{done ? 'Fermer' : 'Annuler'}</Button>
          {!done && (
            <Button type="submit" variant="primary" size="sm" disabled={loading}>
              <i className="bi bi-pin-angle me-1" />Épingler
            </Button>
          )}
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
