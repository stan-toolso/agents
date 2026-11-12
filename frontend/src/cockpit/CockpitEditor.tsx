import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Badge, Button, Form, Modal, Nav, Spinner } from 'react-bootstrap';
import { useSessionLauncher } from '../components/SessionLauncher';
import TagsInput from '../components/TagsInput';
import { COCKPIT_LAYOUT_HISTORY, COCKPIT_PINNABLE_PAGES, OPEN_PAGE_TO_PROJECT, type CockpitLayoutVersion, type PinnablePage } from '../graphql/cockpit';
import { timeAgo } from '../lib/humanize';
import type { CockpitContext } from './registry';
import { REGION_LABELS, diffLayouts, newBlockId, type Block, type BlockParams, type Layout, type Region, type WidgetDef, type WidgetParam } from './types';
import { SUMMON_AGENT } from '../graphql/agents';
import { useNavigate } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';

/** Fenêtres du mode « Personnaliser » : catalogue (ajouter un bloc), réglages d'un bloc, historique des versions. */

type Pane = 'builtin' | 'artifacts' | 'agent';

/** Icônes des types d'artefacts (copie volontaire de ARTIFACT_KINDS de pages/SharedPagesPage, page chargée à la demande). */
const KIND_ICONS: Record<string, { icon: string; label: string }> = {
  PAGE: { icon: 'bi-file-earmark-richtext', label: 'Page' },
  DATA: { icon: 'bi-bar-chart-line', label: 'Données' },
  SLIDES: { icon: 'bi-easel', label: 'Diapositives' },
};

