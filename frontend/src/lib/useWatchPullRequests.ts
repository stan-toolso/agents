import { useApolloClient, useMutation } from '@apollo/client';
import { useEffect, useRef } from 'react';
import { WATCH_PULL_REQUESTS } from '../graphql/pullRequests';
import { usePageVisible } from './usePageVisible';

/** Période à laquelle l'onglet actif demande la synchronisation des PR de son projet (le serveur en fait autant au plus). */
export const WATCH_PULL_REQUESTS_MS = 10_000;

/** Requêtes à relire quand l'ensemble des PR suivies change (PR apparue, passée d'une étape à l'autre). */
const REFETCH_ON_CHANGE = ['SidebarPullRequests', 'PullRequests'];

/** Signature des PR renvoyées : identifiant et étape, pour savoir si une PR est apparue, a disparu ou a changé d'étape. */
export function watchSignature(prs: { id: string; stage: string }[]): string {
  return prs
    .map((p) => `${p.id}:${p.stage}`)
    .sort()
    .join(',');
}

/**
 * Tant que la page est visible, demande toutes les 10 s au serveur de synchroniser les pull requests du projet
 * affiché (onglet actif du workbench) : une fusion, un brouillon publié ou des checks terminés sur GitHub se voient
 * en une dizaine de secondes au lieu d'une à deux minutes (synchronisation de fond à 60 s, sidebar relue à 60 s).
 * Les PR renvoyées mettent le cache à jour par identifiant ; si l'ensemble change (PR adoptée, mise en préparation,
 * changement d'étape), la sidebar et les listes de PR sont relues.
 */
export function useWatchPullRequests(projectId: string | null | undefined): void {
  const visible = usePageVisible();
  const client = useApolloClient();
  const [watch] = useMutation<{ watchPullRequests: { id: string; stage: string }[] }>(WATCH_PULL_REQUESTS);
  const signature = useRef<{ projectId: string; value: string } | null>(null);
  useEffect(() => {
    if (!projectId || !visible) return;
    let cancelled = false;
    const tick = () => {
      watch({ variables: { projectId } })
        .then(({ data }) => {
          if (cancelled || !data) return;
          const value = watchSignature(data.watchPullRequests);
          const previous = signature.current;
          signature.current = { projectId, value };
          if (previous?.projectId === projectId && previous.value !== value) void client.refetchQueries({ include: REFETCH_ON_CHANGE });
        })
        .catch(() => {
          /* projet sans dépôt, droits, réseau : la synchronisation de fond reste là */
        });
    };
    tick();
    const timer = setInterval(tick, WATCH_PULL_REQUESTS_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, visible, watch, client]);
}
