import { useMutation } from '@apollo/client';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { END_SESSION, HAND_BACK_SESSION, INTERRUPT_SESSION, TAKE_OVER_SESSION, RESUME_SESSION, RUN_SESSION_SCHEDULE_NOW, STOP_SESSION, type ChildSession, type Session } from '../graphql/operations';
import { UNARCHIVE_SESSION } from '../graphql/sessions';
import { sessionStateHint, sessionStatusLabels } from '../lib/humanize';
import { sessionDotClass } from '../workbench/WorkspaceTabs';
import { useDeletions } from '../workbench/useDeletions';
import { useDialogs } from './Dialogs';
import RelaunchModal from './RelaunchModal';
import ResumeSessionModal from './ResumeSessionModal';
import ScheduleModal from './ScheduleModal';
import SessionSettingsModal from './SessionSettingsModal';
import ShareSessionModal from './ShareSessionModal';

/** Session telle que la requête `Session` la renvoie : le détail suffit aux actions et aux sous-agents. */
export type ControlledSession = Session & { childSessions: ChildSession[] };

/** Lecteur du projet (rôle viewer) : il lit la session, sans saisie ni action (le serveur les refuse de toute façon). */
export const isReadOnlySession = (session: Pick<Session, 'project'> | null | undefined): boolean => session?.project.myRole === 'VIEWER';

/**
 * Actions d'une session (réglages, planification, interrompre, terminer, arrêter, relancer, archiver…) et les
 * modales qu'elles ouvrent, partagées entre l'en-tête déplié de la page de session et l'onglet « Session » du
 * panneau de droite. Le hook accepte une session absente (page en cours de chargement) : il ne rend alors rien.
 */
