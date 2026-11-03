import { sessionRequester } from '../approvals/service.js';
import { auditService } from '../audit/service.js';
import { AppError } from '../errors.js';
import { ANSWERED_BY, RequestCancelledError } from '../requests/service.js';
import type { CreateRequestInput, PermissionResponse } from '../requests/types.js';
import { sessionService } from '../sessions/service.js';
import { userService } from '../users/service.js';
import { ROLE_RANK, type User } from '../users/types.js';

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

/** Accord implicite d'une fusion : qui l'accorde (null : on pose la demande) et comment le tracer. */
export interface ImplicitMerge {
  approver: () => Promise<User | null>;
  trace: (approver: User) => Promise<void>;
}

/**
 * Personne qui accorde implicitement la fusion demandée par la session `sessionId` : en mode « Tout autoriser »
 * (bypassPermissions, relu en base à chaque appel car il change à chaud), la personne qui pilote la session (prise en
 * main, sinon demandeuse, sinon propriétaire quand c'est une personne), si elle a au moins le rôle membre. null sinon :
 * la demande est alors posée.
 */
export async function implicitMergeApprover(sessionId: string, projectId: string): Promise<User | null> {
  const session = await sessionService.get(sessionId);
  if (!session || session.config?.permissionMode !== 'bypassPermissions') return null;
  const person = await sessionRequester(session);
  if (!person) return null;
  const role = await userService.roleFor(person.id, projectId);
  return role && ROLE_RANK[role] >= ROLE_RANK.member ? person : null;
}

/**
 * Branchement de `tasks.pr_merge` dans un provider : accord implicite en mode « Tout autoriser » (tracé dans le
 * transcript et le journal d'audit), sinon demande à une personne du projet.
 */
export function sessionMergeApprover(ctx: { session: { id: string }; ask: (input: CreateRequestInput) => Promise<Record<string, unknown>>; emit: (type: string, payload?: Record<string, unknown>) => Promise<void> }) {
  return (approval: MergeApproval) =>
    askMergeApproval(ctx.ask, approval, {
      approver: () => implicitMergeApprover(ctx.session.id, approval.projectId),
      trace: async (approver) => {
        const who = approver.name || approver.email;
        await ctx.emit('system', { message: `Fusion de la pull request ${approval.ref} acceptée implicitement (mode « Tout autoriser ») : elle est faite avec le compte de ${who}.` });
        await auditService.record({
          projectId: approval.projectId,
          actor: { sessionId: ctx.session.id },
          action: 'pull_request.merge_implicit',
          targetType: 'pull_request',
          targetId: approval.ref,
          targetLabel: approval.title,
          details: { url: approval.url, method: approval.method, approvedBy: approver.id },
        });
      },
    });
}

/**
 * Demande à une personne du projet d'accepter la fusion d'une PR et renvoie son identifiant : la fusion est faite
 * avec son compte (GitHub, GitLab, Forgejo), à son nom. Jamais mémorisable (pas de suggestion de règle), et posée même
 * en mode « ne jamais demander » : sans réponse, on ne saurait pas au nom de qui fusionner. Exception : `implicit`
 * (mode « Tout autoriser » d'une session pilotée par une personne) renvoie directement cette personne. Lève si la demande est
 * refusée, annulée, ou si la personne qui accepte n'est pas au moins membre du projet.
 */
export async function askMergeApproval(ask: (input: CreateRequestInput) => Promise<Record<string, unknown>>, approval: MergeApproval, implicit?: ImplicitMerge): Promise<string> {
  const approver = implicit ? await implicit.approver() : null;
  if (approver && implicit) {
    await implicit.trace(approver);
    return approver.id;
  }
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
