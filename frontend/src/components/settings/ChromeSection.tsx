import { useMutation } from '@apollo/client';
import { Alert, Badge, Button, Card } from 'react-bootstrap';
import { CHROME_EXTENSION_ZIP, MY_CHROME_BROWSERS, REMOVE_CHROME_BROWSER, type ChromeBrowser } from '../../graphql/chrome';
import { timeAgo } from '../../lib/humanize';
import { usePollingQuery } from '../../lib/usePollingQuery';
import { useDialogs } from '../Dialogs';
import PageLoading from '../PageLoading';

/** Navigateur lisible à partir de son user-agent (Chrome, Edge, Brave…) et de son système. */
function browserLabel(ua: string | null): string {
  if (!ua) return '';
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : 'Navigateur';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /CrOS/.test(ua) ? 'ChromeOS' : '';
  return [name, os].filter(Boolean).join(' · ');
}

/**
 * Paramètres › Chrome : extension « Skipper pour Chrome », qui laisse les sessions de la personne agir dans les
 * onglets qu'elle leur confie. Installation, navigateurs reliés (connectés ou non), retrait.
 */
export default function ChromeSection() {
  const { confirm, showError } = useDialogs();
  const { data, loading, error, refetch } = usePollingQuery<{ myChromeBrowsers: ChromeBrowser[] }>(MY_CHROME_BROWSERS, { pollInterval: 10_000 });
  const [remove] = useMutation(REMOVE_CHROME_BROWSER, { onError: (e) => void showError(e), onCompleted: () => void refetch() });
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const browsers = data?.myChromeBrowsers ?? [];

  return (
    <>
      <Card className="mb-4">
        <Card.Header>
          <i className="bi bi-browser-chrome me-2" />
          Skipper pour Chrome
        </Card.Header>
        <Card.Body>
          <p className="small">
            L'extension laisse vos sessions Skipper agir dans <strong>votre</strong> navigateur, avec vos comptes connectés : lire une page, cliquer, remplir un formulaire, faire une capture,
            lire la console. Elles n'ont accès qu'aux onglets que vous leur confiez (groupe « Skipper ») et à ceux qu'elles ouvrent elles-mêmes ; chaque action passe par votre
            autorisation, comme les autres outils.
          </p>
          <ol className="small mb-3">
            <li>
              Téléchargez l'extension et décompressez l'archive.{' '}
              <Button size="sm" variant="outline-primary" href={CHROME_EXTENSION_ZIP} className="ms-1">
                <i className="bi bi-download me-1" />
                skipper-chrome.zip
              </Button>
            </li>
            <li>
              Dans Chrome, ouvrez <code>chrome://extensions</code>, activez le <em>mode développeur</em>, puis « Charger l'extension non empaquetée » et choisissez le dossier{' '}
              <code>skipper-chrome</code>.
            </li>
            <li>Cliquez sur l'icône Skipper dans la barre de Chrome, puis « Connecter à Skipper » : une page de Skipper vous demande de confirmer.</li>
            <li>Sur une page à confier à vos sessions, icône Skipper › « Confier cet onglet à Skipper ».</li>
          </ol>
          <p className="small text-secondary mb-0">
            Les sessions de vos agents utilisent votre navigateur quand vous les avez convoqués ou que vous en avez pris la main. Une session déjà lancée voit l'extension à sa prochaine
            reprise.
          </p>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header>Navigateurs reliés</Card.Header>
        <Card.Body className="p-0">
          {browsers.length === 0 ? (
            <p className="small text-secondary m-3">Aucun navigateur relié pour l'instant.</p>
          ) : (
            browsers.map((b) => (
              <div key={b.id} className="d-flex flex-wrap align-items-center gap-2 px-3 py-2 border-bottom">
                <div className="flex-grow-1" style={{ minWidth: 0 }}>
                  <div>
                    <i className="bi bi-browser-chrome me-2" />
                    {b.name}
                    {b.connected ? <Badge bg="success" className="ms-2">connecté</Badge> : <Badge bg="secondary" className="ms-2">hors ligne</Badge>}
                  </div>
                  <div className="small text-secondary">
                    {[browserLabel(b.userAgent), b.extensionVersion ? `extension ${b.extensionVersion}` : '', `relié ${timeAgo(b.createdAt)}`, b.lastUsedAt ? `vu ${timeAgo(b.lastUsedAt)}` : '', b.prefix]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline-danger"
                  onClick={async () => {
                    if (await confirm({ title: 'Retirer ce navigateur', message: `Le jeton de « ${b.name} » est révoqué et l'extension déconnectée : vos sessions n'y auront plus accès.`, confirmLabel: 'Retirer', danger: true }))
                      void remove({ variables: { id: b.id } });
                  }}
                >
                  Retirer
                </Button>
              </div>
            ))
          )}
        </Card.Body>
      </Card>
    </>
  );
}
