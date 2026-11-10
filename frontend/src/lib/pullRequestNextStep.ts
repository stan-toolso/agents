import { localWorkText, prRef, type TrackedPullRequest } from '../graphql/pullRequests';
import { ACTION_LABELS, pullRequestInstruction, type SessionPullRequestAction } from './sessionPullRequest';

/**
 * Page des pull requests d'un projet : ce qui est attendu pour chaque PR suivie, en une phrase, et les demandes qu'on
 * peut envoyer à la session qui la suit (l'agent agit avec ses outils `tasks` ; rien n'est fait directement sur la
 * forge depuis la page). Fonctions pures, testées à part.
 */

/** Demande envoyée à la session : celles de la carte de session, plus « ouvrir la PR » pour une branche en préparation. */
export type PullRequestRequest = SessionPullRequestAction | 'open';

/**
 * Qui doit agir : `you` (une décision vous attend), `blocked` (quelque chose bloque, à faire corriger), `agent` (l'agent
 * travaille, rien à faire), `wait` (vérifications en cours), `done` (terminée), `orphan` (aucune session ne suit la PR).
 */
export type NextStepTone = 'you' | 'blocked' | 'agent' | 'wait' | 'done' | 'orphan';

export interface NextStep {
  /** Libellé court (pastille de la ligne). */
  label: string;
  tone: NextStepTone;
  /** Ce qui est attendu, en une phrase. */
  detail: string;
  /** Demandes proposées, la principale en premier ; vides si aucune session ne peut les recevoir. */
  requests: PullRequestRequest[];
}

export type NextStepPr = Pick<TrackedPullRequest, 'number' | 'repo' | 'foreignRepo' | 'headBranch' | 'baseBranch' | 'title' | 'stage' | 'status' | 'mergeable' | 'checksState' | 'reviewDecision' | 'url' | 'localCommits' | 'localChanges'> & {
  task: { id: string; title: string } | null;
  session: { id: string; name: string; status: string; activity?: string | null } | null;
};

/** La session est en train de travailler (tour en cours). */
export const sessionBusy = (s: NextStepPr['session']) => Boolean(s && s.status === 'RUNNING' && s.activity === 'BUSY');

export function nextStep(pr: NextStepPr): NextStep {
  const base = pr.baseBranch || 'la base';
  if (pr.stage === 'MERGED') return { label: 'Fusionnée', tone: 'done', detail: `Fusionnée dans ${base}. Rien à faire.`, requests: [] };
  if (pr.stage === 'CANCELLED') return { label: 'Annulée', tone: 'done', detail: 'Fermée sans fusion. Rien à faire.', requests: [] };
  const s = pr.session;

  if (pr.stage === 'PENDING') {
    const work = localWorkText(pr) || 'des modifications';
    if (!s) return { label: 'Sans session', tone: 'orphan', detail: `La branche porte ${work}, mais aucune session ne la suit. Vous pouvez créer la pull request vous-même (menu ⋮).`, requests: [] };
    if (sessionBusy(s)) return { label: 'En cours', tone: 'agent', detail: `La session « ${s.name} » travaille sur la branche (${work}). Elle ouvrira la pull request une fois le travail fini ; rien à faire pour l'instant.`, requests: ['open'] };
    return { label: 'À ouvrir', tone: 'you', detail: `La branche porte ${work}, sans pull request. Si le travail est fini, demandez à la session de l'ouvrir.`, requests: ['open'] };
  }

  const conflicting = pr.mergeable === 'CONFLICTING';
  const ciFailing = pr.checksState === 'FAILURE' || pr.checksState === 'ERROR';
  const fixes: PullRequestRequest[] = [...(conflicting ? (['resolveConflicts'] as const) : []), ...(ciFailing ? (['fixCi'] as const) : [])];
  const noSession = s ? '' : ' Aucune session ne suit cette PR : ouvrez son détail technique (menu ⋮) ou la forge.';
  const withSession = (requests: PullRequestRequest[]) => (s ? requests : []);

  if (pr.stage === 'DRAFT') {
    const fix = conflicting ? ` Elle est aussi en conflit avec ${base}.` : ciFailing ? ' Sa CI est en échec.' : '';
    return { label: 'Brouillon', tone: s ? 'agent' : 'orphan', detail: `Ouverte en brouillon : l'agent n'a pas fini ou attend un retour. Voyez avec la session.${fix}${noSession}`, requests: withSession([...fixes, 'close']) };
  }

  // À fusionner : on règle d'abord ce qui bloque.
  if (conflicting) return { label: 'En conflit', tone: s ? 'blocked' : 'orphan', detail: `La branche est en conflit avec ${base} : faites résoudre les conflits avant de fusionner.${noSession}`, requests: withSession([...fixes, 'merge', 'close']) };
  if (ciFailing) return { label: 'CI en échec', tone: s ? 'blocked' : 'orphan', detail: `Les vérifications ont échoué : faites corriger la CI avant de fusionner.${noSession}`, requests: withSession([...fixes, 'merge', 'close']) };
  if (pr.checksState === 'PENDING' || pr.checksState === 'EXPECTED')
    return { label: 'CI en cours', tone: s ? 'wait' : 'orphan', detail: `Les vérifications tournent. Vous pouvez déjà demander la fusion : l'agent attend qu'elles passent, et vous dit si elles échouent.${noSession}`, requests: withSession(['merge', 'close']) };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changements demandés', tone: s ? 'blocked' : 'orphan', detail: `Une revue demande des changements : voyez avec la session avant de fusionner.${noSession}`, requests: withSession(['merge', 'close']) };
  return { label: 'Prête à fusionner', tone: s ? 'you' : 'orphan', detail: `${pr.checksState === 'SUCCESS' ? 'CI verte, sans conflit. ' : 'Sans conflit. '}Relisez-la, puis demandez la fusion à la session.${noSession}`, requests: withSession(['merge', 'close']) };
}

