import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Card, Form } from 'react-bootstrap';
import { Link, useSearchParams } from 'react-router-dom';
import { CONNECT_CHROME_BROWSER, type ChromeBrowser } from '../graphql/chrome';
import { useTabTitle } from '../workbench/TabsContext';

/**
 * `/chrome/connect?state=…&name=…` : ouverte par l'extension « Skipper pour Chrome ». Après confirmation, un jeton est
 * créé pour ce navigateur et passé à l'extension dans le fragment de l'adresse (`#state=…&token=…`) : l'extension,
 * qui surveille cet onglet, le lit, vérifie `state` (le sien) et ferme l'onglet. Le fragment n'est jamais envoyé au
 * serveur ; il est effacé de l'historique aussitôt après.
 */
export default function ChromeConnectPage() {
  useTabTitle('Connecter Chrome');
  const [params] = useSearchParams();
  const state = params.get('state') ?? '';
  const [name, setName] = useState(params.get('name') || 'Chrome');
  const [done, setDone] = useState<ChromeBrowser | null>(null);
  const [connect, { loading, error }] = useMutation<{ connectChromeBrowser: { token: string; browser: ChromeBrowser } }>(CONNECT_CHROME_BROWSER);
  const validState = /^[0-9a-f-]{36}$/i.test(state);

  const confirm = async () => {
    const { data } = await connect({ variables: { name } });
    if (!data) return;
    const { token, browser } = data.connectChromeBrowser;
    window.location.hash = new URLSearchParams({ state, token }).toString();
    setDone(browser);
    // Le jeton ne reste pas dans l'historique du navigateur.
    setTimeout(() => window.history.replaceState(null, '', `${window.location.pathname}`), 3000);
  };

  return (
    <div className="mx-auto" style={{ maxWidth: 560 }}>
      <h1 className="h4 mb-3">
        <i className="bi bi-browser-chrome me-2" />
        Connecter l'extension Chrome
      </h1>
      {!validState ? (
        <Alert variant="warning">
          Cette page s'ouvre depuis l'extension « Skipper pour Chrome » (icône Skipper › « Connecter à Skipper »). Voir <Link to="/settings?section=chrome">Paramètres › Chrome</Link>.
        </Alert>
      ) : done ? (
        <Alert variant="success">
          Navigateur « {done.name} » relié. L'extension se connecte et ferme cet onglet. Confiez ensuite un onglet à Skipper depuis l'icône de l'extension.
        </Alert>
      ) : (
        <Card>
          <Card.Body>
            <p>
              L'extension demande à relier ce navigateur à votre compte Skipper. Vos sessions (et celles des agents que vous convoquez) pourront alors lire et piloter les onglets que vous leur
              confiez, avec vos comptes connectés. Chaque action passe par votre autorisation.
            </p>
            <Form.Group className="mb-3">
              <Form.Label>Nom de ce navigateur</Form.Label>
              <Form.Control value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Chrome du bureau" />
            </Form.Group>
            {error && <Alert variant="danger">{error.message}</Alert>}
            <div className="d-flex gap-2">
              <Button onClick={() => void confirm()} disabled={loading || !name.trim()}>
                Relier ce navigateur
              </Button>
              <Button variant="outline-secondary" onClick={() => window.close()}>
                Annuler
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}
    </div>
  );
}
