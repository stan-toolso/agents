import { userRepository } from '../users/repository.js';
import { sessionRepository } from './repository.js';
import type { Session } from './types.js';

/**
 * Auteur d'une instruction : la personne qui l'écrit, la session d'agent qui l'envoie (outil `sessions.send`,
 * convocation, sous-session), ou Skipper lui-même (reprise après un redémarrage, planification, fil d'une tâche,
 * nettoyage du contexte…). Journalisé avec l'instruction (`author` de l'événement `instruction`) et annoncé au modèle
 * par une ligne d'en-tête (`authorHeader`), pour qu'il sache à qui il répond.
 */
export type InstructionAuthor =
  | { type: 'user'; id: string; name: string; email: string | null }
  | { type: 'session'; id: string; name: string }
  | { type: 'system'; name: string };

export const SYSTEM_AUTHOR: InstructionAuthor = { type: 'system', name: 'Skipper' };

export const systemAuthor = (name: string): InstructionAuthor => ({ type: 'system', name });

/** Une personne déjà chargée (utilisateur connecté). */
export const personAuthor = (user: { id: string; name: string; email: string }): InstructionAuthor => ({ type: 'user', id: user.id, name: user.name || user.email, email: user.email || null });

/** La personne `userId`, ou null si elle n'existe plus. */
export async function userAuthor(userId: string | null | undefined): Promise<InstructionAuthor | null> {
  if (!userId) return null;
  const user = await userRepository.findById(userId);
  return user ? personAuthor(user) : null;
}

/** La session d'agent `sessionId`, ou null si elle n'existe plus. */
export async function sessionAuthor(sessionId: string | null | undefined): Promise<InstructionAuthor | null> {
  if (!sessionId) return null;
  const session = await sessionRepository.findById(sessionId);
  return session ? { type: 'session', id: session.id, name: session.name } : null;
}

/**
 * Auteur de la consigne de départ d'une session : la session d'agent qui l'a lancée, sinon la personne qui l'a
 * demandée à un agent, sinon sa propriétaire quand c'est une personne ; Skipper à défaut (workflow, agent seul).
 */
export async function promptAuthor(session: Pick<Session, 'parentSessionId' | 'requestedById' | 'ownerId'>): Promise<InstructionAuthor> {
  const parent = await sessionAuthor(session.parentSessionId);
  if (parent) return parent;
  const requester = await userAuthor(session.requestedById);
  if (requester) return requester;
  if (session.ownerId) {
    const owner = await userRepository.findById(session.ownerId);
    if (owner && owner.kind !== 'agent') return personAuthor(owner);
  }
  return SYSTEM_AUTHOR;
}

/**
 * Ligne placée devant l'instruction pour le modèle (absente du texte journalisé) : qui écrit. Rien pour Skipper (ses
 * messages disent d'eux-mêmes d'où ils viennent) ni pour une commande (`/compact`), que le CLI doit reconnaître telle quelle.
 */
export function authorHeader(author: InstructionAuthor | null | undefined, text: string): string | null {
  if (!author || text.trimStart().startsWith('/')) return null;
  if (author.type === 'user') return `[Message de ${author.name}${author.email && author.email !== author.name ? ` <${author.email}>` : ''}]`;
  if (author.type === 'session') return `[Message de la session d'agent « ${author.name} » (@session:${author.id})]`;
  return null;
}

/** Relu d'un JSON (file d'attente, appel entre instances) : un auteur bien formé, sinon null. */
export function parseAuthor(value: unknown): InstructionAuthor | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === 'string' ? v.name : '';
  if (v.type === 'user' && typeof v.id === 'string') return { type: 'user', id: v.id, name, email: typeof v.email === 'string' ? v.email : null };
  if (v.type === 'session' && typeof v.id === 'string') return { type: 'session', id: v.id, name };
  if (v.type === 'system' && name) return { type: 'system', name };
  return null;
}
