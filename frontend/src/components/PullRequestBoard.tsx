import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Modal } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { SEND_SESSION_MESSAGE } from '../graphql/operations';
import { forgeOfUrl, localWorkText, prRef, type TrackedPullRequest } from '../graphql/pullRequests';
import { timeAgo } from '../lib/humanize';
import { nextStep, REQUEST_LABELS, requestInstruction, requestSummary, sessionBusy, stateText, type NextStep, type PullRequestRequest } from '../lib/pullRequestNextStep';
import { useDialogs } from './Dialogs';
import { PullRequestStageBadge, PullRequestWindow, TrackedPullRequestIndicators, TrackedPullRequestMenu, windowFor } from './TrackedPullRequests';

/**
 * Liste des pull requests de la page d'un projet, et fiche d'une PR. Chaque ligne dit ce qui est attendu (`nextStep`) ;
 * un clic ouvre la fiche (description, état, tâche et session, demandes possibles), pas la forge. Les boutons
 * n'agissent pas eux-mêmes : ils envoient une instruction à la session qui suit la PR (`sendSessionMessage`), qui la
 * réalise avec ses outils (fusion avec l'accord de la personne). Le détail technique (checks, fichiers, fusion directe)
 * reste accessible depuis le menu « ⋮ » et la fiche.
 */

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Demande envoyée depuis la page, gardée le temps que la PR change d'étape (au plus 15 min). */
export type SentRequest = { request: PullRequestRequest; at: number; stage: string; sessionName: string };
const SENT_MAX_MS = 15 * 60_000;
export const activeSent = (pr: TrackedPullRequest, sent: Record<string, SentRequest>) => {
  const s = sent[pr.id];
  return s && s.stage === pr.stage && Date.now() - s.at < SENT_MAX_MS ? s : null;
};

function sessionState(s: NonNullable<TrackedPullRequest['session']>): string {
  if (sessionBusy(s)) return 'au travail';
  if (s.status === 'RUNNING') return 'en attente d’une instruction';
  if (s.status === 'QUEUED' || s.status === 'PENDING') return 'en file d’attente';
  return 'arrêtée (une demande la relance)';
}

/** Envoie une demande à la session qui suit la PR, après confirmation (raison facultative pour une annulation). */
export function useSendPullRequestRequest() {
  const { confirm, prompt, showError } = useDialogs();
  const navigate = useNavigate();
  const [send] = useMutation(SEND_SESSION_MESSAGE, { refetchQueries: ['Sidebar'] });
  return async (pr: TrackedPullRequest, request: PullRequestRequest): Promise<boolean> => {
    const s = pr.session;
    if (!s) return false;
    const later = sessionBusy(s) ? ' Elle travaille en ce moment : la demande passera à la fin de son tour.' : s.status === 'RUNNING' ? '' : ' Elle est arrêtée : la demande la relance.';
    let reason: string | null = null;
    let openSession = false;
    if (request === 'close') {
      reason = await prompt({
        title: `Annuler la pull request ${prRef(pr)}`,
        message: `La session « ${s.name} » fermera la PR sans la fusionner (branche et dossier gardés, elle reste réouvrable).${later} Raison, postée en commentaire sur la PR (facultative) :`,
        placeholder: 'Remplacée par…, plus nécessaire…',
        confirmLabel: 'Envoyer la demande',
        required: false,
      });
      if (reason === null) return false;
    } else {
      const answer = await confirm({
        title: `${REQUEST_LABELS[request].label} · ${prRef(pr)}`,
        message: `Demander à la session « ${s.name} » de ${requestSummary(request, pr)} ?${later}`,
        confirmLabel: 'Envoyer la demande',
        checkbox: { label: 'Ouvrir la session pour suivre', defaultChecked: false },
      });
      if (!answer) return false;
      openSession = answer.checked;
    }
    try {
      await send({ variables: { id: s.id, text: requestInstruction(request, pr, reason) } });
    } catch (err) {
      void showError(err);
      return false;
    }
    if (openSession) navigate(`/sessions/${s.id}`);
    return true;
  };
}

