/**
 * Cockpit configurable : types partagés par l'interface. Miroir de backend/src/cockpit/types.ts (le serveur valide,
 * l'interface rend) ; voir docs/conception/cockpit-configurable.md.
 */

export const REGIONS = ['tiles', 'main', 'side', 'full'] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region, string> = {
  tiles: 'Tuiles',
  main: 'Colonne principale',
  side: 'Colonne latérale',
  full: 'Pleine largeur',
};

export type ScopeKind = 'home' | 'project' | 'tasks' | 'agent' | 'page';

export type BlockParams = Record<string, unknown>;

export interface BuiltinBlock {
  id: string;
  kind: 'builtin';
  widget: string;
  region: Region;
  title?: string | null;
  params?: BlockParams;
}

export interface ArtifactBlock {
  id: string;
  kind: 'artifact';
  artifact: string;
  version?: number | null;
  region: Region;
  title?: string | null;
  params?: BlockParams;
  height?: number | null;
  pollSeconds?: number | null;
}

export type Block = BuiltinBlock | ArtifactBlock;

export interface Layout {
  v: 1;
  blocks: Block[];
}

export interface WidgetParam {
  key: string;
  label: string;
  type: 'int' | 'bool' | 'tags' | 'select' | 'text' | 'markdown';
  description?: string | null;
  min?: number | null;
  max?: number | null;
  options?: { value: string; label: string }[] | null;
  default?: unknown;
}

export interface WidgetDef {
  key: string;
  label: string;
  description: string;
  region: Region;
  regions: Region[];
  singleton: boolean;
  params: WidgetParam[];
}

/** Identifiant d'un nouveau bloc côté client (le serveur en accepte la forme). */
export const newBlockId = () => `b${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;

/** Les blocs d'une région, dans l'ordre. */
export const blocksOf = (layout: Layout, region: Region) => layout.blocks.filter((b) => b.region === region);

/** Déplace un bloc d'un cran dans sa région (nouvel objet). */
export function moveBlock(layout: Layout, id: string, dir: -1 | 1): Layout {
  const block = layout.blocks.find((b) => b.id === id);
  if (!block) return layout;
  const same = blocksOf(layout, block.region);
  const i = same.indexOf(block);
  const j = i + dir;
  if (j < 0 || j >= same.length) return layout;
  const a = layout.blocks.indexOf(same[i]);
  const b = layout.blocks.indexOf(same[j]);
  const blocks = [...layout.blocks];
  [blocks[a], blocks[b]] = [blocks[b], blocks[a]];
  return { ...layout, blocks };
}

/** Change la région d'un bloc : il passe en fin de la nouvelle région. */
export function setBlockRegion(layout: Layout, id: string, region: Region): Layout {
  const block = layout.blocks.find((b) => b.id === id);
  if (!block || block.region === region) return layout;
  const rest = layout.blocks.filter((b) => b.id !== id);
  const same = rest.filter((b) => b.region === region);
  const at = same.length ? rest.indexOf(same[same.length - 1]) + 1 : rest.length;
  rest.splice(at, 0, { ...block, region });
  return { ...layout, blocks: rest };
}

export function addBlock(layout: Layout, block: Block): Layout {
  return setBlockRegion({ ...layout, blocks: [...layout.blocks, { ...block, region: '__new__' as Region }] }, block.id, block.region);
}

export function removeBlock(layout: Layout, id: string): Layout {
  return { ...layout, blocks: layout.blocks.filter((b) => b.id !== id) };
}

export function patchBlock(layout: Layout, id: string, patch: Partial<Block>): Layout {
  return { ...layout, blocks: layout.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)) };
}

export const sameLayout = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b);
