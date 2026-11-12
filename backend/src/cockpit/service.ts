import { AppError } from '../errors.js';
import { sharedPageService } from '../sharedPages/service.js';
import { userService } from '../users/service.js';
import type { User } from '../users/types.js';
import { catalogFor } from './catalog.js';
import { defaultLayout } from './defaults.js';
import { applyOps, parseLayout } from './layout.js';
import { cockpitRepository, type LayoutRow } from './repository.js';
import { parseScope } from './scope.js';
import type { Block, CockpitArtifactView, Layout, LayoutVersion, Region, ResolvedLayout, Scope, ScopeKind, WidgetDef } from './types.js';

/**
 * Agencements du cockpit : résolution (enregistré, sinon le défaut), enregistrement versionné, réinitialisation,
 * historique et restauration, avec les droits de la personne : son accueil n'appartient qu'à elle ; le tableau de bord
 * d'un projet se lit avec le rôle lecteur et se modifie avec le rôle membre. L'interface (mutations GraphQL) et les
 * agents (outil `cockpit`) passent tous par ici.
 */

interface Access {
  scope: Scope;
  canEdit: boolean;
  personal: boolean;
}

async function access(user: User, key: string): Promise<Access> {
  const scope = parseScope(key);
  if (scope.kind === 'home') return { scope, canEdit: true, personal: false };
  const projectId = scope.projectId as string;
  const role = await userService.roleFor(user.id, projectId);
  if (!role) throw new AppError("Vous n'avez pas accès à ce projet", 'FORBIDDEN');
  return { scope, canEdit: role !== 'viewer', personal: await userService.isPersonalProject(projectId) };
}

const assertEdit = (a: Access) => {
  if (!a.canEdit) throw new AppError('Modifier cet agencement demande le rôle membre sur le projet', 'FORBIDDEN');
};

/**
 * Un agencement lu en base est revalidé bloc par bloc : un bloc qu'une version plus récente du catalogue ne connaît
 * plus (ou n'admet plus là) est ignoré plutôt que de rendre la page inutilisable.
 */
export function sanitizeLayout(raw: unknown, kind: ScopeKind): Layout {
  try {
    return parseLayout(raw, kind);
  } catch {
    const blocks = Array.isArray((raw as { blocks?: unknown })?.blocks) ? ((raw as { blocks: unknown[] }).blocks as unknown[]) : [];
    const kept: Block[] = [];
    for (const b of blocks) {
      try {
        kept.push(...parseLayout({ v: 1, blocks: [...kept, b] }, kind).blocks.slice(kept.length));
      } catch {
        // bloc ignoré
      }
    }
    return { v: 1, blocks: kept };
  }
}

function resolved(a: Access, row: LayoutRow | null): ResolvedLayout {
  const stored = row?.layout ?? null;
  return {
    scope: a.scope,
    layout: stored ? sanitizeLayout(stored, a.scope.kind) : defaultLayout(a.scope, { personal: a.personal }),
    version: row?.version ?? 0,
    isDefault: !stored,
    updatedAt: row?.updated_at ?? null,
    updatedById: row?.updated_by ?? null,
    canEdit: a.canEdit,
  };
}

export interface UpdateInput {
  /** Agencement complet… */
  layout?: unknown;
  /** …ou opérations appliquées à l'agencement actuel. */
  ops?: unknown;
  note?: string | null;
  /** Session d'agent à l'origine du changement. */
  sessionId?: string | null;
}

/**
 * Les artefacts épinglés d'un agencement partagé doivent être visibles par l'équipe. On vérifie que la personne qui
 * enregistre les voit (sinon refus : on n'épingle pas ce qu'on ne voit pas) et on avertit quand l'artefact n'est ouvert
 * ni au projet ni par le lien : les autres membres verraient « artefact non partagé avec vous ».
 */
async function checkArtifacts(user: User, scope: Scope, layout: Layout): Promise<string[]> {
  const warnings: string[] = [];
  for (const b of layout.blocks) {
    if (b.kind !== 'artifact') continue;
    const page = await sharedPageService.getFor(user.id, b.artifact).catch(() => null);
    if (!page) throw new AppError(`Artefact ${b.artifact} introuvable, ou non partagé avec vous`, 'VALIDATION');
    if (scope.kind !== 'home' && !page.linkAccess && !page.projectAccess) warnings.push(`« ${page.title} » n'est ouvert ni aux membres du projet ni par le lien : les autres membres ne le verront pas (ouvrez-le aux membres du projet depuis l'artefact, ou avec updateSharedPage { projectAccess: true }).`);
    else if (scope.kind !== 'home' && page.projectAccess && page.projectId !== scope.projectId && !page.linkAccess) warnings.push(`« ${page.title} » est ouvert aux membres d'un autre projet : les membres de celui-ci ne le verront pas tous.`);
  }
  return warnings;
}