function StepLine({ step }: { step: NextStep }) {
  return (
    <div className="prq-next">
      <span className={`prq-step prq-tone-${step.tone}`}>{step.label}</span>
      <span className="prq-detail">{step.detail}</span>
    </div>
  );
}

function when(pr: TrackedPullRequest): { label: string; at: string } {
  if (pr.status === 'PENDING') return { label: 'modifiée depuis', at: pr.openedAt };
  if (pr.mergedAt) return { label: 'fusionnée', at: pr.mergedAt };
  if (pr.closedAt) return { label: 'fermée', at: pr.closedAt };
  return { label: 'ouverte', at: pr.openedAt };
}

/** Une ligne : référence et titre, tâche, session, branche ; ce qui est attendu ; la demande principale et le menu. */
function PullRequestRow({ pr, canWrite, sent, onOpen, onTechnical, onRequest }: { pr: TrackedPullRequest; canWrite: boolean; sent: SentRequest | null; onOpen: () => void; onTechnical: () => void; onRequest: (r: PullRequestRequest) => void }) {
  const step = nextStep(pr);
  const w = when(pr);
  const primary = step.requests[0];
  const finished = step.tone === 'done';
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <li className={`prq-row${finished ? ' prq-row-done' : ''}`}>
      <button type="button" className="prq-open" onClick={onOpen} aria-label={`Fiche de la pull request ${prRef(pr)} ${pr.title}`} />
      <div className="prq-main">
        <div className="prq-title">
          <PullRequestStageBadge stage={pr.stage} />
          <span className="prq-ref">{pr.number != null ? prRef(pr) : <i className="bi bi-code-slash" title="Pas encore ouverte sur la forge" />}</span>
          <span className="prq-name">{pr.title}</span>
          {pr.status === 'OPEN' && <TrackedPullRequestIndicators pr={pr} />}
        </div>
        <div className="prq-meta">
          {pr.task && (
            <Link to={`/tasks/${pr.task.id}`} onClick={stop} title={`Tâche : ${pr.task.title}`} className="prq-meta-item">
              <i className="bi bi-check2-square" /> {pr.task.title}
            </Link>
          )}
          {pr.session && (
            <Link to={`/sessions/${pr.session.id}`} onClick={stop} title={`Session ${sessionState(pr.session)}`} className="prq-meta-item">
              <i className={`bi bi-terminal${sessionBusy(pr.session) ? ' cc-green' : ''}`} /> {pr.session.name}
            </Link>
          )}
          <span className="prq-meta-item font-monospace d-none d-md-inline" title={`${pr.headBranch} → ${pr.baseBranch}`}>
            {pr.foreignRepo ? `${pr.repo} · ` : ''}
            {pr.headBranch}
          </span>
          <span className="prq-meta-item" title={fmt(w.at)}>
            {w.label} {timeAgo(w.at)}
          </span>
        </div>
        {pr.note && (
          <div className="prq-note" title={pr.note}>
            <i className="bi bi-sticky me-1" />
            {pr.note}
          </div>
        )}
        {!finished && <StepLine step={step} />}
      </div>
      <div className="prq-side">
        {canWrite && sent ? (
          <span className="prq-sent" title={`Demande envoyée à la session « ${sent.sessionName} » ${timeAgo(new Date(sent.at).toISOString())}`}>
            <i className="bi bi-send-check" /> Demandé
          </span>
        ) : (
          canWrite &&
          primary && (
            <Button size="sm" variant={step.tone === 'you' || step.tone === 'blocked' ? 'primary' : 'outline-secondary'} title={REQUEST_LABELS[primary].hint} onClick={() => onRequest(primary)}>
              <i className={`bi ${REQUEST_LABELS[primary].icon} me-1`} />
              {REQUEST_LABELS[primary].label}
            </Button>
          )
        )}
        {canWrite && <TrackedPullRequestMenu pr={pr} onOpen={onTechnical} />}
      </div>
    </li>
  );
}