export function AddBlockModal({ region, catalog, layout, ctx, scope, onClose, onAdd }: { region: Region; catalog: WidgetDef[]; layout: Layout; ctx: CockpitContext; scope: string; onClose: () => void; onAdd: (block: Block) => void }) {
  const [pane, setPane] = useState<Pane>('builtin');
  const [wish, setWish] = useState('');
  const { openNewSession } = useSessionLauncher();
  const navigate = useNavigate();
  const { showError } = useDialogs();
  const [summon, { loading: summoning }] = useMutation<{ summonAgent: { id: string } }>(SUMMON_AGENT, { refetchQueries: ['Sidebar', 'Sessions'] });
  // Un Product Manager du projet est responsable du tableau de bord : la demande lui est confiée plutôt qu'à une session neuve.
  const pm = ctx.kind === 'project' ? ctx.project?.d.team.map((m) => m.agent).find((a) => a && a.kind === 'PRODUCT_MANAGER') ?? null : null;
  const present = new Set(layout.blocks.filter((b): b is Extract<Block, { kind: 'builtin' }> => b.kind === 'builtin').map((b) => b.widget));
  const items = catalog.filter((w) => w.regions.includes(region));
  const projectId = ctx.kind === 'project' ? ctx.project?.project.id ?? null : null;
  const askAgent = () => {
    const where = ctx.kind === 'project' ? `du tableau de bord du projet « ${ctx.project?.project.name ?? ''} »` : 'de mon accueil';
    const prompt = `Configure l'agencement ${where} (portée \`${scope}\`, outils du serveur MCP \`cockpit\`).\n\nDemande : ${wish.trim() || '…'}\n\nRegarde d'abord \`cockpit.get\` (agencement actuel et catalogue des blocs natifs). Préfère un bloc natif paramétré quand il répond au besoin ; place le bloc dans la région « ${REGION_LABELS[region].toLowerCase()} »${region === 'tiles' ? ' (un artefact en tuile est un indicateur : une grande valeur et une ligne de détail, le titre du bloc sert de libellé)' : ''}. Enregistre avec \`cockpit.update\` (une note de version qui dit ce qui change), puis dis-moi ce que tu as modifié.`;
    if (pm) {
      summon({ variables: { id: pm.id, text: prompt } })
        .then((res) => {
          onClose();
          const id = res.data?.summonAgent.id;
          if (id) navigate(`/sessions/${id}`);
        })
        .catch(showError);
      return;
    }
    openNewSession({ projectId, prompt });
    onClose();
  };
  return (
    <Modal show onHide={onClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="h6">Ajouter un bloc · {REGION_LABELS[region].toLowerCase()}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Nav variant="underline" activeKey={pane} onSelect={(k) => setPane((k as Pane) ?? 'builtin')} className="mb-3">
          <Nav.Item><Nav.Link eventKey="builtin">Blocs Skipper</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="artifacts">Artefacts</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="agent">Demander à un agent</Nav.Link></Nav.Item>
        </Nav>
        {pane === 'builtin' && (
          <div className="ck-catalog">
            {items.map((w) => {
              const taken = w.singleton && present.has(w.key);
              return (
                <button key={w.key} type="button" className="ck-catalog-item" disabled={taken} title={taken ? 'Déjà présent dans ce tableau de bord' : w.description} onClick={() => onAdd({ id: newBlockId(), kind: 'builtin', widget: w.key, region, params: defaultParams(w) })}>
                  <div className="t">
                    {w.label}
                    {taken && <Badge bg="secondary" pill>déjà là</Badge>}
                  </div>
                  <div className="d">{w.description}</div>
                  <div className="k">{w.key}{w.params.length ? ` · ${w.params.map((p) => p.key).join(', ')}` : ''}</div>
                </button>
              );
            })}
            {items.length === 0 && <div className="text-secondary small">Aucun bloc natif ne se place dans cette région.</div>}
          </div>
        )}
        {pane === 'artifacts' && <ArtifactsPane projectId={projectId} shared={ctx.kind === 'project'} layout={layout} onAdd={(page) => onAdd({ id: newBlockId(), kind: 'artifact', artifact: page.id, region, title: page.title })} />}
        {pane === 'agent' && (
          <div>
            <p className="small text-secondary">
              Décrivez le bloc que vous voulez voir ici. {pm ? <>{pm.name}, Product Manager du projet, lit l’agencement actuel et le catalogue, construit ou règle le bloc, puis l’enregistre</> : 'Une session d’agent lit l’agencement actuel et le catalogue, construit ou règle le bloc, puis l’enregistre'} : vous le verrez apparaître sur la page (bandeau « mis à jour par … »).
            </p>
            <Form.Control as="textarea" rows={3} value={wish} onChange={(e) => setWish(e.target.value)} placeholder="Ex. : un bloc qui compare le débit des deux derniers sprints, ou les tâches « infra » en retard" autoFocus />
            <div className="d-flex justify-content-end mt-3">
              <Button variant="primary" size="sm" disabled={!wish.trim() || summoning} onClick={askAgent}>
                <i className="bi bi-robot me-1" />{pm ? `Demander à ${pm.name}` : 'Lancer une session'}
              </Button>
            </div>
          </div>
        )}
      </Modal.Body>
    </Modal>
  );
}

function defaultParams(def: WidgetDef): BlockParams | undefined {
  const out: BlockParams = {};
  for (const p of def.params) if (p.default !== undefined && p.default !== null && p.default !== '') out[p.key] = p.default;
  return Object.keys(out).length ? out : undefined;
}

export function BlockSettingsModal({ block, def, onClose, onSave }: { block: Block; def: WidgetDef | null; onClose: () => void; onSave: (patch: Partial<Block>) => void }) {
  const [title, setTitle] = useState(block.title ?? '');
  const [params, setParams] = useState<BlockParams>({ ...(block.params ?? {}) });
  const set = (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned: BlockParams = {};
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) cleaned[k] = v;
    onSave({ title: title.trim() || null, params: Object.keys(cleaned).length ? cleaned : undefined });
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">{def?.label ?? (block.kind === 'artifact' ? 'Bloc artefact' : block.id)}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {def?.description && <p className="small text-secondary">{def.description}</p>}
          <Form.Group className="mb-3">
            <Form.Label className="small mb-1">Titre</Form.Label>
            <Form.Control size="sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={def?.label ?? 'Titre du bloc'} />
          </Form.Group>
          {(def?.params ?? []).map((p) => (
            <ParamField key={p.key} param={p} value={params[p.key]} onChange={(v) => set(p.key, v)} />
          ))}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" size="sm" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" size="sm">Appliquer</Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

function ParamField({ param: p, value, onChange }: { param: WidgetParam; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ck-param-${p.key}`;
  const label = (
    <Form.Label htmlFor={id} className="small mb-1">
      {p.label}
      {p.description && <span className="text-secondary ms-1">· {p.description}</span>}
    </Form.Label>
  );
  switch (p.type) {
    case 'int':
      return (
        <Form.Group className="mb-3">
          {label}
          <Form.Control id={id} size="sm" type="number" min={p.min ?? undefined} max={p.max ?? undefined} value={value === undefined || value === null ? '' : String(value)} placeholder={p.default !== undefined ? String(p.default) : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} style={{ maxWidth: 140 }} />
        </Form.Group>
      );
    case 'bool':
      return (
        <Form.Group className="mb-3">
          <Form.Check id={id} type="switch" label={p.label} checked={Boolean(value ?? p.default ?? false)} onChange={(e) => onChange(e.target.checked)} />
        </Form.Group>
      );
    case 'tags':
      return (
        <Form.Group className="mb-3">
          {label}
          <TagsInput id={id} value={Array.isArray(value) ? (value as string[]) : []} onChange={(tags) => onChange(tags)} />
        </Form.Group>
      );
    case 'select':
      return (
        <Form.Group className="mb-3">
          {label}
          <Form.Select id={id} size="sm" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">—</option>
            {(p.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Form.Select>
        </Form.Group>
      );
    case 'markdown':
      return (
        <Form.Group className="mb-3">
          {label}
          <Form.Control id={id} as="textarea" rows={6} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className="font-monospace" style={{ fontSize: 13 }} />
        </Form.Group>
      );
    default:
      return (
        <Form.Group className="mb-3">
          {label}
          <Form.Control id={id} size="sm" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        </Form.Group>
      );
  }
}

export function HistoryModal({ scope, canEdit, onRestore, onClose }: { scope: string; canEdit: boolean; onRestore: (version: number) => void; onClose: () => void }) {
  const { data, loading } = useQuery<{ cockpitLayoutHistory: CockpitLayoutVersion[] }>(COCKPIT_LAYOUT_HISTORY, { variables: { scope }, fetchPolicy: 'network-only' });
  const versions = data?.cockpitLayoutHistory ?? [];
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h6">Historique de l’agencement</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {loading && !data && <Spinner animation="border" size="sm" />}
        {!loading && versions.length === 0 && <div className="text-secondary small">Aucune version enregistrée : c’est l’agencement par défaut de Skipper.</div>}
        <ul className="list-unstyled ck-history mb-0">
          {versions.map((v, i) => {
            const prev = versions[i + 1];
            const d = prev ? diffLayouts(prev.layout, v.layout) : null;
            const name = (b: Block) => b.title || (b.kind === 'builtin' ? b.widget : 'artefact');
            const changes = d ? [...d.added.map((b) => `+ ${name(b)}`), ...d.removed.map((b) => `− ${name(b)}`), ...d.changed.map((b) => `~ ${name(b)}`)] : [];
            return (
            <li key={v.version}>
              <span className="v">v{v.version}</span>
              <div className="main">
                <div>{v.reset ? 'Réinitialisation' : v.note || `${v.layout.blocks.length} bloc${v.layout.blocks.length > 1 ? 's' : ''}`}</div>
                <div className="meta">
                  {v.author?.name ?? 'Skipper'}{v.sessionId ? ' (session d’agent)' : ''} · {timeAgo(v.createdAt)}
                </div>
                {changes.length > 0 && <div className="meta ck-history-diff" title={changes.join('\n')}>{changes.slice(0, 6).join(' · ')}{changes.length > 6 ? ` · +${changes.length - 6}` : ''}</div>}
              </div>
              {canEdit && i > 0 && (
                <Button size="sm" variant="outline-secondary" onClick={() => onRestore(v.version)}>Restaurer</Button>
              )}
              {i === 0 && <Badge bg="secondary">actuelle</Badge>}
            </li>
            );
          })}
        </ul>
      </Modal.Body>
    </Modal>
  );
}

/** Artefacts épinglables : ceux du projet (ou les miens et mes favoris sur l'accueil), avec leur visibilité pour l'équipe. */
function ArtifactsPane({ projectId, shared, layout, onAdd }: { projectId: string | null; shared: boolean; layout: Layout; onAdd: (page: PinnablePage) => void }) {
  const { data, loading } = useQuery<{ sharedPages: PinnablePage[] }>(COCKPIT_PINNABLE_PAGES, { variables: { projectId }, fetchPolicy: 'cache-and-network' });
  const [open, { loading: opening }] = useMutation(OPEN_PAGE_TO_PROJECT, { refetchQueries: ['CockpitPinnablePages'] });
  const pages = data?.sharedPages ?? [];
  const pinned = new Set(layout.blocks.filter((b): b is Extract<Block, { kind: 'artifact' }> => b.kind === 'artifact').map((b) => b.artifact));
  if (loading && !data) return <div className="text-secondary small"><Spinner animation="border" size="sm" /> Artefacts…</div>;
  if (!pages.length) return <div className="text-secondary small">Aucun artefact {projectId ? 'dans ce projet' : 'à vous'} pour l’instant : demandez-en un à un agent (onglet « Demander à un agent »), ou publiez une page.</div>;
  return (
    <div className="ck-catalog">
      {pages.map((p) => {
        const kind = KIND_ICONS[p.kind] ?? KIND_ICONS.PAGE;
        const hidden = shared && !p.linkAccess && !p.projectAccess;
        return (
          <div key={p.id} className="ck-catalog-item ck-artifact-item">
            <button type="button" className="ck-catalog-pick" onClick={() => onAdd(p)} title={pinned.has(p.id) ? 'Déjà épinglé (ajouter une seconde fois, avec d’autres paramètres)' : 'Épingler cet artefact'}>
              <div className="t">
                <i className={`bi ${kind.icon}`} />
                {p.title}
                {pinned.has(p.id) && <Badge bg="secondary" pill>épinglé</Badge>}
              </div>
              <div className="d">{kind.label} · {p.owner.name} · {timeAgo(p.updatedAt)}</div>
            </button>
            {hidden && (
              <div className="ck-artifact-warn">
                <i className="bi bi-eye-slash me-1" />
                Pas visible par l’équipe.
                {p.viewerAccess.admin && (
                  <button type="button" className="btn btn-link btn-sm p-0 ms-1" disabled={opening} onClick={() => void open({ variables: { id: p.id } })}>
                    Ouvrir aux membres du projet
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
