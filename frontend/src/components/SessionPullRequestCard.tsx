import { useEffect, useState } from 'react';
import { prRef, type TrackedPullRequestSummary } from '../graphql/pullRequests';
import {
  ACTION_LABELS,
  ACTION_PENDING_LABELS,
  advancePendingAction,
  pendingActionStatus,
  pullRequestCardActions,
  pullRequestCardStatus,
  pullRequestInstruction,
  showsPullRequestCard,
  type PendingCardAction,
  type SessionPullRequestAction,
} from '../lib/sessionPullRequest';
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
// Carte réduite à une ligne : préférence de la personne, commune à toutes les sessions.
const COLLAPSED_KEY = 'skipper.session.prCard.collapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};
// Action en cours, gardée par session pour survivre à un rechargement de la page.
const pendingKey = (sessionId: string) => `skipper.session.prCard.pending.${sessionId}`;
const readPending = (sessionId: string): PendingCardAction | null => {
  try {
    const raw = localStorage.getItem(pendingKey(sessionId));
    return raw ? (JSON.parse(raw) as PendingCardAction) : null;
  } catch {
    return null;
  }
};
const writePending = (sessionId: string, p: PendingCardAction | null) => {
  try {
    if (p) localStorage.setItem(pendingKey(sessionId), JSON.stringify(p));
    else localStorage.removeItem(pendingKey(sessionId));
  } catch {
    /* ignore */
  }
};

/**
 * Carte affichée au-dessus de la saisie d'une session quand la PR suivie de son dossier de travail attend sa fusion :
 * état (CI, conflits, revue), et les actions principales (fusionner, résoudre les conflits, corriger la CI, annuler).
 * Une action n'agit pas elle-même : elle envoie une instruction à la session (`onInstruction`), que l'agent exécute avec
 * ses outils ; la fusion et la fermeture passent par l'autorisation de la personne.
 * Après un clic, la carte montre l'action en cours (bouton animé, ligne d'état, barre de progression) jusqu'à la fin du
 * tour de l'agent (`busy`), demande d'accord comprise (`awaitingApproval`). Elle se réduit à une ligne (chevron) ou
 * s'ignore pour cette PR (croix).
 */
