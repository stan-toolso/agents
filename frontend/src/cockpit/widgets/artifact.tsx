import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { sharedPageUrl } from '../../apollo';
import { useSessionLauncher } from '../../components/SessionLauncher';
import type { CockpitArtifactInfo } from '../../graphql/cockpit';
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
        <Link to={`/shared/${block.artifact}`} title="Ouvrir l’artefact en page entière (commentaires, versions, données)">Ouvrir</Link>
      </h2>
      <div className="ck-artifact-frame" style={{ height: block.height ?? height }}>
        {frame}
      </div>
    </section>
  );
}