export function useSessionActions(session: ControlledSession | null | undefined): { buttons: ReactNode; modals: ReactNode; readOnly: boolean; openSettings: () => void; openContextSettings: () => void; openSchedule: () => void } {
  const { confirm, showError } = useDialogs();
  const onError = (err: Error) => void showError(err);
  const [takeOverSession, { loading: takingOver }] = useMutation(TAKE_OVER_SESSION, { onError });
  const [handBackSession, { loading: handingBack }] = useMutation(HAND_BACK_SESSION, { onError });
  const [interruptSession] = useMutation(INTERRUPT_SESSION, { onError });
  const [resumeSession, { loading: resuming }] = useMutation(RESUME_SESSION, { onError });
  const [endSession] = useMutation(END_SESSION, { onError });
  const [stopSession] = useMutation(STOP_SESSION, { onError });
  const [runScheduleNow] = useMutation(RUN_SESSION_SCHEDULE_NOW, { onError });
  const [unarchiveSession] = useMutation(UNARCHIVE_SESSION, { refetchQueries: ['Sidebar'], onError });
  const { archiveSession, deleteSession } = useDeletions();
  const [scheduling, setScheduling] = useState(false);
  // Réglages ouverts, et sur quelle partie : la jauge de contexte les ouvre sur « Conversation de l'agent ».
  const [settingsOpen, setSettingsOpen] = useState<false | 'all' | 'context'>(false);
  const [relaunching, setRelaunching] = useState(false);
  const [resumingWith, setResumingWith] = useState(false);
  const [sharing, setSharing] = useState(false);
  const readOnly = isReadOnlySession(session);
  const noop = () => undefined;
  const openSettings = () => setSettingsOpen('all');
  const openContextSettings = () => setSettingsOpen('context');
  const openSchedule = () => setScheduling(true);
  if (!session) return { buttons: null, modals: null, readOnly, openSettings, openContextSettings, openSchedule };
  // Lecteur : ni boutons ni modales ; la jauge de contexte et la planification ne s'ouvrent pas.
  if (readOnly) return { buttons: null, modals: null, readOnly, openSettings: noop, openContextSettings: noop, openSchedule: noop };

  const id = session.id;
  const archived = Boolean(session.archivedAt);
  const running = session.status === 'RUNNING';
  const busy = running && session.activity === 'BUSY';
  const schedule = session.schedule;
  // Chat (espace personnel) : pas de planification, et pas d'archive — on le supprime directement.
  const chat = session.kind === 'CHAT';
  // Session arrêtée (ou archivée) dont le dossier existe encore : « Reprendre » renvoie un message dans sa conversation.
  const stopped = archived ? session.status !== 'RUNNING' && session.status !== 'QUEUED' : session.status === 'COMPLETED' || session.status === 'FAILED' || session.status === 'STOPPED';
  const resumable = stopped && (chat || Boolean(session.worksession));
  // Session d'un agent : une personne autorisée (demandeur, gestionnaire, administrateur) la continue avec ses comptes.
  const agentName = session.agent?.name ?? "l'agent";
  const takeOver = async () => {
    const ok = await confirm({
      title: 'Prendre la main',
      message: `La session continue (même conversation, toujours au nom de ${agentName}) avec vos comptes et vos droits : votre abonnement Claude, vos comptes GitHub et GitLab en écriture (push, pull requests), vos éléments du coffre. Vos instructions priment sur les règles du rôle de ${agentName}.${running ? " Le tour en cours se termine d'abord ; votre prochaine instruction relance la session avec vos comptes." : ''} Vous pourrez rendre la main à tout moment.`,
      confirmLabel: 'Prendre la main',
    });
    if (ok) void takeOverSession({ variables: { id } });
  };
  const buttons = (
    <>
      <button type="button" className="cc-btn" title="Nom de la session et nettoyage automatique de l'historique" onClick={openSettings}>
        <i className="bi bi-gear" /> Réglages
      </button>
      {session.viewerCanTakeOver && !archived && (session.takenOverBy ? (
        <button type="button" className="cc-btn" disabled={handingBack} title={`${session.takenOverBy.name} a la main : la session tourne avec ses comptes. La rendre à ${agentName}, qui reprend les siens`} onClick={() => void handBackSession({ variables: { id } })}>
          <i className="bi bi-person-dash" /> Rendre la main
        </button>
      ) : (
        <button type="button" className="cc-btn" disabled={takingOver} title={`Continuer cette session avec vos comptes et vos droits au lieu de ceux de ${agentName}`} onClick={() => void takeOver()}>
          <i className="bi bi-person-check" /> Prendre la main
        </button>
      ))}
      {!chat && (
        <button type="button" className="cc-btn" title={schedule ? 'Modifier la planification de cette session' : 'Relancer cette session à intervalles réguliers avec une instruction'} onClick={openSchedule}>
          <i className="bi bi-alarm" /> {schedule ? (schedule.enabled ? 'Planification' : 'Planification (en pause)') : 'Planifier'}
        </button>
      )}
      {schedule && !busy && (
        <button type="button" className="cc-btn" title="Exécute la planification maintenant, sans attendre l'échéance" onClick={() => runScheduleNow({ variables: { id } })}>
          Exécuter maintenant
        </button>
      )}
      {resumable && (
        <button type="button" className="cc-btn accent" title="Envoie un message dans la conversation de cette session, qui reprend là où elle s’était arrêtée" onClick={() => setResumingWith(true)}>
          <i className="bi bi-play-fill" /> Reprendre
        </button>
      )}
      {session.status === 'INTERRUPTED' && !archived && (
        <button
          type="button"
          className="cc-btn accent"
          disabled={resuming}
          title={session.activity === 'BUSY' ? "L'agent reprend le travail coupé par le redémarrage du serveur" : "Rend la session reprenable sans lancer de tour (rien n'est facturé) : votre prochain message la relance"}
          onClick={() => resumeSession({ variables: { id } })}
        >
          <i className="bi bi-play-fill" /> Reprendre
        </button>
      )}
      {session.status === 'QUEUED' && (
        <button type="button" className="cc-btn danger" title="La session ne démarrera pas ; un message la remettra en file si la limite est encore atteinte" onClick={() => stopSession({ variables: { id } })}>
          Retirer de la file
        </button>
      )}
      {busy && (
        <button type="button" className="cc-btn" title="Arrête ce que l'agent est en train de faire ; la session reste ouverte" onClick={() => interruptSession({ variables: { id } })}>
          Interrompre
        </button>
      )}
      {running && (
        <button type="button" className="cc-btn accent" title="L'agent finit ce qu'il fait, puis la session se termine" onClick={() => endSession({ variables: { id } })}>
          Terminer la session
        </button>
      )}
      {running && (
        <button type="button" className="cc-btn danger" title="Arrêt immédiat, sans attendre" onClick={() => stopSession({ variables: { id } })}>
          Arrêter
        </button>
      )}
      <button type="button" className="cc-btn" title="Lien public de lecture du transcript, sans connexion, à durée limitée et révocable" onClick={() => setSharing(true)}>
        <i className="bi bi-share" /> Partager{session.shares?.length ? ` (${session.shares.length})` : ''}
      </button>
      <button type="button" className="cc-btn" title="Repart d'une nouvelle session (nouveau nom) avec un résumé de celle-ci ; pour continuer la même conversation, utilisez « Reprendre » ou écrivez un message" onClick={() => setRelaunching(true)}>
        <i className="bi bi-arrow-repeat" /> Relancer
      </button>
      {archived || chat ? (
        <>
          {archived && (
            <button type="button" className="cc-btn accent" title="Remet la session parmi les sessions actives" onClick={() => unarchiveSession({ variables: { id } })}>
              Restaurer
            </button>
          )}
          <button type="button" className="cc-btn danger" onClick={() => void deleteSession({ id, name: session.name, branch: session.worksession?.branch ?? null })}>
            Supprimer
          </button>
        </>
      ) : (
        <button type="button" className="cc-btn" title="La session quitte la barre latérale ; elle reste consultable et relançable depuis l'historique du projet" onClick={() => void archiveSession({ id, name: session.name })}>
          <i className="bi bi-archive" /> Archiver
        </button>
      )}
    </>
  );
  const modals = (
    <>
      {scheduling && <ScheduleModal session={session} onClose={() => setScheduling(false)} />}
      {settingsOpen && <SessionSettingsModal session={session} focus={settingsOpen === 'context' ? 'context' : undefined} onClose={() => setSettingsOpen(false)} />}
      {resumingWith && (
        <ResumeSessionModal
          session={session}
          onRelaunch={() => {
            setResumingWith(false);
            setRelaunching(true);
          }}
          onClose={() => setResumingWith(false)}
        />
      )}
      {relaunching && <RelaunchModal session={session} projectName={session.project.name} onClose={() => setRelaunching(false)} />}
      {sharing && <ShareSessionModal session={session} onClose={() => setSharing(false)} />}
    </>
  );
  return { buttons, modals, readOnly, openSettings, openContextSettings, openSchedule };
}