export default function SessionPullRequestCard({
  sessionId,
  projectId,
  pr,
  disabled,
  busy,
  awaitingApproval,
  onInstruction,
}: {
  sessionId: string;
  projectId: string;
  pr: TrackedPullRequestSummary | null | undefined;
  disabled?: boolean;
  busy: boolean;
  awaitingApproval: boolean;
  onInstruction: (text: string) => boolean | Promise<boolean>;
}) {
  const { prompt } = useDialogs();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [pendingState, setPendingState] = useState<PendingCardAction | null>(() => readPending(sessionId));
  const setPending = (p: PendingCardAction | null) => {
    setPendingState(p);
    writePending(sessionId, p);
  };

  // L'action suit l'activité de la session ; une horloge relâche celle dont l'agent ne s'est jamais saisi.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pendingState) return;
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, [pendingState]);
  useEffect(() => {
    if (!pendingState) return;
    const next = advancePendingAction(pendingState, { busy, awaitingApproval, now: Date.now() });
    if (next !== pendingState) setPending(next);
  }, [pendingState, busy, awaitingApproval, now]);

  if (!showsPullRequestCard(pr) || !pr) return null;
  if (dismissed === pr.id || isDismissed(pr.id)) return null;
  const pending = pendingState?.prId === pr.id ? pendingState : null;
  const baseStatus = pullRequestCardStatus(pr);
  const status = pending ? { text: pendingActionStatus(pending.action, awaitingApproval), tone: awaitingApproval ? ('warn' as const) : ('dim' as const) } : baseStatus;
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
    setPending({ prId: pr.id, action, at: Date.now(), sawBusy: false, queued: busy || awaitingApproval });
    const sent = await onInstruction(pullRequestInstruction(action, pr, reason));
    if (!sent) setPending(null);
  };
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const cancelPending = () => setPending(null);
  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(pr.id), '1');
    } catch {
      /* ignore */
    }
    setDismissed(pr.id);
  };

  // Ligne réduite : libellé court de l'action en cours (« Fusion en cours… »), la phrase complète ne tiendrait pas.
  const statusLine = (short = false) => (
    <span className={`cc-pr-card-status ${status.tone}${pending ? ' pending' : ''}`}>
      {pending && !awaitingApproval ? <span className="spinner-border spinner-border-sm cc-pr-card-spin" aria-hidden /> : <span className="cc-pr-card-dot" />}{' '}
      {short && pending ? (awaitingApproval ? 'votre accord attendu' : ACTION_PENDING_LABELS[pending.action]) : status.text}
    </span>
  );
  const ref = target ? (
    <button type="button" className="cc-link" title="Détail de la pull request (checks, revues, fichiers)" onClick={() => setDetails(true)}>
      {prRef(pr)}
    </button>
  ) : (
    <span>{prRef(pr)}</span>
  );
  const tools = (
    <div className="cc-pr-card-tools">
      <button type="button" className="cc-pr-card-tool" title={collapsed ? 'Déplier la carte' : 'Réduire la carte'} aria-label={collapsed ? 'Déplier' : 'Réduire'} aria-expanded={!collapsed} onClick={toggleCollapsed}>
        <i className={`bi ${collapsed ? 'bi-chevron-up' : 'bi-chevron-down'}`} />
      </button>
      <button type="button" className="cc-pr-card-tool" title="Ignorer cette pull request (la carte ne reviendra pas pour elle)" aria-label="Ignorer" onClick={dismiss}>
        <i className="bi bi-x-lg" />
      </button>
    </div>
  );

  return (
    <div className={`cc-pr-card${collapsed ? ' collapsed' : ''}${pending ? ' pending' : ''}`} role="region" aria-label={`Pull request ${prRef(pr)} à fusionner`} aria-busy={Boolean(pending)}>
      {collapsed ? (
        <div className="cc-pr-card-head cc-pr-card-line">
          <i className="bi bi-git cc-pr-card-icon" />
          <div className="cc-pr-card-main cc-pr-card-line-main" onClick={toggleCollapsed} title="Déplier la carte">
            <span className="cc-pr-card-line-ref">{prRef(pr)}</span>
            <span className="cc-pr-card-line-title">{pr.title}</span>
            {statusLine(true)}
          </div>
          {tools}
        </div>
      ) : (
        <>
          <div className="cc-pr-card-head">
            <i className="bi bi-git cc-pr-card-icon" />
            <div className="cc-pr-card-main">
              <div className="cc-pr-card-title">
                <span className="cc-pr-card-kicker">Pull request à fusionner</span>
                {ref}
                {pr.url && (
                  <a href={pr.url} target="_blank" rel="noreferrer" className="cc-pr-card-ext" title="Ouvrir sur la forge" aria-label="Ouvrir sur la forge">
                    <i className="bi bi-box-arrow-up-right" />
                  </a>
                )}
              </div>
              <div className="cc-pr-card-name" title={pr.title}>{pr.title}</div>
              <div className="cc-pr-card-meta">
                {statusLine()}
                {review && !pending && <span className={pr.reviewDecision === 'APPROVED' ? 'cc-green' : 'cc-yellow'}> · revue : {review}</span>}
                <span className="cc-pr-card-branches"> · {pr.headBranch} → {pr.baseBranch}</span>
              </div>
            </div>
            {tools}
          </div>
          <div className="cc-pr-card-actions">
            {actions.map((a, i) =>
              pending && pending.action === a ? (
                <button key={a} type="button" className={`cc-btn${i === 0 ? ' primary' : ''}${a === 'close' ? ' danger' : ''} is-pending`} disabled aria-live="polite">
                  <span className="spinner-border spinner-border-sm" aria-hidden /> {ACTION_PENDING_LABELS[a]}
                </button>
              ) : (
                <button key={a} type="button" className={`cc-btn${i === 0 ? ' primary' : ''}${a === 'close' ? ' danger' : ''}`} title={ACTION_LABELS[a].hint} disabled={disabled || Boolean(pending)} onClick={() => void run(a)}>
                  <i className={`bi ${ACTION_LABELS[a].icon}`} /> {ACTION_LABELS[a].label}
                </button>
              ),
            )}
            {pending && !busy && !awaitingApproval && now - pending.at > 15_000 && (
              <button type="button" className="cc-link cc-pr-card-reset" title="Ne plus afficher l'action comme en cours" onClick={cancelPending}>
                Réactiver les boutons
              </button>
            )}
          </div>
        </>
      )}
      {pending && <div className="cc-pr-card-progress" aria-hidden />}
      {details && target && <PullRequestWindow projectId={projectId} window={target} onClose={() => setDetails(false)} />}
    </div>
  );
}
