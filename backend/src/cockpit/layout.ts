import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { catalogFor, widgetDef } from './catalog.js';
import { REGIONS, type ArtifactBlock, type Block, type BlockParams, type BuiltinBlock, type Layout, type LayoutOp, type Region, type ScopeKind, type WidgetDef, type WidgetParam } from './types.js';

/** Bornes d'un agencement. */
export const LAYOUT_LIMITS = {
  maxBlocks: 40,
  maxArtifactBlocks: 12,
  maxTitle: 80,
  maxMarkdown: 4000,
  maxTags: 12,
  minPollSeconds: 15,
  maxPollSeconds: 3600,
  minHeight: 80,
  maxHeight: 2400,
};

const fail = (msg: string): never => {
  throw new AppError(msg, 'VALIDATION');
};
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

export const newBlockId = () => `b${randomBytes(4).toString('hex')}`;

function parseRegion(v: unknown, where: string): Region {
  if (typeof v !== 'string' || !(REGIONS as readonly string[]).includes(v)) return fail(`${where} : région inconnue « ${String(v)} » (attendu : ${REGIONS.join(', ')})`);
  return v as Region;
}

function parseTitle(v: unknown, where: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return fail(`${where} : le titre doit être un texte`);
  const t = v.trim();
  return t ? t.slice(0, LAYOUT_LIMITS.maxTitle) : null;
}

/** Valide et normalise les paramètres d'un bloc natif d'après le catalogue (inconnus retirés, bornes appliquées). */
export function parseParams(def: WidgetDef, raw: unknown, where: string): BlockParams {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) return fail(`${where} : params doit être un objet`);
  const out: BlockParams = {};
  for (const p of def.params) {
    const v = raw[p.key];
    if (v === undefined || v === null || v === '') continue;
    out[p.key] = parseParam(p, v, `${where}, paramètre ${p.key}`);
  }
  return out;
}

function parseParam(p: WidgetParam, v: unknown, where: string): unknown {
  switch (p.type) {
    case 'int': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
      if (!Number.isInteger(n)) return fail(`${where} : un entier est attendu`);
      return Math.min(p.max ?? Number.MAX_SAFE_INTEGER, Math.max(p.min ?? Number.MIN_SAFE_INTEGER, n));
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      return fail(`${where} : vrai ou faux attendu`);
    case 'tags': {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
      if (!list) return fail(`${where} : une liste d'étiquettes est attendue`);
      const tags: string[] = [];
      for (const raw of list) {
        const t = String(raw).replace(/\s+/g, ' ').trim();
        if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
      }
      return tags.slice(0, LAYOUT_LIMITS.maxTags);
    }
    case 'select': {
      const s = String(v);
      if (!p.options?.some((o) => o.value === s)) return fail(`${where} : valeur « ${s} » inconnue (${(p.options ?? []).map((o) => o.value).join(', ')})`);
      return s;
    }
    case 'text':
      return String(v).slice(0, LAYOUT_LIMITS.maxTitle * 4);
    case 'markdown':
      return String(v).slice(0, LAYOUT_LIMITS.maxMarkdown);
  }
}

