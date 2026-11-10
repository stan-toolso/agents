import { useCallback, useEffect, useState, type RefObject } from 'react';
import './slidesBar.css';

/** État du lecteur de diapositives injecté dans la page (slides-client.js), reçu par postMessage. */
export interface SlidesState {
  count: number;
  index: number;
  titles: string[];
  grid: boolean;
}

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Dialogue avec le lecteur de diapositives d'un artefact « slides » : écoute `ready` / `slide` / `grid` envoyés par la
 * page (cadre en bac à sable : postMessage seulement, source vérifiée) et envoie `goto` / `next` / `prev` / `grid` /
 * `present`. `frameKey` change quand le cadre est recréé : l'état repart de zéro.
 */
export function useSlides(frameRef: RefObject<HTMLIFrameElement | null>, frameKey: string) {
  const [state, setState] = useState<SlidesState | null>(null);
  // Pas de `ready` après quelques secondes : la page n'a pas le lecteur (ancienne version, HTML sans diapositive).
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    setState(null);
    setSilent(false);
    const timer = setTimeout(() => setSilent(true), 6000);
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as { skipperSlides?: number; type?: string; count?: number; index?: number; titles?: unknown[]; on?: boolean } | null;
      if (!d || d.skipperSlides !== 1) return;
      if (d.type === 'ready') {
        const count = Math.max(0, Math.min(500, Number(d.count) || 0));
        setState({ count, index: Math.max(0, Math.min(count - 1, Number(d.index) || 0)), titles: (Array.isArray(d.titles) ? d.titles : []).slice(0, 500).map((t) => str(t)), grid: false });
      } else if (d.type === 'slide') setState((s) => (s ? { ...s, index: Math.max(0, Math.min(s.count - 1, Number(d.index) || 0)) } : s));
      else if (d.type === 'grid') setState((s) => (s ? { ...s, grid: Boolean(d.on) } : s));
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
  }, [frameRef, frameKey]);
  const send = useCallback((msg: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage({ skipperSlides: 1, ...msg }, '*'), [frameRef]);
  return { state, send, silent };
}

export interface SlidesBarProps {
  state: SlidesState | null;
  /** Le lecteur ne s'est pas annoncé : la page est servie sans lui. */
  silent?: boolean;
  send: (msg: Record<string, unknown>) => void;
  /** Passe le cadre en plein écran (mode présentation). */
  onPresent: () => void;
}

/** Barre de navigation d'un artefact de diapositives : précédent / suivant, compteur avec titre, grille, présenter. */
export default function SlidesBar({ state, silent, send, onPresent }: SlidesBarProps) {
  if (!state) return <div className="sb-bar sb-bar-wait">{silent ? 'Le lecteur de diapositives ne répond pas : la page est affichée telle quelle.' : 'Chargement des diapositives…'}</div>;
  if (!state.count) return <div className="sb-bar sb-bar-wait">Aucune diapositive trouvée : le deck doit contenir des &lt;section class="slide"&gt;.</div>;
  const title = state.titles[state.index] ?? '';
  return (
    <div className="sb-bar" role="toolbar" aria-label="Diapositives">
      <div className="sb-group">
        <button type="button" className="sb-btn" onClick={() => send({ type: 'prev' })} disabled={state.index <= 0} title="Diapositive précédente (←)" aria-label="Précédente">
          <i className="bi bi-chevron-left" />
        </button>
        <span className="sb-counter" title={title}>
          <strong>{state.index + 1}</strong> / {state.count}
          {title && <span className="sb-title d-none d-md-inline"> · {title}</span>}
        </span>
        <button type="button" className="sb-btn" onClick={() => send({ type: 'next' })} disabled={state.index >= state.count - 1} title="Diapositive suivante (→)" aria-label="Suivante">
          <i className="bi bi-chevron-right" />
        </button>
      </div>
      <div className="sb-group ms-auto">
        <button type="button" className={`sb-btn${state.grid ? ' on' : ''}`} onClick={() => send({ type: 'grid', on: !state.grid })} title={state.grid ? 'Revenir à la diapositive (Échap)' : 'Toutes les diapositives (G)'} aria-pressed={state.grid}>
          <i className="bi bi-grid-3x3-gap" />
          <span className="sb-label">Grille</span>
        </button>
        <button type="button" className="sb-btn primary" onClick={onPresent} title="Présenter en plein écran (Échap pour sortir)">
          <i className="bi bi-play-fill" />
          <span className="sb-label">Présenter</span>
        </button>
      </div>
    </div>
  );
}
