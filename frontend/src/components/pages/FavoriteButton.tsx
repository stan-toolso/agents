import { useMutation } from '@apollo/client';
import type { MouseEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { SET_SHARED_PAGE_FAVORITE } from '../../graphql/misc';
import { useDialogs } from '../Dialogs';

/**
 * Bascule « favori » d'un artefact : un artefact en favori garde son lien dans la sidebar (section « Favoris »).
 * Réponse optimiste (l'étoile change aussitôt), puis la liste de la sidebar est relue. Rien pour un invité des pages
 * partagées (pas de sidebar, et la mutation lui est refusée).
 */
export function useFavoriteToggle() {
  const { showError } = useDialogs();
  const [setFavorite] = useMutation(SET_SHARED_PAGE_FAVORITE, { refetchQueries: ['FavoriteSharedPages'] });
  return (page: { id: string; favorite: boolean }) =>
    void setFavorite({
      variables: { id: page.id, favorite: !page.favorite },
      optimisticResponse: { setSharedPageFavorite: { __typename: 'SharedPage', id: page.id, favorite: !page.favorite } },
    }).catch(showError);
}

export default function FavoriteButton({ page, className, withLabel = false }: { page: { id: string; favorite: boolean }; className: string; withLabel?: boolean }) {
  const { user } = useAuth();
  const toggle = useFavoriteToggle();
  if (!user || user.isGuest) return null;
  const label = page.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris';
  const onClick = (e: MouseEvent) => {
    // Sur une carte (lien), l'étoile ne doit pas ouvrir l'artefact.
    e.preventDefault();
    e.stopPropagation();
    toggle(page);
  };
  return (
    <button type="button" className={`${className}${page.favorite ? ' on' : ''}`} onClick={onClick} title={page.favorite ? 'En favori : son lien reste dans la sidebar · cliquer pour le retirer' : 'Ajouter aux favoris : son lien restera dans la sidebar'} aria-label={label} aria-pressed={page.favorite}>
      <i className={`bi ${page.favorite ? 'bi-star-fill' : 'bi-star'}`} />
      {withLabel && <span className="sp-btn-label">Favori</span>}
    </button>
  );
}