function parseBlock(raw: unknown, index: number, kind: ScopeKind): Block {
  const where = `bloc ${index + 1}`;
  if (!isObject(raw)) return fail(`${where} : un objet est attendu`);
  const id = raw.id === undefined || raw.id === null || raw.id === '' ? newBlockId() : String(raw.id);
  if (!ID_RE.test(id)) return fail(`${where} : identifiant invalide « ${id} »`);
  const region = parseRegion(raw.region ?? (raw.kind === 'builtin' && typeof raw.widget === 'string' ? widgetDef(raw.widget)?.region : undefined), where);
  const title = parseTitle(raw.title, where);
  if (raw.kind === 'builtin') {
    if (typeof raw.widget !== 'string') return fail(`${where} : widget manquant`);
    const def = widgetDef(raw.widget);
    if (!def) return fail(`${where} : bloc natif inconnu « ${raw.widget} » (voir le catalogue)`);
    if (!def.scopes.includes(kind)) return fail(`${where} : le bloc « ${def.label} » n'a pas de sens dans cette portée`);
    if (!def.regions.includes(region)) return fail(`${where} : le bloc « ${def.label} » n'accepte pas la région « ${region} » (${def.regions.join(', ')})`);
    const block: BuiltinBlock = { id, kind: 'builtin', widget: def.key, region };
    if (title) block.title = title;
    const params = parseParams(def, raw.params, where);
    if (Object.keys(params).length) block.params = params;
    return block;
  }
  if (raw.kind === 'artifact') {
    if (typeof raw.artifact !== 'string' || !UUID_RE.test(raw.artifact)) return fail(`${where} : identifiant d'artefact invalide`);
    const block: ArtifactBlock = { id, kind: 'artifact', artifact: raw.artifact.toLowerCase(), region };
    if (title) block.title = title;
    if (raw.version !== undefined && raw.version !== null) {
      const v = Number(raw.version);
      if (!Number.isInteger(v) || v < 1) return fail(`${where} : version invalide`);
      block.version = v;
    }
    if (isObject(raw.params) && Object.keys(raw.params).length) {
      if (JSON.stringify(raw.params).length > 4000) return fail(`${where} : params trop volumineux`);
      block.params = raw.params;
    }
    if (raw.height !== undefined && raw.height !== null && raw.height !== 'auto') {
      const h = Number(raw.height);
      if (!Number.isFinite(h)) return fail(`${where} : hauteur invalide`);
      block.height = Math.round(Math.min(LAYOUT_LIMITS.maxHeight, Math.max(LAYOUT_LIMITS.minHeight, h)));
    }
    if (raw.pollSeconds !== undefined && raw.pollSeconds !== null) {
      const s = Number(raw.pollSeconds);
      if (!Number.isFinite(s)) return fail(`${where} : pollSeconds invalide`);
      block.pollSeconds = Math.round(Math.min(LAYOUT_LIMITS.maxPollSeconds, Math.max(LAYOUT_LIMITS.minPollSeconds, s)));
    }
    return block;
  }
  return fail(`${where} : kind doit être « builtin » ou « artifact »`);
}

/**
 * Valide un agencement (document JSON reçu de l'interface, d'un agent ou lu en base) pour une portée : forme, blocs
 * connus du catalogue et admis dans la portée et la région, paramètres bornés, identifiants uniques, singletons, limites.
 * Renvoie l'agencement normalisé (ordre des blocs conservé : c'est l'ordre d'affichage dans chaque région).
 */
export function parseLayout(raw: unknown, kind: ScopeKind): Layout {
  if (!isObject(raw)) return fail("L'agencement doit être un objet { v: 1, blocks: [...] }");
  if (raw.v !== undefined && raw.v !== 1) return fail(`Version d'agencement inconnue : ${String(raw.v)}`);
  if (!Array.isArray(raw.blocks)) return fail('blocks doit être une liste de blocs');
  if (raw.blocks.length > LAYOUT_LIMITS.maxBlocks) return fail(`Au plus ${LAYOUT_LIMITS.maxBlocks} blocs par agencement`);
  const blocks = raw.blocks.map((b, i) => parseBlock(b, i, kind));
  const ids = new Set<string>();
  const singletons = new Set<string>();
  let artifacts = 0;
  for (const block of blocks) {
    if (ids.has(block.id)) return fail(`Identifiant de bloc en double : ${block.id}`);
    ids.add(block.id);
    if (block.kind === 'artifact') {
      artifacts += 1;
      if (artifacts > LAYOUT_LIMITS.maxArtifactBlocks) return fail(`Au plus ${LAYOUT_LIMITS.maxArtifactBlocks} blocs artefacts par agencement`);
    } else if (widgetDef(block.widget)?.singleton) {
      if (singletons.has(block.widget)) return fail(`Le bloc « ${widgetDef(block.widget)?.label} » ne peut figurer qu'une fois`);
      singletons.add(block.widget);
    }
  }
  return { v: 1, blocks };
}

