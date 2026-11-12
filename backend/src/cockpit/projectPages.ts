import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import { AppError } from '../errors.js';

/**
 * Pages personnalisées d'un projet (un onglet de plus dans l'en-tête, dont le contenu est l'agencement de la portée
 * `project:<id>:page:<slug>`) et réglage des onglets natifs (`projects.tabs` : masqués, ordre). Voir dev/cockpit.
 */
export interface ProjectPage {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  icon: string | null;
  position: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectTabs {
  /** Clés des onglets natifs masqués (jamais `overview` ni `settings`). */
  hidden: string[];
  /** Ordre des onglets (clés natives et `page:<slug>`) ; les absents suivent dans l'ordre habituel. */
  order: string[];
}

/** Clés des onglets natifs (copie de `TABS` de frontend/src/components/ProjectHeader.tsx : à tenir identiques). */
export const PROJECT_TAB_KEYS = ['overview', 'conversations', 'repo', 'files', 'tasks', 'artifacts', 'agents', 'pullRequests', 'deliveries', 'context', 'vault', 'env', 'schedules', 'workflows', 'history', 'usage', 'audit', 'settings'] as const;
const NEVER_HIDDEN = new Set(['overview', 'settings']);
const LIMITS = { pages: 12, title: 60, slug: 40 };
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ICON_RE = /^bi-[a-z0-9-]{1,40}$/;

const fail = (msg: string): never => {
  throw new AppError(msg, 'VALIDATION');
};

/** Slug d'un titre : minuscules sans accent, tirets, 40 caractères. */
export function slugOf(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug)
    .replace(/-+$/, '');
  return s || 'page';
}

export function parseTitle(v: unknown): string {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return fail('Le titre de la page est obligatoire');
  return t.slice(0, LIMITS.title);
}

export function parseIcon(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!ICON_RE.test(s)) return fail(`Icône invalide « ${s} » : une icône Bootstrap (ex. bi-graph-up)`);
  return s;
}

export function parseSlug(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) return fail(`Identifiant de page invalide « ${s} » : lettres minuscules, chiffres et tirets`);
  return s;
}

