import { useMutation } from '@apollo/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { sharedPageUrl } from '../../apollo';
import { useDialogs } from '../../components/Dialogs';
import PopMenu, { type MenuItem } from '../../components/PopMenu';
import { useSessionLauncher } from '../../components/SessionLauncher';
import type { CockpitArtifactInfo } from '../../graphql/cockpit';
import { REFRESH_SHARED_PAGE_DATA, UPDATE_SHARED_PAGE } from '../../graphql/misc';
import { timeAgo } from '../../lib/humanize';
import { refreshLabel } from '../../lib/refreshChoices';
import { useTheme } from '../../lib/theme';
import type { CockpitContext } from '../registry';
import type { ArtifactBlock } from '../types';

/**
 * Bloc artefact : une page de l'agent dans un cadre en bac à sable (mode `embed=1` de la route de lecture : variables
 * du thème, `Skipper.context`, script d'intégration). La hauteur suit le contenu (message `size` du script), sauf
 * hauteur fixe du bloc. Dans la région « tuiles », le bloc prend l'habit d'une tuile native (libellé = titre du bloc) et
 * la page, prévenue par `Skipper.context.region` et `html[data-region="tiles"]`, ne montre qu'un indicateur. Le cadre est rechargé quand la version ou les données de l'artefact changent, ou toutes les
 * `pollSeconds`. Les actions de la page vers l'hôte (naviguer, ouvrir une session, convoquer un agent) passent par
 * l'interface normale : rien ne s'exécute sans la personne.
 */
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 2400;
const DEFAULT_HEIGHT = 220;
/** Hauteur d'un artefact en tuile : un indicateur, pas une page (au-delà, la tuile défile). */
const TILE_DEFAULT_HEIGHT = 64;
const TILE_MAX_HEIGHT = 160;

/** Intervalles proposés depuis une tuile : un tableau de bord n'a pas besoin de plus fin qu'une heure. */
const TILE_REFRESH_CHOICES: [number, string][] = [
  [0, 'À la demande'],
  [60, 'Toutes les heures'],
  [360, 'Toutes les 6 heures'],
  [1440, 'Tous les jours'],
  [10080, 'Toutes les semaines'],
];

/**
 * Contrôles d'un artefact de données dans un bloc : état (dernière mise à jour, intervalle, calcul en cours, sources en
 * défaut) au survol ; pour qui l'administre, « Rafraîchir » (lance aussi les sessions des sources agent) et le menu de
 * l'intervalle. Le reste (sources, sessions, erreurs) est dans le panneau Données de l'artefact.
 */