/** Applique des opérations d'édition à un agencement (nouvel objet), puis le valide. */
export function applyOps(layout: Layout, ops: unknown, kind: ScopeKind): Layout {
  if (!Array.isArray(ops) || !ops.length) return fail('ops doit être une liste d’opérations non vide');
  let blocks: Record<string, unknown>[] = layout.blocks.map((b) => ({ ...b }));
  const find = (id: unknown) => {
    const i = blocks.findIndex((b) => b.id === id);
    if (i < 0) fail(`Aucun bloc « ${String(id)} » dans l'agencement`);
    return i;
  };
  const insertAt = (list: Record<string, unknown>[], block: Record<string, unknown>, index: number | null | undefined) => {
    // L'index est relatif à la région du bloc : position parmi les blocs de cette région.
    const region = block.region;
    const same = list.filter((b) => b.region === region);
    if (index === null || index === undefined || index >= same.length) {
      const last = same.length ? list.lastIndexOf(same[same.length - 1]) : -1;
      list.splice(last + 1, 0, block);
    } else {
      const at = list.indexOf(same[Math.max(0, index)]);
      list.splice(at, 0, block);
    }
  };
  for (const [n, raw] of (ops as unknown[]).entries()) {
    if (!isObject(raw)) return fail(`opération ${n + 1} : un objet est attendu`);
    const op = raw as Partial<LayoutOp> & Record<string, unknown>;
    switch (op.op) {
      case 'add': {
        const block = isObject(op.block) ? { ...op.block } : fail(`opération ${n + 1} : block manquant`);
        if (!block.id) block.id = newBlockId();
        if (!block.region && block.kind === 'builtin' && typeof block.widget === 'string') block.region = widgetDef(block.widget)?.region ?? 'main';
        if (!block.region && block.kind === 'artifact') block.region = 'full';
        insertAt(blocks, block, typeof op.index === 'number' ? op.index : null);
        break;
      }
      case 'remove':
        blocks.splice(find(op.id), 1);
        break;
      case 'move': {
        const [block] = blocks.splice(find(op.id), 1);
        if (op.region) block.region = op.region;
        insertAt(blocks, block, typeof op.index === 'number' ? op.index : null);
        break;
      }
      case 'set': {
        const block = blocks[find(op.id)];
        if (op.title !== undefined) block.title = op.title;
        if (op.params !== undefined) block.params = op.params === null ? undefined : { ...(isObject(block.params) ? block.params : {}), ...(isObject(op.params) ? op.params : fail(`opération ${n + 1} : params doit être un objet`)) };
        break;
      }
      default:
        return fail(`opération ${n + 1} : op inconnue « ${String(op.op)} » (add, remove, move, set)`);
    }
  }
  blocks = blocks.filter(Boolean);
  return parseLayout({ v: 1, blocks }, kind);
}

/** Ce qui change entre deux agencements (bandeau « mis à jour par … », compte rendu de l'outil). */
export function diffLayouts(before: Layout, after: Layout): { added: Block[]; removed: Block[]; changed: Block[] } {
  const b = new Map(before.blocks.map((x) => [x.id, x]));
  const a = new Map(after.blocks.map((x) => [x.id, x]));
  const added = after.blocks.filter((x) => !b.has(x.id));
  const removed = before.blocks.filter((x) => !a.has(x.id));
  const changed = after.blocks.filter((x) => b.has(x.id) && JSON.stringify(b.get(x.id)) !== JSON.stringify(x));
  return { added, removed, changed };
}

/** Libellé d'un bloc pour les textes (outil, historique). */
export function describeBlock(block: Block): string {
  const title = block.title ? ` « ${block.title} »` : '';
  if (block.kind === 'artifact') return `artefact ${block.artifact}${title} (${block.region})`;
  const def = widgetDef(block.widget);
  const params = block.params && Object.keys(block.params).length ? ` ${JSON.stringify(block.params)}` : '';
  return `${def?.label ?? block.widget}${title} [${block.widget}] (${block.region})${params}`;
}

/** Description du catalogue d'une portée pour un agent : une ligne par bloc, avec ses paramètres. */
export function describeCatalog(kind: ScopeKind): string {
  return catalogFor(kind)
    .map((w) => {
      const params = w.params.length
        ? ` · paramètres : ${w.params.map((p) => `${p.key} (${p.type}${p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : ''}${p.options ? ` : ${p.options.map((o) => o.value).join('|')}` : ''}${p.default !== undefined && p.default !== '' ? `, défaut ${JSON.stringify(p.default)}` : ''})`).join(', ')}`
        : '';
      return `- ${w.key} · ${w.label} · régions ${w.regions.join('/')}${w.singleton ? ' · unique' : ''} · ${w.description}${params}`;
    })
    .join('\n');
}