/** Liste de PR (une section de la page). La fiche, le détail technique et les demandes envoyées sont tenus par la page. */
export function PullRequestList({ prs, canWrite, sent, onOpen, onTechnical, onRequest }: { prs: TrackedPullRequest[]; canWrite: boolean; sent: Record<string, SentRequest>; onOpen: (pr: TrackedPullRequest) => void; onTechnical: (pr: TrackedPullRequest) => void; onRequest: (pr: TrackedPullRequest, r: PullRequestRequest) => void }) {
  return (
    <ul className="prq-list">
      {prs.map((pr) => (
        <PullRequestRow key={pr.id} pr={pr} canWrite={canWrite} sent={activeSent(pr, sent)} onOpen={() => onOpen(pr)} onTechnical={() => onTechnical(pr)} onRequest={(r) => onRequest(pr, r)} />
      ))}
    </ul>
  );
}

/** Fiche d'une PR : ce qui est attendu, les demandes à la session, et ce qu'on sait de la PR. */
export function PullRequestSheet({ pr, canWrite, sent, onRequest, onTechnical, onClose }: { pr: TrackedPullRequest; canWrite: boolean; sent: SentRequest | null; onRequest: (r: PullRequestRequest) => void; onTechnical: () => void; onClose: () => void }) {
  const step = nextStep(pr);
  const w = when(pr);
  const technical = windowFor(pr);
  const work = localWorkText(pr);
  const by = pr.createdBySession ? (
    <Link to={`/sessions/${pr.createdBySession.id}`} onClick={onClose}>
      {pr.createdBySession.name}
    </Link>
  ) : pr.createdBy ? (
    pr.createdBy.name
  ) : pr.createdByType === 'system' ? (
    <span className="text-secondary">{pr.status === 'PENDING' ? 'détectée sur la branche' : 'adoptée par la synchronisation'}</span>
  ) : null;
  return (
    <Modal show onHide={onClose} centered size="lg" className="prq-sheet">
      <Modal.Header closeButton>
        <Modal.Title className="h6 d-flex align-items-center gap-2 flex-wrap">
          <PullRequestStageBadge stage={pr.stage} />
          <span className="text-secondary">{prRef(pr)}</span>
          <span>{pr.title}</span>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <section className={`prq-callout prq-callout-${step.tone}`}>
          <div className="prq-callout-kicker">{step.tone === 'done' ? 'Terminée' : 'Ce qui est attendu'}</div>
          <div className="prq-callout-label">{step.label}</div>
          <div className="prq-callout-detail">{step.detail}</div>
          {canWrite && sent && (
            <Alert variant="success" className="py-2 small mt-2 mb-0">
              <i className="bi bi-send-check me-1" />
              {REQUEST_LABELS[sent.request].label} : demande envoyée à la session « {sent.sessionName} » {timeAgo(new Date(sent.at).toISOString())}.{' '}
              {pr.session && (
                <Link to={`/sessions/${pr.session.id}`} onClick={onClose}>
                  Suivre dans la session
                </Link>
              )}
            </Alert>
          )}
          {canWrite && step.requests.length > 0 && pr.session && (
            <>
              <div className="prq-callout-actions">
                {step.requests.map((r, i) => (
                  <Button key={r} size="sm" variant={i === 0 ? 'primary' : r === 'close' ? 'outline-danger' : 'outline-secondary'} title={REQUEST_LABELS[r].hint} onClick={() => onRequest(r)}>
                    <i className={`bi ${REQUEST_LABELS[r].icon} me-1`} />
                    {REQUEST_LABELS[r].label}
                  </Button>
                ))}
              </div>
              <div className="prq-callout-hint">
                Chaque bouton envoie la demande à la session « {pr.session.name} », qui s'en charge avec ses outils et rend compte dans sa conversation.
              </div>
            </>
          )}
        </section>

        <dl className="prq-facts">
          <dt>Tâche</dt>
          <dd>
            {pr.task ? (
              <Link to={`/tasks/${pr.task.id}`} onClick={onClose}>
                {pr.task.title}
              </Link>
            ) : (
              <span className="text-secondary">aucune</span>
            )}
          </dd>
          <dt>Session</dt>
          <dd>
            {pr.session ? (
              <>
                <Link to={`/sessions/${pr.session.id}`} onClick={onClose}>
                  {pr.session.name}
                </Link>{' '}
                <span className="text-secondary">· {sessionState(pr.session)}</span>
              </>
            ) : (
              <span className="text-secondary">aucune session ne suit cette branche</span>
            )}
          </dd>
          <dt>Branche</dt>
          <dd className="font-monospace small">
            {pr.foreignRepo && <span className="text-secondary">{pr.repo} · </span>}
            {pr.headBranch}
            {pr.baseBranch && <span className="text-secondary"> → {pr.baseBranch}</span>}
          </dd>
          {pr.status === 'OPEN' && (
            <>
              <dt>État</dt>
              <dd>
                <TrackedPullRequestIndicators pr={pr} /> {stateText(pr)}
              </dd>
            </>
          )}
          {pr.status === 'PENDING' && (
            <>
              <dt>Travail</dt>
              <dd>{work || 'modifications sur la branche'}, pas encore de pull request</dd>
            </>
          )}
          {pr.note && (
            <>
              <dt>Note</dt>
              <dd>{pr.note}</dd>
            </>
          )}
          <dt>{w.label[0].toUpperCase() + w.label.slice(1)}</dt>
          <dd>
            {fmt(w.at)} <span className="text-secondary">({timeAgo(w.at)})</span>
            {by && <> · par {by}</>}
          </dd>
        </dl>
      </Modal.Body>
      <Modal.Footer className="justify-content-between">
        <div className="d-flex gap-2 flex-wrap">
          {technical && canWrite && (
            <Button size="sm" variant="link" className="px-0" onClick={onTechnical} title={pr.status === 'PENDING' ? 'Ouvrir la fenêtre de création de la PR, sans passer par la session' : 'Checks, fichiers modifiés, revues ; fusion directe sans passer par la session'}>
              {pr.status === 'PENDING' ? 'Créer la PR moi-même' : 'Détail technique'}
            </Button>
          )}
          {pr.url && (
            <a className="btn btn-link btn-sm px-0" href={pr.url} target="_blank" rel="noreferrer">
              Voir sur {forgeOfUrl(pr.url)} <i className="bi bi-box-arrow-up-right" />
            </a>
          )}
        </div>
        <div className="d-flex gap-2">
          {pr.session && (
            <Link to={`/sessions/${pr.session.id}`} className="btn btn-sm btn-outline-secondary" onClick={onClose}>
              <i className="bi bi-terminal me-1" /> Ouvrir la session
            </Link>
          )}
          <Button size="sm" variant="secondary" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * État commun de la page : fiche ouverte (relue dans `prs` à chaque rafraîchissement), détail technique ouvert,
 * demandes envoyées. Rend les fenêtres ; la page place les listes.
 */
export function usePullRequestBoard(prs: TrackedPullRequest[], canWrite: boolean) {
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [technical, setTechnical] = useState<TrackedPullRequest | null>(null);
  const [sent, setSent] = useState<Record<string, SentRequest>>({});
  const sendRequest = useSendPullRequestRequest();
  const sheet = sheetId ? (prs.find((p) => p.id === sheetId) ?? null) : null;
  const request = async (pr: TrackedPullRequest, r: PullRequestRequest) => {
    if (await sendRequest(pr, r)) setSent((m) => ({ ...m, [pr.id]: { request: r, at: Date.now(), stage: pr.stage, sessionName: pr.session?.name ?? '' } }));
  };
  const openTechnical = (pr: TrackedPullRequest) => {
    setSheetId(null);
    setTechnical(pr);
  };
  const technicalWindow = technical ? windowFor(technical) : null;
  const windows = (
    <>
      {sheet && <PullRequestSheet pr={sheet} canWrite={canWrite} sent={activeSent(sheet, sent)} onRequest={(r) => void request(sheet, r)} onTechnical={() => openTechnical(sheet)} onClose={() => setSheetId(null)} />}
      {technical && technicalWindow && <PullRequestWindow projectId={technical.project.id} window={technicalWindow} full={technical} onClose={() => setTechnical(null)} />}
    </>
  );
  return { sent, open: (pr: TrackedPullRequest) => setSheetId(pr.id), openTechnical, request, windows };
}
