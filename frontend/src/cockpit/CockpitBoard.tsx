import { useState } from 'react';
import { Alert, Button, Col, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { timeAgo } from '../lib/humanize';
import { AddBlockModal, BlockSettingsModal, HistoryModal } from './CockpitEditor';
import { WIDGETS, type CockpitContext } from './registry';
import { ArtifactWidget } from './widgets/artifact';
import { REGIONS, REGION_LABELS, addBlock, blocksOf, moveBlock, patchBlock, removeBlock, setBlockRegion, type Block, type Layout, type Region, type WidgetDef } from './types';
import type { CockpitState } from './useCockpit';
import './cockpit.css';

/**
 * Rend un agencement : la rangée de tuiles, les deux colonnes, puis les blocs en pleine largeur. En mode
 * « Personnaliser », chaque bloc porte une barre (titre, région, monter / descendre, réglages, retirer), chaque région
 * une zone « Ajouter un bloc », et une barre d'édition flotte en haut (réinitialiser, historique, annuler, enregistrer).
 */
export default function CockpitBoard({ cockpit, ctx, scopeLabel }: { cockpit: CockpitState; ctx: CockpitContext; scopeLabel: string }) {
  const { layout, editing, catalog } = cockpit;
  const [adding, setAdding] = useState<Region | null>(null);
  const [settings, setSettings] = useState<Block | null>(null);
  const [history, setHistory] = useState(false);
  if (!layout) return null;
  const warnings = cockpit.warnings;
  const change = (next: Layout) => cockpit.setDraft(next);
  const defs = new Map(catalog.map((w) => [w.key, w]));

  const renderBlock = (block: Block) => {
    const entry = block.kind === 'builtin' ? WIDGETS[block.widget] : null;
    const available = block.kind === 'builtin' ? (entry ? !entry.available || entry.available(ctx) : false) : true;
    if (!editing && !available) return null;
    let body: React.ReactNode;
    if (block.kind === 'artifact') body = <ArtifactWidget block={block} info={cockpit.data?.artifacts.find((a) => a.id === block.artifact)} ctx={ctx} scope={cockpit.data?.scope ?? ''} />;
    else if (!entry) body = <div className="ck-unknown">Bloc « {block.widget} » inconnu de cette version de l’interface (rechargez la page).</div>;
    else if (!available) body = <div className="ck-unavailable">{defs.get(block.widget)?.label ?? block.widget} : rien à montrer ici pour vous (masqué hors édition).</div>;
    else {
      const Widget = entry.component;
      body = <Widget block={block} params={block.params ?? {}} ctx={ctx} />;
    }
    if (!editing) return <div key={block.id} className="ck-block-view">{body}</div>;
    const def = block.kind === 'builtin' ? defs.get(block.widget) : null;
    const regions = def ? def.regions : REGIONS.filter((r) => r !== 'tiles');
    const same = blocksOf(layout, block.region);
    const i = same.indexOf(block);
    const name = block.title || def?.label || (block.kind === 'artifact' ? 'Artefact' : block.widget);
    return (
      <div key={block.id} className={`ck-block${available ? '' : ' unavailable'}`}>
        <div className="ck-toolbar">
          <span className="ck-name" title={block.kind === 'builtin' ? block.widget : block.artifact}><b>{name}</b></span>
          {regions.length > 1 && (
            <select value={block.region} title="Région" onChange={(e) => change(setBlockRegion(layout, block.id, e.target.value as Region))}>
              {regions.map((r) => (
                <option key={r} value={r}>{REGION_LABELS[r]}</option>
              ))}
            </select>
          )}
          <button type="button" title="Monter" disabled={i <= 0} onClick={() => change(moveBlock(layout, block.id, -1))}><i className="bi bi-arrow-up" /></button>
          <button type="button" title="Descendre" disabled={i >= same.length - 1} onClick={() => change(moveBlock(layout, block.id, 1))}><i className="bi bi-arrow-down" /></button>
          <button type="button" title="Titre et paramètres" onClick={() => setSettings(block)}><i className="bi bi-gear" /></button>
          <button type="button" className="danger" title="Retirer" onClick={() => change(removeBlock(layout, block.id))}><i className="bi bi-x-lg" /></button>
        </div>
        {body}
      </div>
    );
  };

  const region = (r: Region) => {
    const blocks = blocksOf(layout, r).map(renderBlock).filter(Boolean);
    if (!editing) return blocks;
    return (
      <>
        {blocks}
        <button type="button" className="ck-add" onClick={() => setAdding(r)} title={`Ajouter un bloc dans ${REGION_LABELS[r].toLowerCase()}`}>
          <i className="bi bi-plus-lg" /> Ajouter
        </button>
      </>
    );
  };

  const tiles = blocksOf(layout, 'tiles');
  const main = blocksOf(layout, 'main');
  const side = blocksOf(layout, 'side');
  const full = blocksOf(layout, 'full');
  const showMain = editing || main.length > 0;
  const showSide = editing || side.length > 0;
  const mainWidth = showSide ? 7 : 12;
  const sideWidth = showMain ? 5 : 12;

  return (
    <div className={editing ? 'ck-editing' : undefined}>
      {editing && (
        <div className="ck-bar">
          <span className="ck-bar-title"><i className="bi bi-sliders me-1" />Personnaliser {scopeLabel}</span>
          <span className="ck-bar-hint d-none d-md-inline">Ordonnez, déplacez, réglez ou retirez les blocs ; ajoutez-en depuis chaque région.</span>
          <div className="ms-auto d-flex gap-2 flex-wrap">
            <Button size="sm" variant="outline-secondary" onClick={() => setHistory(true)} title="Versions précédentes de cet agencement">
              <i className="bi bi-clock-history me-1" />Historique
            </Button>
            <Button size="sm" variant="outline-secondary" onClick={() => void cockpit.reset()} disabled={cockpit.data?.isDefault && !cockpit.dirty} title="Revenir à l’agencement par défaut de Skipper">
              Réinitialiser
            </Button>
            <Button size="sm" variant="outline-secondary" onClick={cockpit.cancel}>Annuler</Button>
            <Button size="sm" variant="primary" disabled={!cockpit.dirty || cockpit.saving} onClick={() => void cockpit.save()}>
              <i className="bi bi-check-lg me-1" />Enregistrer
            </Button>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <Alert variant="warning" className="py-2 small" dismissible onClose={cockpit.clearWarnings}>
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </Alert>
      )}
      {!editing && cockpit.changedElsewhere && (
        <div className="ck-updated">
          <i className="bi bi-info-circle" />
          <span>
            Tableau de bord mis à jour {cockpit.changedElsewhere.updatedAt ? timeAgo(cockpit.changedElsewhere.updatedAt) : ''} par {cockpit.changedElsewhere.updatedBy?.name ?? 'quelqu’un'}
            {cockpit.changedElsewhere.updatedBy?.id && <> (<Link to={`/projects/${cockpit.changedElsewhere.projectId ?? ''}/audit`}>journal</Link>)</>}.
          </span>
          {cockpit.canEdit && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setHistory(true)}>Historique</button>}
          <button type="button" className="btn btn-link btn-sm p-0 text-secondary" onClick={cockpit.acknowledge}>Fermer</button>
        </div>
      )}

      {(tiles.length > 0 || editing) && (
        <div className="ck-region-tiles mb-4">
          {editing && <div className="ck-region-label">{REGION_LABELS.tiles}</div>}
          <div className="dash-tiles ck-tiles">{region('tiles')}</div>
        </div>
      )}
      {(showMain || showSide) && (
        <Row className="g-4">
          {showMain && (
            <Col lg={mainWidth}>
              {editing && <div className="ck-region-label">{REGION_LABELS.main}</div>}
              {region('main')}
            </Col>
          )}
          {showSide && (
            <Col lg={sideWidth}>
              {editing && <div className="ck-region-label">{REGION_LABELS.side}</div>}
              {region('side')}
            </Col>
          )}
        </Row>
      )}
      {(full.length > 0 || editing) && (
        <div className="ck-region-full">
          {editing && <div className="ck-region-label mt-3">{REGION_LABELS.full}</div>}
          {region('full')}
        </div>
      )}

      {adding && (
        <AddBlockModal
          region={adding}
          catalog={catalog}
          layout={layout}
          ctx={ctx}
          scope={cockpit.data?.scope ?? ''}
          onClose={() => setAdding(null)}
          onAdd={(block) => {
            change(addBlock(layout, block));
            setAdding(null);
          }}
        />
      )}
      {settings && (
        <BlockSettingsModal
          block={settings}
          def={settings.kind === 'builtin' ? (defs.get(settings.widget) ?? null) : null}
          onClose={() => setSettings(null)}
          onSave={(patch) => {
            change(patchBlock(layout, settings.id, patch));
            setSettings(null);
          }}
        />
      )}
      {history && cockpit.data && <HistoryModal scope={cockpit.data.scope} canEdit={cockpit.canEdit} onRestore={(v) => void cockpit.restore(v).then(() => setHistory(false))} onClose={() => setHistory(false)} />}
    </div>
  );
}

/** Bouton « Personnaliser » des en-têtes de page. */
export function CustomizeButton({ cockpit, size = 'sm' }: { cockpit: CockpitState; size?: 'sm' }) {
  if (!cockpit.canEdit || !cockpit.data) return null;
  if (cockpit.editing) return null;
  return (
    <Button size={size} variant="outline-secondary" onClick={cockpit.startEdit} title="Choisir, ordonner et régler les blocs de ce tableau de bord">
      <i className="bi bi-sliders me-1" /> Personnaliser
    </Button>
  );
}

export type { WidgetDef };