/** Phrase d'état de la session parente (« travaille », « terminée »…), pour la note de sous-agent. */
export function parentStateHint(parent: NonNullable<Session['parentSession']>): string | null {
  return sessionStateHint(parent.status, parent.activity, 0) ?? sessionStatusLabels[parent.status]?.toLowerCase() ?? null;
}

/** Note « sous-agent » : la session a été lancée par l'agent d'une autre session, pas par une personne. */
export function SessionParentNote({ session, compact = false }: { session: Session; compact?: boolean }) {
  const parent = session.parentSession;
  if (!parent) return null;
  const hint = parentStateHint(parent);
  return (
    <div className={`cc-subagent${compact ? ' compact' : ''}`}>
      <i className="bi bi-robot cc-subagent-icon" />
      <span className="cc-subagent-text">
        <strong>Sous-agent</strong> · cette session a été lancée par l'agent de la session <Link to={`/sessions/${parent.id}`}>« {parent.name} »</Link>
        {hint && <span className="cc-dim"> ({hint})</span>}, pas par une personne.
      </span>
      {!compact && (
        <Link to={`/sessions/${parent.id}`} className="cc-btn" title="Ouvrir la session parente">
          <i className="bi bi-box-arrow-up-left" /> Session parente
        </Link>
      )}
    </div>
  );
}

/** Sous-agents de la session : une puce par session lancée par son agent, avec de quoi la terminer. */
export function SessionChildren({ children, stacked = false }: { children: ChildSession[]; stacked?: boolean }) {
  const { showError } = useDialogs();
  const onError = (err: Error) => void showError(err);
  const [endSession] = useMutation(END_SESSION, { onError });
  const [stopSession] = useMutation(STOP_SESSION, { onError });
  if (children.length === 0) return null;
  return (
    <div className={`cc-children${stacked ? ' stacked' : ''}`} title="Sous-agents : sessions lancées par l'agent de cette session (outil sessions.create)">
      {!stacked && (
        <span className="cc-children-title">
          <i className="bi bi-robot" /> {children.length > 1 ? `${children.length} sous-agents` : '1 sous-agent'}
        </span>
      )}
      {children.map((c) => {
        const hint = sessionStateHint(c.status, c.activity, c.pendingRequestCount) ?? (c.archivedAt ? 'archivée' : sessionStatusLabels[c.status]?.toLowerCase());
        return (
          <span key={c.id} className="cc-child">
            <span className={`wb-dot ${sessionDotClass(c)}`} />
            <Link to={`/sessions/${c.id}`} className="cc-child-name" title={`Ouvrir « ${c.name} »`}>
              {c.name}
            </Link>
            {hint && <span className="cc-dimmer">{hint}</span>}
            {c.status === 'RUNNING' && (
              <button type="button" className="cc-link" title="L'agent de cette session finit ce qu'il fait, puis elle se termine" onClick={() => endSession({ variables: { id: c.id } })}>
                terminer
              </button>
            )}
            {c.status === 'QUEUED' && (
              <button type="button" className="cc-link" title="La session ne démarrera pas" onClick={() => stopSession({ variables: { id: c.id } })}>
                retirer de la file
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
