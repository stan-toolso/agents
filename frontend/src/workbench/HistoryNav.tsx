import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { isStandalone } from '../lib/device';

/** Rang de l'entrée courante dans l'historique, posé par react-router dans history.state. */
const historyIndex = () => {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : 0;
};

/** L'application tourne-t-elle installée (fenêtre sans barre du navigateur) ? Suit les changements de mode. */
function useStandalone() {
  const [standalone, setStandalone] = useState(isStandalone);
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const update = () => setStandalone(isStandalone());
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return standalone;
}

/**
 * Flèches Précédent / Suivant de l'application installée : hors du navigateur, la fenêtre n'a ni barre
 * d'adresse ni boutons d'historique. Dans un onglet du navigateur, rien ne s'affiche.
 */
export default function HistoryNav() {
  const standalone = useStandalone();
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const maxIndex = useRef(historyIndex());
  const [index, setIndex] = useState(historyIndex);

  useEffect(() => {
    const idx = historyIndex();
    // Une nouvelle page efface les entrées « suivantes » ; un retour ou une avance les garde.
    if (navType === 'PUSH') maxIndex.current = idx;
    else maxIndex.current = Math.max(maxIndex.current, idx);
    setIndex(idx);
  }, [location.key, navType]);

  if (!standalone) return null;
  const canBack = index > 0;
  const canForward = index < maxIndex.current;
  return (
    <div className="wb-history-nav">
      <button type="button" className="wb-history-btn" onClick={() => navigate(-1)} disabled={!canBack} title="Page précédente" aria-label="Page précédente">
        <i className="bi bi-arrow-left" />
      </button>
      <button type="button" className="wb-history-btn wb-history-forward" onClick={() => navigate(1)} disabled={!canForward} title="Page suivante" aria-label="Page suivante">
        <i className="bi bi-arrow-right" />
      </button>
    </div>
  );
}
