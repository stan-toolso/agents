import { Button } from 'react-bootstrap';
import { openFullSkipper } from '../lib/projectWindow';
import { useTabs } from '../workbench/TabsContext';

/**
 * Page hors du projet de la fenêtre (autre projet, chat, administration de Skipper) : à sa place, un message, un
 * bouton qui l'ouvre dans Skipper complet et un autre qui ferme l'onglet.
 */
export default function ProjectWindowNotice({ pathname, search }: { pathname: string; search: string }) {
  const { activeKey, closeTab } = useTabs();
  return (
    <div className="gone-notice m-3">
      <div className="d-flex align-items-center gap-3 flex-wrap">
        <span className="text-secondary">
          <i className="bi bi-window-stack me-2" />
          Cette page n'appartient pas au projet de cette fenêtre.
        </span>
        <Button size="sm" variant="primary" onClick={() => openFullSkipper(pathname + search)}>
          <i className="bi bi-box-arrow-up-right me-1" /> Ouvrir dans Skipper
        </Button>
        <Button size="sm" variant="outline-secondary" onClick={() => closeTab(activeKey)}>
          Fermer l'onglet
        </Button>
      </div>
    </div>
  );
}