export const REQUEST_LABELS: Record<PullRequestRequest, { label: string; icon: string; hint: string }> = {
  ...ACTION_LABELS,
  merge: { label: 'Fusionner', icon: 'bi-git', hint: "Demande à la session de vérifier puis de fusionner la PR (elle vous demandera votre accord, et fusionnera avec votre compte)" },
  open: { label: 'Ouvrir la PR', icon: 'bi-box-arrow-in-up-right', hint: "Demande à la session de commiter, vérifier et ouvrir la pull request" },
};

/** Phrase de confirmation : ce que la session va faire. */
export function requestSummary(request: PullRequestRequest, pr: NextStepPr): string {
  const ref = prRef(pr);
  switch (request) {
    case 'merge':
      return `vérifier puis fusionner ${ref} dans ${pr.baseBranch || 'la base'} (elle vous demandera votre accord avant la fusion)`;
    case 'resolveConflicts':
      return `résoudre les conflits de ${ref} avec ${pr.baseBranch || 'la base'}, puis pousser (sans fusionner)`;
    case 'fixCi':
      return `lire les vérifications en échec de ${ref}, corriger et pousser (sans fusionner)`;
    case 'close':
      return `fermer ${ref} sans la fusionner (branche et dossier gardés)`;
    case 'open':
      return `commiter, vérifier et ouvrir la pull request de la branche ${pr.headBranch}`;
  }
}

/** Instruction envoyée à la session. `reason` : raison d'une annulation, facultative. */
export function requestInstruction(request: PullRequestRequest, pr: NextStepPr, reason?: string | null): string {
  if (request !== 'open') return pullRequestInstruction(request, pr, reason);
  const task = pr.task ? `en la rattachant à la tâche « ${pr.task.title} » (${pr.task.id})` : 'en la rattachant à la tâche que tu traites (crée-la si besoin)';
  return `Ouvre la pull request de la branche ${pr.headBranch} avec tasks.pr_open, ${task}. Commite d'abord les modifications en cours qui en font partie et vérifie (typecheck, tests). Si le travail n'est pas terminé, dis-moi ce qui reste au lieu d'ouvrir la PR.`;
}

/** État d'une PR ouverte en mots (fiche) : vérifications, conflits, revue. */
export function stateText(pr: Pick<NextStepPr, 'checksState' | 'mergeable' | 'reviewDecision' | 'baseBranch'>): string {
  const parts: string[] = [];
  const ci: Record<string, string> = { SUCCESS: 'CI verte', FAILURE: 'CI en échec', ERROR: 'CI en erreur', PENDING: 'CI en cours', EXPECTED: 'CI attendue' };
  parts.push(pr.checksState ? (ci[pr.checksState] ?? `CI : ${pr.checksState.toLowerCase()}`) : 'pas de CI signalée');
  if (pr.mergeable === 'CONFLICTING') parts.push(`en conflit avec ${pr.baseBranch || 'la base'}`);
  else if (pr.mergeable === 'MERGEABLE') parts.push('sans conflit');
  if (pr.reviewDecision === 'APPROVED') parts.push('revue approuvée');
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') parts.push('changements demandés');
  else if (pr.reviewDecision === 'REVIEW_REQUIRED') parts.push('revue attendue');
  return parts.join(' · ');
}
