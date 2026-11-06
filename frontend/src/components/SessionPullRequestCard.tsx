import { useState } from 'react';
import { prRef, type TrackedPullRequestSummary } from '../graphql/pullRequests';
import { ACTION_LABELS, pullRequestCardActions, pullRequestCardStatus, pullRequestInstruction, showsPullRequestCard, type SessionPullRequestAction } from '../lib/sessionPullRequest';
import { useDialogs } from './Dialogs';
import { PullRequestWindow, windowFor } from './TrackedPullRequests';

const dismissKey = (id: string) => `skipper.session.prCard.dismissed.${id}`;
const isDismissed = (id: string) => {
  try {
    return localStorage.getItem(dismissKey(id)) === '1';
  } catch {
    return false;
  }
};

/**
 * Carte affichée au-dessus de la saisie d'une session quand la PR suivie de son dossier de travail attend sa fusion :
 * état (CI, conflits, revue), et les actions principales (fusionner, résoudre les conflits, corriger la CI, annuler).
 * Une action n'agit pas elle-même : elle envoie une instruction à la session (`onInstruction`), que l'agent exécute avec
 * ses outils ; la fusion et la fermeture passent par l'autorisation de la personne.
 */
export default function SessionPullRequestCard({ projectId, pr, disabled, onInstruction }: { projectId: string; pr: TrackedPullRequestSummary | null | undefined; disabled?: boolean; onInstruction: (text: string) => void | Promise<void> }) {
  const { prompt } = useDialogs();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  if (!showsPullRequestCard(pr) || !pr) return null;
  if (dismissed === pr.id || isDismissed(pr.id)) return null;
  const status = pullRequestCardStatus(pr);
  const actions = pullRequestCardActions(pr);
  const target = windowFor(pr);
  const review = pr.reviewDecision === 'APPROVED' ? 'approuvée' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changements demandés' : null;

  const run = async (action: SessionPullRequestAction) => {
    let reason: string | null = null;
    if (action === 'close') {
      reason = await prompt({
        title: `Annuler la pull request ${prRef(pr)}`,
        message: "L'agent fermera la PR sans la fusionner (la branche et le dossier de travail sont gardés, elle reste réouvrable). Raison, postée en commentaire sur la PR (facultative) :",
        placeholder: 'Remplacée par…, plus nécessaire…',
        confirmLabel: 'Fermer la PR',
        required: false,
      });
      if (reason === null) return;
    }
    await onInstruction(pullRequestInstruction(action, pr, reason));
  };
  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(pr.id), '1');
    } catch {
      /* ignore */
    }
    setDismissed(pr.id);
  };

  return (
    <div className="cc-pr-card" role="region" aria-label={`Pull request ${prRef(pr)} à fusionner`}>
      <div className="cc-pr-card-head">
        <i className="bi bi-git cc-pr-card-icon" />
        <div className="cc-pr-card-main">
          <div className="cc-pr-card-title">
            <span className="cc-pr-card-kicker">Pull request à fusionner</span>
            {target ? (
              <button type="button" className="cc-link" title="Détail de la pull request (checks, revues, fichiers)" onClick={() => setDetails(true)}>
                {prRef(pr)}
              </button>
            ) : (
              <span>{prRef(pr)}</span>
            )}
            {pr.url && (
              <a href={pr.url} target="_blank" rel="noreferrer" className="cc-pr-card-ext" title="Ouvrir sur la forge" aria-label="Ouvrir sur la forge">
                <i className="bi bi-box-arrow-up-right" />
              </a>
            )}
          </div>
          <div className="cc-pr-card-name" title={pr.title}>{pr.title}</div>
          <div className="cc-pr-card-meta">
            <span className={`cc-pr-card-status ${status.tone}`}>
              <span className="cc-pr-card-dot" /> {status.text}
            </span>
            {review && <span className={pr.reviewDecision === 'APPROVED' ? 'cc-green' : 'cc-yellow'}> · revue : {review}</span>}
            <span className="cc-pr-card-branches"> · {pr.headBranch} → {pr.baseBranch}</span>
          </div>
        </div>
        <button type="button" className="cc-pr-card-close" title="Masquer cette carte (pour cette pull request)" aria-label="Masquer" onClick={dismiss}>
          <i className="bi bi-x-lg" />
        </button>
      </div>
      <div className="cc-pr-card-actions">
        {actions.map((a, i) => (
          <button key={a} type="button" className={`cc-btn${i === 0 ? ' primary' : ''}${a === 'close' ? ' danger' : ''}`} title={ACTION_LABELS[a].hint} disabled={disabled} onClick={() => void run(a)}>
            <i className={`bi ${ACTION_LABELS[a].icon}`} /> {ACTION_LABELS[a].label}
          </button>
        ))}
      </div>
      {details && target && <PullRequestWindow projectId={projectId} window={target} onClose={() => setDetails(false)} />}
    </div>
  );
}
