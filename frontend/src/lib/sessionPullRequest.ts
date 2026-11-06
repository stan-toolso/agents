import { prRef, type TrackedPullRequestSummary } from '../graphql/pullRequests';

/**
 * Carte « pull request à fusionner » de la page de session : quand la PR suivie du dossier de travail de la session
 * attend sa fusion, la carte propose les actions principales ; chacune envoie une instruction à la session (l'agent
 * agit avec ses outils `tasks` : pr_merge, pr_close, ci_status…). Fonctions pures, testées à part.
 */
export type SessionPullRequestAction = 'merge' | 'resolveConflicts' | 'fixCi' | 'close';

type Pr = Pick<TrackedPullRequestSummary, 'number' | 'repo' | 'foreignRepo' | 'headBranch' | 'baseBranch' | 'title' | 'stage' | 'mergeable' | 'checksState' | 'url'>;

/** La carte ne se montre que pour une PR ouverte, prête à fusionner (ni brouillon, ni en préparation, ni terminée). */
export const showsPullRequestCard = (pr: Pick<Pr, 'stage' | 'number'> | null | undefined): pr is Pr => Boolean(pr && pr.stage === 'TO_MERGE' && pr.number != null);

const conflicting = (pr: Pr) => pr.mergeable === 'CONFLICTING';
const ciFailing = (pr: Pr) => pr.checksState === 'FAILURE' || pr.checksState === 'ERROR';

/** Actions proposées, la principale en premier : on règle d'abord ce qui bloque la fusion (conflits, CI rouge). */
export function pullRequestCardActions(pr: Pr): SessionPullRequestAction[] {
  const blockers: SessionPullRequestAction[] = [];
  if (conflicting(pr)) blockers.push('resolveConflicts');
  if (ciFailing(pr)) blockers.push('fixCi');
  return [...blockers, 'merge', 'close'];
}

/** État de la PR en une ligne (ce qui bloque ou ce qui est prêt), pour l'en-tête de la carte. */
export function pullRequestCardStatus(pr: Pr): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
  if (conflicting(pr)) return { text: `en conflit avec ${pr.baseBranch}`, tone: 'bad' };
  if (ciFailing(pr)) return { text: 'CI en échec', tone: 'bad' };
  if (pr.checksState === 'PENDING' || pr.checksState === 'EXPECTED') return { text: 'CI en cours', tone: 'warn' };
  if (pr.checksState === 'SUCCESS') return { text: 'CI verte, prête à fusionner', tone: 'ok' };
  return { text: 'prête à fusionner', tone: 'dim' };
}

export const ACTION_LABELS: Record<SessionPullRequestAction, { label: string; icon: string; hint: string }> = {
  merge: { label: 'Fusionner', icon: 'bi-git', hint: "Demande à l'agent de fusionner la PR (avec votre accord, et votre compte)" },
  resolveConflicts: { label: 'Résoudre les conflits', icon: 'bi-sign-merge-left', hint: "Demande à l'agent de fusionner la base dans la branche, résoudre les conflits et pousser" },
  fixCi: { label: 'Corriger la CI', icon: 'bi-wrench', hint: "Demande à l'agent de lire les checks en échec, corriger et pousser" },
  close: { label: 'Annuler la PR', icon: 'bi-x-circle', hint: "Demande à l'agent de fermer la PR sans la fusionner (branche et dossier gardés)" },
};

/** Instruction envoyée à la session pour une action de la carte. `reason` : la raison d'une annulation, facultative. */
export function pullRequestInstruction(action: SessionPullRequestAction, pr: Pr, reason?: string | null): string {
  const ref = `la pull request ${prRef(pr)} « ${pr.title} »`;
  switch (action) {
    case 'merge':
      return `Fusionne ${ref} avec tasks.pr_merge. Vérifie d'abord qu'elle n'est pas en conflit et que sa CI est verte (tasks.ci_status) : si quelque chose bloque, dis-moi quoi au lieu de fusionner. Une fois fusionnée, rends compte en une phrase.`;
    case 'resolveConflicts':
      return `${ref[0].toUpperCase()}${ref.slice(1)} est en conflit avec ${pr.baseBranch}. Récupère la base (git fetch origin), fusionne origin/${pr.baseBranch} dans ${pr.headBranch}, résous les conflits en gardant les intentions des deux côtés, vérifie (typecheck et tests), commite et pousse. Ne fusionne pas la PR ; rends compte de ce que tu as résolu.`;
    case 'fixCi':
      return `La CI de ${ref} est en échec. Lis les checks (tasks.ci_status sur ${pr.headBranch}), reproduis l'échec en local, corrige, vérifie, commite et pousse. Ne fusionne pas la PR ; rends compte de la cause et de la correction.`;
    case 'close': {
      const why = reason?.trim();
      return `Annule ${ref} : ferme-la sans la fusionner avec tasks.pr_close${why ? `, avec ce commentaire : « ${why} »` : ''}. Garde la branche et le dossier de travail.`;
    }
  }
}