/** Valide le réglage des onglets : clés connues (ou `page:<slug>` dans l'ordre), jamais masquer l'aperçu ni les réglages. */
export function parseTabs(raw: unknown, pageSlugs: string[]): ProjectTabs {
  if (raw === undefined || raw === null) return { hidden: [], order: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('tabs doit être un objet { hidden, order }');
  const o = raw as { hidden?: unknown; order?: unknown };
  const list = (v: unknown, what: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return fail(`${what} doit être une liste de clés d'onglets`);
    return [...new Set(v.map((x) => String(x)))];
  };
  const known = new Set<string>([...PROJECT_TAB_KEYS, ...pageSlugs.map((s) => `page:${s}`)]);
  const hidden = list(o.hidden, 'hidden');
  for (const k of hidden) {
    if (!(PROJECT_TAB_KEYS as readonly string[]).includes(k)) return fail(`Onglet inconnu « ${k} » (${PROJECT_TAB_KEYS.join(', ')})`);
    if (NEVER_HIDDEN.has(k)) return fail(`L'onglet « ${k} » ne se masque pas`);
  }
  const order = list(o.order, 'order').filter((k) => known.has(k));
  return { hidden, order };
}

interface Row {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  icon: string | null;
  position: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}
const toPage = (r: Row): ProjectPage => ({ id: r.id, projectId: r.project_id, slug: r.slug, title: r.title, icon: r.icon, position: r.position, createdById: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

export const projectPageRepository = {
  async list(projectId: string): Promise<ProjectPage[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_pages WHERE project_id = $1 ORDER BY position, created_at', [projectId]);
    return rows.map(toPage);
  },
  async findById(id: string): Promise<ProjectPage | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_pages WHERE id = $1', [id]);
    return rows[0] ? toPage(rows[0]) : null;
  },
  async findBySlug(projectId: string, slug: string): Promise<ProjectPage | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_pages WHERE project_id = $1 AND slug = $2', [projectId, slug]);
    return rows[0] ? toPage(rows[0]) : null;
  },
  async create(input: { projectId: string; slug: string; title: string; icon: string | null; position: number; createdById: string | null }): Promise<ProjectPage> {
    const { rows } = await pool.query<Row>('INSERT INTO project_pages (project_id, slug, title, icon, position, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [input.projectId, input.slug, input.title, input.icon, input.position, input.createdById]);
    return toPage(rows[0]);
  },
  async update(id: string, patch: { title?: string; icon?: string | null; position?: number }): Promise<ProjectPage | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (patch.title !== undefined) sets.push(`title = $${params.push(patch.title)}`);
    if (patch.icon !== undefined) sets.push(`icon = $${params.push(patch.icon)}`);
    if (patch.position !== undefined) sets.push(`position = $${params.push(patch.position)}`);
    const { rows } = await pool.query<Row>(`UPDATE project_pages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toPage(rows[0]) : null;
  },
  /** Supprime la page et les agencements de sa portée (versions comprises, par cascade). */
  async delete(page: ProjectPage): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM cockpit_layouts WHERE scope = $1', [`project:${page.projectId}:page:${page.slug}`]);
      await client.query('DELETE FROM project_pages WHERE id = $1', [page.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
  async tabs(projectId: string): Promise<ProjectTabs> {
    const { rows } = await pool.query<{ tabs: Partial<ProjectTabs> | null }>('SELECT tabs FROM projects WHERE id = $1', [projectId]);
    const t = rows[0]?.tabs ?? {};
    return { hidden: Array.isArray(t.hidden) ? t.hidden : [], order: Array.isArray(t.order) ? t.order : [] };
  },
  async setTabs(projectId: string, tabs: ProjectTabs): Promise<void> {
    await pool.query('UPDATE projects SET tabs = $2::jsonb, updated_at = now() WHERE id = $1', [projectId, toJson(tabs)]);
  },
};

export const projectPageService = {
  list: (projectId: string) => projectPageRepository.list(projectId),
  get: async (id: string) => {
    const page = await projectPageRepository.findById(id);
    if (!page) throw new AppError('Page personnalisée introuvable', 'NOT_FOUND');
    return page;
  },
  bySlug: async (projectId: string, slug: string) => {
    const page = await projectPageRepository.findBySlug(projectId, slug);
    if (!page) throw new AppError(`Page personnalisée « ${slug} » introuvable`, 'NOT_FOUND');
    return page;
  },

  /** Crée une page (titre obligatoire ; slug dérivé du titre, rendu unique ; icône Bootstrap facultative). */
  async create(projectId: string, input: { title: unknown; icon?: unknown; slug?: unknown; position?: number | null }, createdById: string | null): Promise<ProjectPage> {
    const existing = await projectPageRepository.list(projectId);
    if (existing.length >= LIMITS.pages) throw new AppError(`Au plus ${LIMITS.pages} pages personnalisées par projet`, 'VALIDATION');
    const title = parseTitle(input.title);
    const icon = parseIcon(input.icon);
    let slug = input.slug ? parseSlug(input.slug) : slugOf(title);
    if ((PROJECT_TAB_KEYS as readonly string[]).includes(slug)) slug = `${slug}-page`;
    const taken = new Set(existing.map((p) => p.slug));
    if (taken.has(slug)) {
      if (input.slug) throw new AppError(`Une page « ${slug} » existe déjà`, 'VALIDATION');
      let n = 2;
      while (taken.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    const position = input.position ?? (existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0);
    return projectPageRepository.create({ projectId, slug, title, icon, position, createdById });
  },

  async update(page: ProjectPage, input: { title?: unknown; icon?: unknown; position?: number | null }): Promise<ProjectPage> {
    const patch: { title?: string; icon?: string | null; position?: number } = {};
    if (input.title !== undefined && input.title !== null) patch.title = parseTitle(input.title);
    if (input.icon !== undefined) patch.icon = parseIcon(input.icon);
    if (input.position !== undefined && input.position !== null) patch.position = Math.max(0, Math.round(Number(input.position)));
    return (await projectPageRepository.update(page.id, patch)) ?? page;
  },

  delete: (page: ProjectPage) => projectPageRepository.delete(page),

  tabs: (projectId: string) => projectPageRepository.tabs(projectId),
  async setTabs(projectId: string, raw: unknown): Promise<ProjectTabs> {
    const pages = await projectPageRepository.list(projectId);
    const tabs = parseTabs(raw, pages.map((p) => p.slug));
    await projectPageRepository.setTabs(projectId, tabs);
    return tabs;
  },
};
