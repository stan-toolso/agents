import { AppError } from '../errors.js';
import { ANSWERED_BY, RequestCancelledError } from '../requests/service.js';
import type { CreateRequestInput, PermissionResponse } from '../requests/types.js';
import { userService } from '../users/service.js';
import { ROLE_RANK } from '../users/types.js';

/** Fusion d'une pull request demandée par une session (`tasks.pr_merge`), soumise à une personne du projet. */
export interface MergeApproval {
  projectId: string;
  /** Libellé de la PR (« #161 », « owner/repo#12 ») et son titre. */
  ref: string;
  title: string;
  url: string;
  method: string;
  /** Paramètres de l'outil, affichés dans la demande. */
  input: Record<string, unknown>;
}

/**
 * Demande à une personne du projet d'accepter la fusion d'une PR et renvoie son identifiant : la fusion est faite
 * avec son compte (GitHub, GitLab, Forgejo), à son nom. Jamais mémorisable (pas de suggestion de règle), et posée même
 * en mode « ne jamais demander » : sans réponse, on ne saurait pas au nom de qui fusionner. Lève si la demande est
 * refusée, annulée, ou si la personne qui accepte n'est pas au moins membre du projet.
 */
export async function askMergeApproval(ask: (input: CreateRequestInput) => Promise<Record<string, unknown>>, approval: MergeApproval): Promise<string> {
  let response: Partial<PermissionResponse> & Record<string, unknown>;
  try {
    response = (await ask({
      type: 'permission',
      title: `Fusionner la pull request ${approval.ref} « ${approval.title} »`,
      message: `La fusion (${approval.method.toLowerCase()}) sera faite avec votre compte, à votre nom : ${approval.url}`,
      payload: { toolName: 'mcp__tasks__pr_merge', input: approval.input, suggestions: [], merge: true },
    })) as Partial<PermissionResponse> & Record<string, unknown>;
  } catch (err) {
    if (err instanceof RequestCancelledError) throw new AppError('Demande annulée (session arrêtée ou demande abandonnée)', 'FORBIDDEN');
    throw err;
  }
  if (response.decision !== 'allow') throw new AppError(response.message || 'Fusion refusée par la personne sollicitée', 'FORBIDDEN');
  const userId = typeof response[ANSWERED_BY] === 'string' ? (response[ANSWERED_BY] as string) : null;
  if (!userId) throw new AppError("Fusion acceptée sans personne identifiée : impossible de savoir avec quel compte fusionner", 'FORBIDDEN');
  const user = await userService.get(userId);
  if (user.kind !== 'person') throw new AppError('Seule une personne peut accepter une fusion', 'FORBIDDEN');
  const role = await userService.roleFor(userId, approval.projectId);
  if (!role || ROLE_RANK[role] < ROLE_RANK.member) throw new AppError(`${user.name} n'a pas le rôle membre sur le projet : fusion refusée`, 'FORBIDDEN');
  return userId;
}
