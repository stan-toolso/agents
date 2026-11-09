/**
 * Renvoi des commentaires à la session qui a publié la page : désactivé, sur demande (bouton « Transmettre à
 * l'agent »), ou automatique (chaque commentaire ou réponse d'une personne lui est transmis aussitôt).
 */
export type AgentHandoff = 'off' | 'manual' | 'auto';
export const AGENT_HANDOFF_MODES: readonly AgentHandoff[] = ['off', 'manual', 'auto'];

/** Page HTML publiée par une personne ou un agent, servie à /shared/<id>, privée par défaut. */
export interface SharedPage {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  /** Visible par quiconque est connecté et a le lien. */
  linkAccess: boolean;
  /** Numéro de la dernière version. */
  version: number;
  projectId: string | null;
  sessionId: string | null;
  sourcePath: string | null;
  /** Réglé par le propriétaire ; sans effet tant que la page n'a pas de session d'origine. */
  agentHandoff: AgentHandoff;
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedPageVersion {
  pageId: string;
  version: number;
  size: number;
  createdById: string | null;
  sessionId: string | null;
  createdAt: Date;
}

export interface SharedPageMember {
  pageId: string;
  userId: string;
  addedById: string | null;
  createdAt: Date;
}

export interface PublishInput {
  ownerId: string;
  title: string;
  description?: string | null;
  html: Buffer;
  /** Nouvelle version d'une page existante. */
  pageId?: string | null;
  linkAccess?: boolean | null;
  projectId?: string | null;
  sessionId?: string | null;
  sourcePath?: string | null;
}

/** Élément de la page visé par un commentaire (choisi en cliquant dans la page). */
export interface CommentAnchor {
  /** Sélecteur CSS de l'élément, calculé par le script injecté dans la page. */
  selector: string;
  /** Extrait du texte de l'élément, pour le reconnaître dans la liste. */
  text: string | null;
  /** Balise de l'élément (en minuscules). */
  tag: string | null;
}

/**
 * Commentaire sur une page partagée : général ou ancré sur un élément. Un commentaire racine ouvre une
 * micro-conversation (réponses avec `parentId`) et porte l'état « traité » (`resolvedAt`).
 */
export interface SharedPageComment {
  id: string;
  pageId: string;
  parentId: string | null;
  authorId: string;
  /** Posté par une session d'agent. */
  sessionId: string | null;
  body: string;
  anchor: CommentAnchor | null;
  /** Version de la page au moment du commentaire. */
  version: number;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
