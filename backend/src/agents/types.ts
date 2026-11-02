/**
 * Agents de projet (Product Manager, Developer…) : un agent est un utilisateur (`users.kind = 'agent'`) membre de
 * son projet, avec ses propres comptes (réglages Claude, GitHub, coffre, consommation, indexés par son identifiant
 * comme pour une personne) et un profil (rôle, instructions, déclencheurs, actions). Tout ce qu'il fait est une
 * session dont il est le propriétaire (`sessions.owner_id`).
 */

export type AgentKind = 'product_manager' | 'developer' | 'custom';
export const AGENT_KINDS: AgentKind[] = ['product_manager', 'developer', 'custom'];
export const AGENT_KIND_LABELS: Record<AgentKind, string> = { product_manager: 'Product Manager', developer: 'Developer', custom: 'Agent' };

export interface AgentAvatar {
  /** Emoji affiché dans l'avatar (sinon l'initiale du nom). */
  emoji: string | null;
  /** Couleur de fond (hex), sinon une couleur dérivée du nom. */
  color: string | null;
}

/** Interrupteurs : ce qui convoque l'agent sans qu'une personne le mentionne. */
export interface AgentTriggers {
  /** Une tâche créée par une personne (ou par l'API) dans le projet : l'agent intervient pour la cadrer. */
  taskCreated: boolean;
  /** Restreint `taskCreated` aux tâches portant cette étiquette (vide : toutes). */
  taskCreatedTag: string | null;
  /** Une réponse humaine dans le fil d'une tâche où l'agent est intervenu lui revient comme une instruction. */
  threadFollowed: boolean;
  /** La pull request d'une tâche est fusionnée : l'agent est prévenu (étiquette « à livrer », rapporteur informé…). */
  prMerged: boolean;
  /** Une tâche passée par une personne à l'étiquette d'état `taskReadyTag` : l'agent démarre dessus. */
  taskReady: boolean;
  taskReadyTag: string | null;
}

export const DEFAULT_TRIGGERS: AgentTriggers = { taskCreated: false, taskCreatedTag: null, threadFollowed: true, prMerged: false, taskReady: false, taskReadyTag: null };

/** Action nommée : une instruction jouée par l'agent, à la demande ou à heures fixes (session planifiée dédiée). */
export interface AgentAction {
  key: string;
  label: string;
  instruction: string;
  /** Expression cron à cinq champs (null : à la demande seulement). */
  cron: string | null;
  timezone: string | null;
  /** Session planifiée qui porte l'action quand elle a un `cron` (créée et tenue à jour par le service). */
  scheduleSessionId: string | null;
}

export interface AgentProfile {
  /** Identifiant de l'utilisateur agent (clé du profil). */
  userId: string;
  projectId: string;
  kind: AgentKind;
  avatar: AgentAvatar;
  description: string;
  /** Markdown ajouté au prompt système de ses sessions, après le prompt du projet. */
  instructions: string;
  /** Ses sessions sur une tâche travaillent dans le dossier de la tâche (branche task/…) ; sinon un dossier par session. */
  taskFolder: boolean;
  /** Réglages par défaut de ses sessions (même forme que `sessions.config`). */
  defaults: Record<string, unknown>;
  /** En plus de sa propre bibliothèque de contexte, l'agent lit (et ses sessions reçoivent) celle du projet. */
  inheritContext: boolean;
  /** Personne qui prête son compte Claude à l'agent (null : les réglages Claude propres de l'agent). */
  claudeDelegateId: string | null;
  /** Personne qui prête ses comptes git (GitHub, GitLab, forge) à l'agent (null : les comptes propres de l'agent). */
  gitDelegateId: string | null;
  /** Comptes git prêtés en lecture seule : ni push, ni pull request. */
  gitDelegateReadOnly: boolean;
  triggers: AgentTriggers;
  actions: AgentAction[];
  enabled: boolean;
  archivedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Un agent : son profil et ce qui vient de l'utilisateur (`id` = `userId`). */
export interface Agent extends AgentProfile {
  id: string;
  name: string;
  email: string;
}

export type AgentManagerRole = 'owner' | 'manager';

export interface AgentManager {
  agentId: string;
  userId: string;
  role: AgentManagerRole;
  createdAt: Date;
}

export interface AgentActionInput {
  /** Absent : dérivé du libellé. */
  key?: string | null;
  label: string;
  instruction: string;
  cron?: string | null;
  timezone?: string | null;
}

export interface AgentInput {
  name?: string | null;
  kind?: AgentKind | null;
  avatar?: Partial<AgentAvatar> | null;
  description?: string | null;
  instructions?: string | null;
  taskFolder?: boolean | null;
  defaults?: Record<string, unknown> | null;
  triggers?: Partial<AgentTriggers> | null;
  /** Remplace la liste complète (les sessions planifiées des actions retirées sont supprimées). */
  actions?: AgentActionInput[] | null;
  inheritContext?: boolean | null;
}

/** Comptes qui servent aux sessions d'un propriétaire : les siens, ou ceux qu'une personne lui a prêtés (agent). */
export interface OwnerAccounts {
  /** Dont les réglages Claude (identifiants, modèle par défaut, budgets) font tourner la session. */
  claudeUserId: string;
  /** Dont les comptes GitHub / GitLab / forge servent le dépôt. */
  gitUserId: string;
  /** Comptes git prêtés en lecture seule : la session ne pousse pas et n'ouvre pas de pull request. */
  gitReadOnly: boolean;
}

export type AgentAccountKind = 'claude' | 'git';

export interface AgentStats {
  activeSessions: number;
  sessions: number;
  tasks: number;
  monthCostUsd: number;
  totalCostUsd: number;
  lastActivityAt: Date | null;
}

/** Modèle de départ d'un agent (préremplissage du formulaire). */
export interface AgentTemplate {
  kind: AgentKind;
  label: string;
  description: string;
  instructions: string;
  taskFolder: boolean;
  defaults: Record<string, unknown>;
  triggers: AgentTriggers;
  actions: AgentActionInput[];
  /** Nom proposé. */
  suggestedName: string;
  avatar: AgentAvatar;
}

export const normalizeTriggers = (t: Partial<AgentTriggers> | null | undefined): AgentTriggers => ({
  taskCreated: Boolean(t?.taskCreated),
  taskCreatedTag: t?.taskCreatedTag?.trim() || null,
  threadFollowed: t?.threadFollowed ?? DEFAULT_TRIGGERS.threadFollowed,
  prMerged: Boolean(t?.prMerged),
  taskReady: Boolean(t?.taskReady),
  taskReadyTag: t?.taskReadyTag?.trim() || null,
});

export const normalizeAvatar = (a: Partial<AgentAvatar> | null | undefined): AgentAvatar => ({ emoji: a?.emoji?.trim() || null, color: a?.color?.trim() || null });
