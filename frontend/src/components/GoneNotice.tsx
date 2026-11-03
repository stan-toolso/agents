import { useEffect, type ReactNode } from 'react';
import { Button } from 'react-bootstrap';
import { useLocation } from 'react-router-dom';
import { tabKey, useTabs } from '../workbench/TabsContext';

const pathOf = (url: string) => url.split('?')[0];

/**
 * Page d'un élément qui n'existe plus (session, terminal, dossier de travail, projet supprimés ou devenus
 * inaccessibles), typiquement un onglet restauré au chargement : à la place d'une erreur, un message et un bouton
 * qui ferme l'onglet. L'onglet est aussitôt retiré de la mémoire du navigateur : il ne revient pas au prochain chargement.
 *
 * `scope` : `tab` ferme l'onglet qui affiche la page (une session ou ses fichiers : son dossier de travail a disparu
 * avec elle) ; `page` retire seulement la page de l'onglet (un terminal supprimé dans un dossier toujours là : l'onglet
 * revient sur sa session ou ses fichiers).
 */
export default function GoneNotice({ what, scope = 'tab', children }: { what: string; scope?: 'tab' | 'page'; children?: ReactNode }) {
  const { pathname } = useLocation();
  const { tabs, closeMatching, forgetTabs } = useTabs();
  // Onglet qui affiche cette page : celui dont l'URL est la page, sinon celui de son chemin.
  const owner = tabs.find((t) => pathOf(t.url) === pathname)?.key ?? tabKey(pathname);
  const match = (key: string) => key === pathname || (scope === 'tab' && key === owner);
  useEffect(() => {
    forgetTabs(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, owner, scope, forgetTabs]);
  return (
    <div className="gone-notice m-3">
      <div className="d-flex align-items-center gap-3 flex-wrap">
        <span className="text-secondary">
          <i className="bi bi-slash-circle me-2" />
          {what} n'existe plus (supprimé, ou vous n'y avez plus accès).
        </span>
        <Button size="sm" variant="outline-secondary" onClick={() => closeMatching(match)}>
          {scope === 'tab' ? "Fermer l'onglet" : 'Fermer'}
        </Button>
      </div>
      {children}
    </div>
  );
}
