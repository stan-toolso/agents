import { useApolloClient, useMutation } from '@apollo/client';
import { useCallback, useRef, useState } from 'react';
import { ANSWER_REQUEST, CANCEL_REQUEST } from '../graphql/operations';

/** Code renvoyé par le serveur quand la demande a déjà été réglée autrement (requests/service.ts). */
export const REQUEST_SETTLED = 'REQUEST_SETTLED';

interface ErrorWithCodes {
  message?: string;
  graphQLErrors?: ReadonlyArray<{ message?: string; extensions?: { code?: unknown } | null }>;
}

/**
 * L'erreur dit que la demande n'est plus en attente : un autre onglet, une autre page ou une autre personne y a
 * répondu (ou elle a été ignorée, ou a expiré). Rien à montrer : la demande est rafraîchie et le prompt disparaît.
 */
export function isSettledError(error: unknown): boolean {
  const e = error as ErrorWithCodes | null | undefined;
  if (!e) return false;
  if (e.graphQLErrors?.some((g) => g.extensions?.code === REQUEST_SETTLED)) return true;
  // Ancien message du serveur, le temps qu'une instance pas encore à jour réponde.
  return /plus en attente/.test(e.message ?? '');
}

/** Ce qu'il faut savoir d'une frappe clavier pour décider si le prompt de demande la prend. */
export interface PromptKeyContext {
  repeat: boolean;
  modifier: boolean;
  /** Élément ciblé : nom de balise, valeur s'il s'agit d'un champ, et s'il est dans ce prompt. */
  targetTag: string | null;
  targetValue: string;
  targetInPrompt: boolean;
  /** Le prompt est affiché (page du workbench au premier plan, pas masquée). */
  visible: boolean;
  /** C'est le premier prompt affiché : les suivants attendent leur tour pour le clavier. */
  first: boolean;
  /** Une réponse est partie ou le prompt est désactivé. */
  locked: boolean;
}

/**
 * Le raccourci clavier (chiffre, flèche, Entrée) est-il pour ce prompt ? Pas de touche maintenue (`repeat`), pas de
 * prompt masqué ni de second prompt, pas de champ texte du prompt (ses touches lui restent), et ailleurs que dans le
 * prompt seulement depuis la page elle-même ou la zone de saisie principale vide (sinon un « 1 » suivi d'Entrée
 * partirait comme instruction à l'agent).
 */
export function promptTakesKey(k: PromptKeyContext): boolean {
  if (k.locked || k.repeat || k.modifier || !k.visible || !k.first) return false;
  if (k.targetTag === 'INPUT' || k.targetTag === 'SELECT') return false;
  if (k.targetTag === 'TEXTAREA') return k.targetValue === '' && !k.targetInPrompt;
  if (k.targetInPrompt) return true;
  return k.targetTag === null || k.targetTag === 'BODY' || k.targetTag === 'HTML';
}

/**
 * Réponse à une demande, envoyée une seule fois : dès le premier envoi le formulaire est verrouillé (double clic,
 * Entrée répété) jusqu'à la disparition de la demande. Si la demande était déjà réglée ailleurs, l'erreur est tue et
 * les requêtes affichées sont rafraîchies ; une autre erreur s'affiche et déverrouille pour réessayer.
 */
export function useRequestAnswer(requestId: string) {
  const client = useApolloClient();
  const [answerRequest] = useMutation(ANSWER_REQUEST);
  const [cancelRequest] = useMutation(CANCEL_REQUEST);
  const sent = useRef(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (send: () => Promise<unknown>) => {
      if (sent.current) return;
      sent.current = true;
      setLocked(true);
      setError(null);
      try {
        await send();
      } catch (err) {
        if (isSettledError(err)) {
          void client.refetchQueries({ include: 'active' });
          return;
        }
        sent.current = false;
        setLocked(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client],
  );

  const answer = useCallback((response: Record<string, unknown>) => void run(() => answerRequest({ variables: { id: requestId, response } })), [run, answerRequest, requestId]);
  const cancel = useCallback(() => void run(() => cancelRequest({ variables: { id: requestId } })), [run, cancelRequest, requestId]);
  return { answer, cancel, busy: locked, error };
}
