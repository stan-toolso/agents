import type { Actor } from '../context/types.js';
import type { TaskActor, TaskMention } from '../tasks/types.js';

/**
 * Genre d'une conversation : un canal du projet, ou le fil d'une tâche (une conversation par tâche, créée à son
 * premier message ou à sa première réaction ; on y écrit par les façades de la tâche, tasks/service.ts).
 */
export type ConversationKind = 'channel' | 'task';

/** Canal de conversation d'un projet (« général », « livraisons »…), ou fil d'une tâche (`kind` « task »). */
export interface Conversation {
  id: string;
  projectId: string;
  kind: ConversationKind;
  /** Tâche dont c'est le fil (genre « task »), sinon null. */
  taskId: string | null;
  slug: string;
  name: string;
  topic: string;
  createdById: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** Message d'un canal : racine, ou réponse à une racine (`parentId`), comme un fil Slack. Même forme qu'un commentaire de tâche. */
export interface Message {
  id: string;
  conversationId: string;
  parentId: string | null;
  authorType: Actor['type'];
  authorUserId: string | null;
  authorSessionId: string | null;
  /** Nom au moment de l'écriture, conservé ensuite. */
  authorName: string;
  body: string;
  mentions: TaskMention[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fichier joint à un message (capture collée, document) ; contenu sous WORKSPACES_ROOT/.message-attachments/<canal>/<id>/<nom>. */
export interface MessageAttachment {
  id: string;
  conversationId: string;
  messageId: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: Date;
}

/** Réaction (emoji) d'une personne ou d'une session sur un message, ou sur le message d'ouverture de la conversation (`messageId` null : la description d'une tâche). */
export interface MessageReaction {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  emoji: string;
  actorType: Actor['type'];
  userId: string | null;
  sessionId: string | null;
  actorName: string;
  createdAt: Date;
}

/** Qui écrit ou réagit : une personne (interface), une session d'agent (outil MCP). */
export type MessageActor = TaskActor;

/** Changement diffusé aux écouteurs (sessions reliées au fil, déclencheurs des agents). */
export type ConversationChange =
  | { kind: 'posted'; conversation: Conversation; message: Message; root: Message; parent: Message | null; attachments: MessageAttachment[] }
  | { kind: 'reacted'; conversation: Conversation; message: Message; reaction: MessageReaction; added: boolean };

/** Slug de la conversation d'une tâche. */
export const taskConversationSlug = (taskId: string) => `task-${taskId}`;

/** Slug d'un canal, nom technique de la table (conversation) : 60 caractères au plus. */
export const CONVERSATION_SLUG_MAX = 60;
export const CONVERSATION_NAME_MAX = 60;
export const CONVERSATION_TOPIC_MAX = 250;
/** Slug du canal créé d'office dans chaque projet. */
export const GENERAL_SLUG = 'general';
export const GENERAL_NAME = 'général';