export const cockpitService = {
  catalog: (kind: ScopeKind): WidgetDef[] => catalogFor(kind),

  /** Les artefacts épinglés, tels que la personne les voit (un artefact hors de portée n'est pas révélé). */
  async artifactsFor(user: User, layout: Layout): Promise<CockpitArtifactView[]> {
    const ids = [...new Set(layout.blocks.filter((b): b is Extract<Block, { kind: 'artifact' }> => b.kind === 'artifact').map((b) => b.artifact))];
    return Promise.all(
      ids.map(async (id) => {
        const page = await sharedPageService.getFor(user.id, id).catch(() => null);
        if (!page) return { id, viewable: false, title: null, kind: null, version: null, dataRefreshedAt: null, linkAccess: null, projectAccess: null, ownerId: null, canManage: false };
        return { id, viewable: true, title: page.title, kind: page.kind, version: page.version, dataRefreshedAt: page.dataRefreshedAt, linkAccess: page.linkAccess, projectAccess: page.projectAccess, ownerId: page.ownerId, canManage: sharedPageService.canManage(page, user) };
      }),
    );
  },

  /** Épingle un artefact en fin de région (bloc artefact), en une opération. */
  async pin(user: User, key: string, input: { artifactId: string; region?: string | null; title?: string | null; sessionId?: string | null }): Promise<{ result: ResolvedLayout; before: Layout }> {
    const region = (input.region ?? 'full') as Region;
    return this.update(user, key, { ops: [{ op: 'add', block: { kind: 'artifact', artifact: input.artifactId, region, title: input.title ?? undefined } }], note: 'Artefact épinglé', sessionId: input.sessionId });
  },

  async resolve(user: User, key: string): Promise<ResolvedLayout> {
    const a = await access(user, key);
    return resolved(a, await cockpitRepository.find(a.scope, user.id));
  },

  /** Enregistre une nouvelle version et renvoie l'agencement résolu, avec celui d'avant (pour décrire le changement). */
  async update(user: User, key: string, input: UpdateInput): Promise<{ result: ResolvedLayout; before: Layout }> {
    const a = await access(user, key);
    assertEdit(a);
    const current = resolved(a, await cockpitRepository.find(a.scope, user.id));
    let layout: Layout;
    if (input.ops !== undefined && input.ops !== null) layout = applyOps(current.layout, input.ops, a.scope.kind);
    else if (input.layout !== undefined && input.layout !== null) layout = parseLayout(input.layout, a.scope.kind);
    else throw new AppError("Rien à enregistrer : passez l'agencement complet (layout) ou des opérations (ops)", 'VALIDATION');
    const warnings = await checkArtifacts(user, a.scope, layout);
    const row = await cockpitRepository.save({ scope: a.scope, userId: user.id, layout, snapshot: layout, authorId: user.id, sessionId: input.sessionId ?? null, note: input.note?.trim() || null });
    return { result: { ...resolved(a, row), warnings }, before: current.layout };
  },

  /** Retour au défaut : l'agencement enregistré est effacé (l'historique le garde). */
  async reset(user: User, key: string, sessionId: string | null = null): Promise<ResolvedLayout> {
    const a = await access(user, key);
    assertEdit(a);
    const existing = await cockpitRepository.find(a.scope, user.id);
    if (!existing || !existing.layout) return resolved(a, existing);
    const row = await cockpitRepository.save({ scope: a.scope, userId: user.id, layout: null, snapshot: defaultLayout(a.scope, { personal: a.personal }), authorId: user.id, sessionId, note: 'Réinitialisation' });
    return resolved(a, row);
  },

  async history(user: User, key: string): Promise<LayoutVersion[]> {
    const a = await access(user, key);
    const row = await cockpitRepository.find(a.scope, user.id);
    return row ? cockpitRepository.history(row.id) : [];
  },

  /** Remet une ancienne version en tête (nouvelle version, l'historique reste linéaire). */
  async restore(user: User, key: string, version: number, sessionId: string | null = null): Promise<ResolvedLayout> {
    const a = await access(user, key);
    assertEdit(a);
    const row = await cockpitRepository.find(a.scope, user.id);
    const old = row ? await cockpitRepository.version(row.id, version) : null;
    if (!old) throw new AppError(`Version ${version} introuvable`, 'NOT_FOUND');
    const layout = sanitizeLayout(old.layout, a.scope.kind);
    const saved = await cockpitRepository.save({ scope: a.scope, userId: user.id, layout, snapshot: layout, authorId: user.id, sessionId, note: `Restauration de la version ${version}` });
    return resolved(a, saved);
  },
};
