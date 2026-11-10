import { useMutation, useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Form } from 'react-bootstrap';
import { useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import { PullRequestList, usePullRequestBoard } from '../components/PullRequestBoard';
import { RegisterPullRequestModal } from '../components/TrackedPullRequests';
import { prRef, PULL_REQUESTS, PULL_REQUESTS_PROJECT, SYNC_PULL_REQUESTS, type TrackedPullRequest } from '../graphql/pullRequests';
import { nextStep, type NextStepTone } from '../lib/pullRequestNextStep';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';

interface PageProject {
  id: string;
  name: string;
  description: string | null;
  myRole: 'ADMIN' | 'MEMBER' | 'VIEWER';
  isPersonal: boolean;
  gitUrl: string | null;
}

type View = 'todo' | 'history';
const VIEW_KEY = 'skipper.pullRequests.view';

/** Sections de la vue « En cours », rangées par ce qui est attendu (pas par étape technique). */
const SECTIONS: { key: string; tones: NextStepTone[]; title: string; icon: string; hint: string }[] = [
  { key: 'you', tones: ['you', 'blocked'], title: 'À vous de décider', icon: 'bi-hand-index', hint: 'Prêtes à fusionner, à ouvrir ou à débloquer : la demande part à la session qui suit la PR.' },
  { key: 'agents', tones: ['agent', 'wait'], title: 'En cours chez les agents', icon: 'bi-robot', hint: "L'agent travaille ou les vérifications tournent : rien à faire pour l'instant." },
  { key: 'orphan', tones: ['orphan'], title: 'Sans session', icon: 'bi-question-circle', hint: 'Aucune session ne suit ces branches : à reprendre vous-même (menu ⋮) ou à confier à un agent depuis la tâche.' },
];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const endedAt = (pr: TrackedPullRequest) => pr.mergedAt ?? pr.closedAt ?? pr.updatedAt;

/**
 * Pull requests d'un projet. Vue « En cours » : chaque PR dit ce qui est attendu (prête à fusionner, en conflit, à
 * ouvrir, l'agent y travaille…) et propose la demande principale, envoyée à la session qui suit la PR ; un clic ouvre
 * sa fiche dans Skipper. Vue « Historique » : fusionnées et annulées, les plus récentes d'abord. La liste est
 * synchronisée avec le travail local des branches et avec la forge (au plus toutes les 20 s) ; « Rafraîchir » force.
 */
export default function ProjectPullRequestsPage() {
  const { id = '' } = useParams();
  const projectQ = useQuery<{ project: PageProject | null }>(PULL_REQUESTS_PROJECT, { variables: { id } });
  const prsQ = usePollingQuery<{ pullRequests: TrackedPullRequest[] }>(PULL_REQUESTS, { variables: { projectId: id, limit: 500 }, pollInterval: 30_000, fetchPolicy: 'cache-and-network' });
  const [sync, { loading: syncing }] = useMutation(SYNC_PULL_REQUESTS, { refetchQueries: ['PullRequests'] });
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'history' ? 'history' : 'todo'));
  const [search, setSearch] = useState('');
  const [registering, setRegistering] = useState(false);
  const project = projectQ.data?.project;
  const canWrite = project?.myRole === 'ADMIN' || project?.myRole === 'MEMBER';
  useTabTitle(project ? `Pull requests · ${project.name}` : null);
  useGitTarget(project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);

  const all = useMemo(() => prsQ.data?.pullRequests ?? [], [prsQ.data]);
  const board = usePullRequestBoard(all, canWrite);
  const isDone = (pr: TrackedPullRequest) => pr.stage === 'MERGED' || pr.stage === 'CANCELLED';
  const current = useMemo(() => all.filter((pr) => !isDone(pr)), [all]);
  const history = useMemo(() => all.filter(isDone).sort((a, b) => endedAt(b).localeCompare(endedAt(a))), [all]);
  const matches = useMemo(() => {
    const q = fold(search.trim());
    return (pr: TrackedPullRequest) => !q || fold(`${prRef(pr)} ${pr.title} ${pr.headBranch} ${pr.note} ${pr.task?.title ?? ''} ${pr.session?.name ?? ''} ${pr.foreignRepo ? pr.repo : ''}`).includes(q);
  }, [search]);
  const sections = useMemo(
    () =>
      SECTIONS.map((s) => ({ ...s, prs: current.filter(matches).filter((pr) => s.tones.includes(nextStep(pr).tone)) })).filter((s) => s.prs.length > 0),
    [current, matches],
  );
  const shownHistory = useMemo(() => history.filter(matches), [history, matches]);
  const waitingOnYou = useMemo(() => current.filter((pr) => ['you', 'blocked'].includes(nextStep(pr).tone)).length, [current]);
  const pick = (v: View) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  if (projectQ.loading && !project) return <PageLoading />;
  if (projectQ.error) return <Alert variant="danger">Erreur : {projectQ.error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const listProps = { canWrite, sent: board.sent, onOpen: board.open, onTechnical: board.openTechnical, onRequest: (pr: TrackedPullRequest, r: Parameters<typeof board.request>[1]) => void board.request(pr, r) };

  return (
    <>
      <ProjectHeader project={project} active="pullRequests" />
      <div className="pr-toolbar d-flex flex-wrap gap-2 align-items-center mb-2">
        <ButtonGroup size="sm">
          <Button variant={view === 'todo' ? 'secondary' : 'outline-secondary'} onClick={() => pick('todo')} title="Pull requests ouvertes et branches en préparation">
            En cours {current.length > 0 && <Badge bg={waitingOnYou > 0 ? 'primary' : 'light'} text={waitingOnYou > 0 ? undefined : 'dark'} className="ms-1" title={waitingOnYou > 0 ? `${waitingOnYou} attendent une décision` : undefined}>{waitingOnYou > 0 ? waitingOnYou : current.length}</Badge>}
          </Button>
          <Button variant={view === 'history' ? 'secondary' : 'outline-secondary'} onClick={() => pick('history')} title="Fusionnées et annulées">
            Historique {history.length > 0 && <Badge bg="light" text="dark" className="ms-1">{history.length}</Badge>}
          </Button>
        </ButtonGroup>
        <Form.Control size="sm" className="pr-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrer (titre, numéro, branche, tâche, session)" />
        <div className="pr-toolbar-actions ms-auto d-flex gap-2">
          <Button size="sm" variant="outline-secondary" disabled={syncing || !project.gitUrl} title="Relire le travail des branches et l'état des pull requests sur la forge" aria-label="Rafraîchir" onClick={() => void sync({ variables: { projectId: id } }).catch(() => undefined)}>
            <i className={`bi bi-arrow-clockwise${syncing ? ' spin' : ''}`} /> <span className="d-none d-md-inline">Rafraîchir</span>
          </Button>
          {canWrite && (
            <Button size="sm" variant="outline-secondary" onClick={() => setRegistering(true)} title="Suivre une pull request ouverte hors de Skipper (URL ou numéro)">
              <i className="bi bi-plus-lg me-1" /> <span className="d-none d-md-inline">Suivre une PR</span>
              <span className="d-md-none">Suivre</span>
            </Button>
          )}
        </div>
      </div>
      <p className="prq-intro small text-secondary mb-3">
        Chaque pull request est suivie par la session qui travaille sur sa branche. Cliquez sur une ligne pour sa fiche ; les boutons envoient la demande à cette session, qui s'en charge et rend compte dans sa conversation.
      </p>
      {prsQ.error && <Alert variant="warning" className="py-2 small">Liste indisponible : {prsQ.error.message}</Alert>}
      {!project.gitUrl && <Alert variant="secondary" className="py-2 small">Ce projet n'est pas relié à un dépôt git : les pull requests suivies ne sont pas synchronisées avec la forge.</Alert>}
      {prsQ.loading && !prsQ.data && <PageLoading />}
      {prsQ.data && view === 'todo' && (
        <>
          {sections.length === 0 && (
            <div className="text-secondary fst-italic small">
              {current.length === 0
                ? "Rien en cours. Dès qu'une session modifie une branche, elle apparaît ici « à ouvrir » ; les PR ouvertes par les agents ou sur la branche d'une tâche sont suivies d'elles-mêmes."
                : 'Aucune pull request ne correspond à ce filtre.'}
            </div>
          )}
          {sections.map((s) => (
            <section key={s.key} className="mb-4">
              <h2 className="h6 d-flex align-items-center flex-wrap gap-2 mb-1">
                <i className={`bi ${s.icon}`} />
                <span className="text-nowrap">{s.title}</span>
                <Badge bg="secondary" pill>
                  {s.prs.length}
                </Badge>
              </h2>
              <div className="small text-secondary mb-2">{s.hint}</div>
              <PullRequestList prs={s.prs} {...listProps} />
            </section>
          ))}
        </>
      )}
      {prsQ.data && view === 'history' && (shownHistory.length === 0 ? <div className="text-secondary fst-italic small">{history.length === 0 ? 'Aucune pull request fusionnée ou annulée pour le moment.' : 'Aucune pull request ne correspond à ce filtre.'}</div> : <PullRequestList prs={shownHistory} {...listProps} />)}
      {board.windows}
      {registering && <RegisterPullRequestModal projectId={id} onClose={() => setRegistering(false)} />}
    </>
  );
}
