/**
 * Cockpit configurable : un tableau de bord (accueil d'une personne, tableau de bord d'un projet…) est un agencement
 * de blocs dans des régions fixes. Les blocs sont natifs (composants du cockpit, décrits par le catalogue) ou des
 * artefacts (une page HTML de l'agent dans un cadre). Voir docs/conception/cockpit-configurable.md.
 */

/** Régions d'un tableau de bord, dans l'ordre d'affichage (sur mobile : les unes sous les autres). */
export const REGIONS = ['tiles', 'main', 'side', 'full'] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region, string> = {
  tiles: 'Tuiles',
  main: 'Colonne principale',
  side: 'Colonne latérale',
  full: 'Pleine largeur',
};

/** Types de portée : où un agencement s'applique. */
export const SCOPE_KINDS = ['home', 'project', 'tasks', 'agent', 'page'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Portée analysée (cockpit/scope.ts). */
export interface Scope {
  kind: ScopeKind;
  /** Clé canonique : 'home', 'project:<id>', 'project:<id>:tasks', 'agent:<id>', 'project:<id>:page:<slug>'. */
  key: string;
  /** Projet concerné (null pour « home »). */
  projectId: string | null;
  /** Agent concerné (portée « agent »). */
  agentId: string | null;
  /** Page personnalisée (portée « page »). */
  slug: string | null;
}

export type BlockParams = Record<string, unknown>;

export interface BuiltinBlock {
  id: string;
  kind: 'builtin';
  /** Clé du catalogue (ex. `list.attention_tasks`). */
  widget: string;
  region: Region;
  /** Titre affiché, sinon celui du catalogue. */
  title?: string | null;
  params?: BlockParams;
}

export interface ArtifactBlock {
  id: string;
  kind: 'artifact';
  /** Identifiant de l'artefact (shared_pages.id). */
  artifact: string;
  /** Version affichée ; absente : la dernière. */
  version?: number | null;
  region: Region;
  title?: string | null;
  /** Transmis à la page dans `Skipper.context.params`. */
  params?: BlockParams;
  /** Hauteur fixe en pixels ; absente : au contenu (protocole de redimensionnement). */
  height?: number | null;
  /** Rechargement périodique du cadre (secondes, 15 au moins) ; absent : au rafraîchissement des données. */
  pollSeconds?: number | null;
}

export type Block = BuiltinBlock | ArtifactBlock;

export interface Layout {
  v: 1;
  blocks: Block[];
}

/** Paramètre d'un bloc natif, décrit pour le formulaire de l'interface et pour les agents. */
export interface WidgetParam {
  key: string;
  label: string;
  type: 'int' | 'bool' | 'tags' | 'select' | 'text' | 'markdown';
  description?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  default?: unknown;
}

/** Un bloc natif du catalogue. */
export interface WidgetDef {
  key: string;
  label: string;
  description: string;
  /** Portées où le bloc a un sens. */
  scopes: ScopeKind[];
  /** Région par défaut. */
  region: Region;
  /** Régions admises. */
  regions: Region[];
  /** Un seul exemplaire par agencement. */
  singleton?: boolean;
  params: WidgetParam[];
}

/** Agencement résolu pour une portée : celui enregistré, sinon le défaut. */
export interface ResolvedLayout {
  scope: Scope;
  layout: Layout;
  /** 0 tant que rien n'a jamais été enregistré. */
  version: number;
  /** Aucun agencement enregistré (ou réinitialisé) : c'est le défaut du code. */
  isDefault: boolean;
  updatedAt: Date | null;
  updatedById: string | null;
  /** La personne peut modifier cet agencement. */
  canEdit: boolean;
  /** Avertissements du dernier enregistrement (artefact invisible pour l'équipe…). */
  warnings?: string[];
}

/** Un artefact épinglé, tel que la personne le voit (viewable false : rien d'autre n'est révélé). */
export interface CockpitArtifactView {
  id: string;
  viewable: boolean;
  title: string | null;
  kind: string | null;
  version: number | null;
  dataRefreshedAt: Date | null;
  linkAccess: boolean | null;
  projectAccess: boolean | null;
  ownerId: string | null;
  canManage: boolean;
}

export interface LayoutVersion {
  version: number;
  layout: Layout;
  reset: boolean;
  authorId: string | null;
  sessionId: string | null;
  note: string | null;
  createdAt: Date;
}

/** Opérations d'édition d'un agencement (outil `cockpit.update`, mode « Personnaliser »). */
export type LayoutOp =
  | { op: 'add'; block: Partial<Block> & { kind: 'builtin' | 'artifact' }; index?: number | null }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; region?: Region | null; index?: number | null }
  | { op: 'set'; id: string; title?: string | null; params?: BlockParams | null };