function DataControls({ info }: { info: CockpitArtifactInfo }) {
  const { showError } = useDialogs();
  const [menuAt, setMenuAt] = useState<{ which: 'info' | 'menu'; top: number; right: number } | null>(null);
  const refetchQueries = ['CockpitLayout'];
  const [refresh, { loading: refreshingNow }] = useMutation(REFRESH_SHARED_PAGE_DATA, { refetchQueries, onError: (e) => void showError(e) });
  const [update] = useMutation(UPDATE_SHARED_PAGE, { refetchQueries, onError: (e) => void showError(e) });
  const busy = refreshingNow || info.refreshing;
  const state = [
    info.dataRefreshedAt ? `Mis à jour ${timeAgo(info.dataRefreshedAt)}` : 'Pas encore rafraîchi',
    `rafraîchissement ${refreshLabel(info.refreshMinutes)}`,
    info.refreshing ? 'une session calcule les données' : null,
    info.failingSources ? `${info.failingSources} source${info.failingSources > 1 ? 's' : ''} en défaut` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const items: MenuItem[] = [
    { label: busy ? 'Rafraîchissement en cours…' : 'Rafraîchir maintenant', icon: 'bi-arrow-repeat', onClick: () => void (busy ? undefined : refresh({ variables: { id: info.id } })) },
    ...TILE_REFRESH_CHOICES.map(([m, label], i) => ({
      label,
      icon: (info.refreshMinutes ?? 0) === m ? 'bi-check2' : 'bi-clock',
      separatorBefore: i === 0,
      onClick: () => void update({ variables: { id: info.id, input: { refreshMinutes: m } } }),
    })),
    { label: 'Données, sources et sessions', icon: 'bi-bar-chart-line', to: `/shared/${info.id}?panel=data`, separatorBefore: true },
  ];
  const updatedAt = info.dataRefreshedAt ? new Date(info.dataRefreshedAt) : null;
  const infoItems: MenuItem[] = [
    {
      label: updatedAt ? `Mis à jour le ${updatedAt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${updatedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (${timeAgo(info.dataRefreshedAt!)})` : 'Pas encore rafraîchi',
      icon: 'bi-clock-history',
    },
    { label: `Rafraîchissement ${refreshLabel(info.refreshMinutes)}`, icon: 'bi-arrow-repeat' },
    ...(info.refreshing ? [{ label: 'Une session calcule les données', icon: 'bi-robot' }] : []),
    ...(info.failingSources ? [{ label: `${info.failingSources} source${info.failingSources > 1 ? 's' : ''} en défaut`, icon: 'bi-exclamation-triangle' }] : []),
    { label: 'Données, sources et sessions', icon: 'bi-bar-chart-line', to: `/shared/${info.id}?panel=data`, separatorBefore: true },
  ];
  const toggle = (e: React.MouseEvent<HTMLButtonElement>, which: 'info' | 'menu') => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenuAt(menuAt?.which === which ? null : { which, top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  return (
    <span className="ck-data-controls">
      {info.failingSources > 0 && (
        <span className="ck-data-warn" title={state}>
          <i className="bi bi-exclamation-triangle" />
        </span>
      )}
      {/* Info : pour tout lecteur, la date des données (bulle au survol, panneau au clic ou au toucher). */}
      <button type="button" className="ck-data-btn" title={state} aria-label="Dernière mise à jour des données" onClick={(e) => toggle(e, 'info')}>
        <i className={`bi ${busy ? 'bi-arrow-repeat spin' : 'bi-info-circle'}`} />
      </button>
      {info.canManage && (
        <span className={`ck-data-actions${busy || info.failingSources > 0 ? '' : ' quiet'}${menuAt?.which === 'menu' ? ' open' : ''}`}>
          <button type="button" className="ck-data-btn" title={`${state}\nRafraîchir maintenant`} aria-label="Rafraîchir les données" disabled={busy} onClick={() => void refresh({ variables: { id: info.id } })}>
            <i className={`bi bi-arrow-repeat${busy ? ' spin' : ''}`} />
          </button>
          <button type="button" className="ck-data-btn" title={`Rafraîchissement ${refreshLabel(info.refreshMinutes)} : changer l'intervalle`} aria-label="Intervalle de rafraîchissement" onClick={(e) => toggle(e, 'menu')}>
            <i className="bi bi-clock" />
          </button>
        </span>
      )}
      {/* Portail : hors du libellé de la tuile (police mono, majuscules) et de son cadre. */}
      {menuAt && createPortal(<PopMenu items={menuAt.which === 'info' ? infoItems : items} at={menuAt} onClose={() => setMenuAt(null)} />, document.body)}
    </span>
  );
}

export function ArtifactWidget({ block, info, ctx, scope }: { block: ArtifactBlock; info: CockpitArtifactInfo | null | undefined; ctx: CockpitContext; scope: string }) {
  const theme = useTheme();
  const navigate = useNavigate();
  const { openNewSession } = useSessionLauncher();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(block.height ?? (block.region === 'tiles' ? TILE_DEFAULT_HEIGHT : DEFAULT_HEIGHT));
  const [tick, setTick] = useState(0);
  const params = useMemo(() => JSON.stringify(block.params ?? {}), [block.params]);
  const projectId = ctx.kind === 'project' ? ctx.project?.project.id ?? null : null;

  useEffect(() => {
    if (!block.pollSeconds) return;
    const id = setInterval(() => setTick((t) => t + 1), Math.max(15, block.pollSeconds) * 1000);
    return () => clearInterval(id);
  }, [block.pollSeconds]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const m = ev.data as { skipperWidget?: number; type?: string; height?: number; action?: string; to?: string; prompt?: string; projectId?: string | null; agent?: string; text?: string } | null;
      if (!m || m.skipperWidget !== 1) return;
      if (m.type === 'size' && !block.height && typeof m.height === 'number') setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(m.height))));
      if (m.type === 'action') {
        if (m.action === 'navigate') {
          const to = String(m.to ?? '');
          // Routes internes seulement : pas d'URL absolue ni de protocole.
          if (/^\/(?!\/)[^\s]*$/.test(to)) navigate(to);
        } else if (m.action === 'openSession') {
          openNewSession({ projectId: m.projectId ?? projectId, prompt: String(m.prompt ?? '').slice(0, 4000) });
        } else if (m.action === 'summon') {
          const agent = String(m.agent ?? '').trim();
          openNewSession({ projectId, prompt: `${agent ? `@${agent} ` : ''}${String(m.text ?? '').slice(0, 4000)}` });
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [block.height, navigate, openNewSession, projectId]);

  const title = block.title || info?.title || 'Artefact';
  if (!info || !info.viewable) {
    if (block.region === 'tiles') {
      return (
        <div className="dash-tile ck-artifact-tile">
          <div className="dash-tile-label">{title}</div>
          <div className="dash-tile-sub">
            <i className="bi bi-lock me-1" />
            {info ? 'Artefact non partagé avec vous.' : 'Artefact introuvable.'}
          </div>
        </div>
      );
    }
    return (
      <section className="dash-section">
        <h2 className="dash-section-title">
          <span>{title}</span>
        </h2>
        <div className="ck-unavailable">
          <i className="bi bi-lock me-1" />
          {info ? 'Artefact non partagé avec vous : demandez à son propriétaire de l’ouvrir aux membres du projet.' : 'Artefact introuvable.'}
        </div>
      </section>
    );
  }
  const tile = block.region === 'tiles';
  const base = sharedPageUrl(block.artifact, block.version ?? null);
  const q = new URLSearchParams({ embed: '1', theme, scope, region: block.region, params });
  const src = `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
  const key = `${block.artifact}:${block.version ?? info.version}:${info.dataRefreshedAt ?? ''}:${theme}:${params}:${tick}`;
  const frame = <iframe key={key} ref={frameRef} src={src} title={title} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals" loading="lazy" />;
  // En tuile : le cadre d'une tuile native (libellé = titre du bloc), la page n'apporte que la valeur et son détail.
  if (tile) {
    return (
      <div className="dash-tile ck-artifact-tile">
        <div className="dash-tile-label">
          <span>{title}</span>
          {info.kind === 'DATA' && <DataControls info={info} />}
          <Link to={`/shared/${block.artifact}`} className="ck-artifact-tile-open" title="Ouvrir l’artefact en page entière (commentaires, versions, données)">
            <i className="bi bi-box-arrow-up-right" />
          </Link>
        </div>
        <div className="ck-artifact-tile-frame" style={{ height: block.height ?? Math.min(TILE_MAX_HEIGHT, height) }}>{frame}</div>
      </div>
    );
  }
  return (
    <section className="dash-section ck-artifact">
      <h2 className="dash-section-title">
        <span>{title}</span>
        {info.kind === 'DATA' && <DataControls info={info} />}
        <Link to={`/shared/${block.artifact}`} title="Ouvrir l’artefact en page entière (commentaires, versions, données)">Ouvrir</Link>
      </h2>
      <div className="ck-artifact-frame" style={{ height: block.height ?? height }}>
        {frame}
      </div>
    </section>
  );
}
