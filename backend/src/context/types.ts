export type AuthorType = 'human' | 'agent';

/** Qui effectue une opération sur le contexte : un humain via l'interface, ou un agent via une session. */
export interface Actor {
  type: AuthorType;
  sessionId?: string | null;
}

/**
 * Une bibliothèque de contexte : celle du projet (`agentId` null) ou celle, propre, d'un agent de projet (`agentId` = son
 * identifiant d'utilisateur). Même structure, mêmes outils ; un agent peut hériter de la bibliothèque du projet en plus de la sienne.
 */
export interface Library {
  projectId: string;
  agentId: string | null;
}

export interface ContextFolder {
  id: string;
  projectId: string;
  /** Bibliothèque propre d'un agent (null : bibliothèque du projet). */
  agentId: string | null;
  parentId: string | null;
  name: string;
  slug: string;
  /** Chemin de slugs depuis la racine, ex. "api/auth". */
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextInstruction {
  id: string;
  projectId: string;
  /** Bibliothèque propre d'un agent (null : bibliothèque du projet). */
  agentId: string | null;
  folderId: string | null;
  name: string;
  slug: string;
  /** Chemin de slugs, ex. "api/auth/regles-jwt". */
  path: string;
  description: string;
  content: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextInstructionVersion {
  id: string;
  instructionId: string;
  version: number;
  name: string;
  description: string;
  content: string;
  changeNote: string | null;
  authorType: AuthorType;
  authorSessionId: string | null;
  createdAt: Date;
}

export type ContextChangeKind =
  | 'folder.create'
  | 'folder.rename'
  | 'folder.move'
  | 'folder.delete'
  | 'instruction.create'
  | 'instruction.update'
  | 'instruction.move'
  | 'instruction.delete'
  | 'instruction.restore';

export interface ContextChange {
  id: string;
  projectId: string;
  agentId: string | null;
  kind: ContextChangeKind;
  path: string;
  details: Record<string, unknown>;
  authorType: AuthorType;
  authorSessionId: string | null;
  createdAt: Date;
}

/** Arborescence complète d'un projet, à plat (chemins calculés). */
export interface ContextTree {
  folders: ContextFolder[];
  instructions: ContextInstruction[];
}
