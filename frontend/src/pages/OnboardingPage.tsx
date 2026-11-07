import { useMutation, useQuery } from '@apollo/client';
import { useState, type ReactNode } from 'react';
import { Alert, Badge, Button, ButtonGroup, Card, Col, Row } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import GithubSection from '../components/GithubSection';
import GitlabSection from '../components/GitlabSection';
import PageLoading from '../components/PageLoading';
import { KINDS } from '../components/vault/kinds';
import VaultItemEditor from '../components/vault/VaultItemEditor';
import { PROJECTS, type Project } from '../graphql/operations';
import { SETTINGS, UPDATE_ONBOARDING, type AppSettings } from '../graphql/settings';
import { SKIPPER_KINDS, VAULT_ITEMS, type VaultItem, type VaultItemKind } from '../graphql/vault';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { AuthCard, claudeReadyOf } from './SettingsPage';
import { tunnelsOf } from './VaultPage';
import './onboarding.css';

/**
 * Assistant de premiers pas (`/welcome`) : quatre étapes pour régler les principaux comptes d'une personne — Claude (son
 * abonnement ou sa clé API plutôt que les crédits Skipper), GitHub ou GitLab, le coffre (Google, serveurs, bases, API…) —
 * chacune avec ses cas d'usage. Ouvert d'office à la première connexion (`useOnboardingAutoOpen`), on peut le passer et
 * le rouvrir depuis le menu du compte. Chaque étape réutilise le réglage de Paramètres ou du coffre : ce qu'on y fait
 * est fait pour de bon, et une étape faite ailleurs apparaît faite ici.
 */

type StepKey = 'welcome' | 'claude' | 'git' | 'vault' | 'done';
const STEPS: { key: StepKey; label: string; icon: string }[] = [
  { key: 'welcome', label: 'Bienvenue', icon: 'bi-compass' },
  { key: 'claude', label: 'Claude', icon: 'bi-stars' },
  { key: 'git', label: 'GitHub / GitLab', icon: 'bi-git' },
  { key: 'vault', label: 'Coffre', icon: 'bi-safe' },
  { key: 'done', label: 'C’est parti', icon: 'bi-rocket-takeoff' },
];
const STEP_KEY = 'skipper.onboarding.step';

/** Étape demandée par le lien (`/welcome?step=claude`), sinon la dernière ouverte dans ce navigateur. */
function readStep(): StepKey {
  try {
    const v = (new URLSearchParams(window.location.search).get('step') ?? localStorage.getItem(STEP_KEY)) as StepKey | null;
    return v && STEPS.some((s) => s.key === v) ? v : 'welcome';
  } catch {
    return 'welcome';
  }
}

/** Éléments du coffre offerts aux agents dont la personne est propriétaire (jetons applicatifs exclus). */
const agentItemsOf = (items: VaultItem[], userId: string | undefined) => items.filter((i) => !SKIPPER_KINDS.includes(i.kind) && i.ownerUser?.id === userId);

export default function OnboardingPage() {
  useTabTitle('Premiers pas');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [step, setStepState] = useState<StepKey>(readStep);
  const setStep = (next: StepKey) => {
    setStepState(next);
    try {
      localStorage.setItem(STEP_KEY, next);
    } catch {
      /* navigation privée */
    }
    document.querySelector('.wb-content')?.scrollTo({ top: 0 });
  };
  const { data, loading, error } = usePollingQuery<{ settings: AppSettings }>(SETTINGS, { pollInterval: 15_000 });
  const { data: vaultData } = usePollingQuery<{ vaultItems: VaultItem[]; vaultGoogleAvailable: boolean }>(VAULT_ITEMS, { pollInterval: 30_000 });
  const [updateOnboarding, { loading: saving }] = useMutation(UPDATE_ONBOARDING);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!data) return null;
  const s = data.settings;
  const vaultItems = vaultData?.vaultItems ?? [];
  const done: Record<StepKey, boolean> = {
    welcome: true,
    claude: claudeReadyOf(s),
    git: s.github.connected || s.gitlab.connected,
    vault: agentItemsOf(vaultItems, user?.id).length > 0,
    done: Boolean(s.onboarding.completedAt),
  };
  const index = STEPS.findIndex((x) => x.key === step);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)].key);
  const prev = () => setStep(STEPS[Math.max(index - 1, 0)].key);
  const skip = () =>
    void updateOnboarding({ variables: { dismissed: true } })
      .catch(() => undefined)
      .finally(() => navigate('/'));
  const finish = (to: string) =>
    void updateOnboarding({ variables: { completed: true } })
      .catch(() => undefined)
      .finally(() => {
        setStep('welcome');
        navigate(to);
      });

  return (
    <div className="onboarding">
      <div className="d-flex align-items-start justify-content-between gap-2 flex-wrap mb-3">
        <div>
          <h1 className="h3 mb-1">Premiers pas</h1>
          <div className="text-secondary small">Quelques minutes pour brancher vos comptes. Chaque étape est facultative et se retrouve ensuite dans Paramètres ou le Coffre.</div>
        </div>
        {!s.onboarding.completedAt && (
          <Button variant="link" size="sm" className="text-secondary" disabled={saving} onClick={skip}>
            Passer pour l’instant
          </Button>
        )}
      </div>

      <ol className="onboarding-steps" aria-label="Étapes">
        {STEPS.map((x, i) => (
          <li key={x.key} className={`${x.key === step ? 'current' : ''}${i < index ? ' past' : ''}`}>
            <button type="button" onClick={() => setStep(x.key)} aria-current={x.key === step ? 'step' : undefined}>
              <span className="dot">{done[x.key] && x.key !== 'welcome' && x.key !== 'done' ? <i className="bi bi-check-lg" /> : i + 1}</span>
              <span className="label">{x.label}</span>
            </button>
          </li>
        ))}
      </ol>

      {step === 'welcome' && <WelcomeStep />}
      {step === 'claude' && <ClaudeStep settings={s} />}
      {step === 'git' && <GitStep settings={s} />}
      {step === 'vault' && <VaultStep items={vaultItems} googleAvailable={vaultData?.vaultGoogleAvailable ?? false} />}
      {step === 'done' && <DoneStep done={done} settings={s} goTo={setStep} finish={finish} />}

      {step !== 'done' && (
        <div className="onboarding-nav">
          <Button variant="outline-secondary" disabled={index === 0} onClick={prev}>
            <i className="bi bi-arrow-left me-1" /> Précédent
          </Button>
          <Button onClick={next}>
            {step === 'welcome' ? 'Commencer' : done[step] ? 'Suivant' : 'Plus tard, étape suivante'} <i className="bi bi-arrow-right ms-1" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** Un cas d'usage : icône, titre, explication courte. */
function UseCase({ icon, title, children, badge, action }: { icon: string; title: string; children: ReactNode; badge?: ReactNode; action?: ReactNode }) {
  return (
    <Card className="h-100 onboarding-case">
      <Card.Body className="d-flex flex-column">
        <div className="fw-semibold mb-1">
          <i className={`bi ${icon} me-2`} />
          {title}
          {badge}
        </div>
        <div className="small text-secondary flex-grow-1">{children}</div>
        {action && <div className="mt-2">{action}</div>}
      </Card.Body>
    </Card>
  );
}

function WelcomeStep() {
  return (
    <section>
      <h2 className="h5">Bienvenue sur Skipper</h2>
      <p className="text-secondary" style={{ maxWidth: 760 }}>
        Skipper fait travailler des agents (Claude Code) en arrière-plan sur vos projets : vous leur confiez une tâche, vous suivez ce
        qu’ils font en direct, et ils vous demandent votre accord avant les actions sensibles. Pour cela, ils ont besoin d’accéder à
        trois choses, que cet assistant vous aide à brancher :
      </p>
      <Row className="g-3">
        <Col md={4}>
          <UseCase icon="bi-stars" title="1. Un compte Claude">
            Le « cerveau » des agents. Les crédits Skipper suffisent pour commencer ; votre propre abonnement ou votre clé API peut les remplacer.
          </UseCase>
        </Col>
        <Col md={4}>
          <UseCase icon="bi-git" title="2. Vos dépôts de code">
            GitHub ou GitLab, pour que les agents travaillent sur vos dépôts, poussent leurs branches et ouvrent des pull requests en votre nom.
          </UseCase>
        </Col>
        <Col md={4}>
          <UseCase icon="bi-safe" title="3. Vos outils, via le coffre">
            Gmail et Drive, serveurs, bases de données, API… Les agents s’en servent sans jamais voir vos mots de passe ni vos clés.
          </UseCase>
        </Col>
      </Row>
      <p className="small text-secondary mt-3 mb-0">
        <i className="bi bi-shield-lock me-1" />
        Vos identifiants sont chiffrés dans votre coffre personnel : ni les agents ni vos collègues ne peuvent les lire.
      </p>
    </section>
  );
}

function ClaudeStep({ settings }: { settings: AppSettings }) {
  const { user } = useAuth();
  const auth = settings.claudeAuth;
  const own = auth.mode === 'oauth' ? auth.hasOauthToken : auth.hasApiKey;
  const active = <Badge bg="success" className="ms-2">utilisé</Badge>;
  return (
    <section>
      <h2 className="h5">Claude, le moteur de vos agents</h2>
      <p className="text-secondary" style={{ maxWidth: 760 }}>
        Chaque session fait travailler Claude Code, qui a besoin d’un compte Claude pour réfléchir, lire et écrire du code. Trois façons
        de le fournir :
      </p>
      <Row className="g-3 mb-4">
        <Col md={4}>
          <UseCase icon="bi-coin" title="Crédits Skipper" badge={auth.usesCellAccount ? active : null}>
            {auth.cellAccountAvailable ? (
              <>Rien à faire : sans compte à vous, vos sessions utilisent le compte de Skipper et leur travail est compté en crédits dans la consommation de votre organisation. Idéal pour commencer.</>
            ) : (
              <>
                Pas de compte Claude commun sur cette instance : connectez le vôtre ci-dessous pour lancer des sessions.
                {user?.isAdmin && (
                  <>
                    {' '}
                    Administrateur : vous pouvez en choisir un dans <Link to="/settings?section=server">Paramètres › Serveur</Link>.
                  </>
                )}
              </>
            )}
          </UseCase>
        </Col>
        <Col md={4}>
          <UseCase icon="bi-person-badge" title="Votre abonnement Claude" badge={own && auth.mode === 'oauth' ? active : null}>
            Pro, Max, Team ou Enterprise : vos sessions consomment votre abonnement <strong>plutôt que les crédits Skipper</strong>, sans coût
            supplémentaire, dans la limite de ses quotas. Connexion en deux clics sur claude.com.
          </UseCase>
        </Col>
        <Col md={4}>
          <UseCase icon="bi-key" title="Une clé API Anthropic" badge={own && auth.mode === 'api_key' ? active : null}>
            Facturée à l’usage par Anthropic, sur votre compte ou celui de votre entreprise (console.anthropic.com). Pour un budget suivi à
            part, ou au-delà des quotas d’un abonnement.
          </UseCase>
        </Col>
      </Row>
      <AuthCard settings={settings} />
      <p className="small text-secondary">
        Modèles proposés, plafond mensuel et budget par session se règlent ensuite dans <Link to="/settings?section=claude">Paramètres › Claude</Link>.
      </p>
    </section>
  );
}

function GitStep({ settings }: { settings: AppSettings }) {
  const [forge, setForge] = useState<'github' | 'gitlab'>(settings.gitlab.connected && !settings.github.connected ? 'gitlab' : 'github');
  return (
    <section>
      <h2 className="h5">Vos dépôts de code : GitHub ou GitLab</h2>
      <p className="text-secondary" style={{ maxWidth: 760 }}>
        Reliez le ou les comptes qui ont accès à vos dépôts. Skipper s’en sert pour vous et pour les agents de vos sessions :
      </p>
      <Row className="g-3 mb-4">
        <Col md={4}>
          <UseCase icon="bi-folder-symlink" title="Projets reliés à un dépôt">
            Créer un projet à partir d’un dépôt, même privé : il est cloné et chaque session travaille sur sa propre branche.
          </UseCase>
        </Col>
        <Col md={4}>
          <UseCase icon="bi-git" title="Branches et pull requests">
            Les agents poussent leurs branches et ouvrent des pull requests (merge requests sur GitLab) en votre nom ; leurs commits portent votre identité.
          </UseCase>
        </Col>
        <Col md={4}>
          <UseCase icon="bi-check2-circle" title="Suivi et livraison">
            Suivre les PR, l’état de la CI et livrer sur la branche principale depuis Skipper.
          </UseCase>
        </Col>
      </Row>
      <p className="small text-secondary">
        Inutile si vos projets n’ont pas de dépôt, ou si leur dépôt est hébergé par Skipper. Vous pouvez relier plusieurs comptes (personnel,
        entreprise) : Skipper choisit celui qui possède chaque dépôt.
      </p>
      <ButtonGroup size="sm" className="mb-3">
        <Button variant={forge === 'github' ? 'primary' : 'outline-secondary'} onClick={() => setForge('github')}>
          <i className="bi bi-github me-1" /> GitHub {settings.github.connected && <i className="bi bi-check-lg ms-1" />}
        </Button>
        <Button variant={forge === 'gitlab' ? 'primary' : 'outline-secondary'} onClick={() => setForge('gitlab')}>
          <i className="bi bi-gitlab me-1" /> GitLab {settings.gitlab.connected && <i className="bi bi-check-lg ms-1" />}
        </Button>
      </ButtonGroup>
      {forge === 'github' ? <GithubSection /> : <GitlabSection />}
    </section>
  );
}

/** Cas d'usage du coffre, dans l'ordre où on les propose. */
const VAULT_CASES: { kind: VaultItemKind; title: string; text: string }[] = [
  { kind: 'google', title: 'Gmail et Google Drive', text: 'Trier et résumer vos mails, préparer des brouillons de réponse, retrouver un document ou déposer un rapport sur Drive. Chaque écriture demande votre accord.' },
  { kind: 'ssh', title: 'Serveur SSH', text: 'Lire les journaux d’une production, diagnostiquer une panne, déployer. Vous pouvez limiter les commandes permises.' },
  { kind: 'postgres', title: 'Base PostgreSQL', text: 'Analyser des données, vérifier un correctif, préparer un export. En lecture seule par défaut.' },
  { kind: 'api', title: 'API HTTP', text: 'Stripe, Notion, Jira, Brevo ou votre propre API : l’agent appelle, le serveur ajoute la clé.' },
  { kind: 'website', title: 'Site web', text: 'Se connecter à un back-office ou un outil sans API : le serveur tape l’identifiant et le mot de passe dans le navigateur.' },
  { kind: 'aws', title: 'AWS ou Scaleway', text: 'Inventorier une infrastructure, lire des journaux ou des coûts. En lecture seule par défaut.' },
];

function VaultStep({ items, googleAvailable }: { items: VaultItem[]; googleAvailable: boolean }) {
  const { user } = useAuth();
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const [adding, setAdding] = useState<VaultItemKind | null>(null);
  const mine = agentItemsOf(items, user?.id);
  const count = (kind: VaultItemKind) => mine.filter((i) => i.kind === kind || (kind === 'aws' && i.kind === 'scaleway')).length;
  const projects = projectsData?.projects ?? [];
  return (
    <section>
      <h2 className="h5">Le coffre : vos outils, sans jamais montrer les secrets</h2>
      <p className="text-secondary" style={{ maxWidth: 760 }}>
        Rangez dans votre coffre les accès que vos agents peuvent utiliser. Ils ne voient jamais les mots de passe ni les clés : le serveur
        agit pour eux, journalise chaque usage, et peut vous demander votre accord à chaque fois. Un élément personnel vous appartient ;
        vous choisissez à quels projets l’ouvrir et avec qui le partager.
      </p>
      <Row className="g-3 mb-3">
        {VAULT_CASES.map((c) => {
          const n = count(c.kind);
          const unavailable = c.kind === 'google' && !googleAvailable;
          return (
            <Col md={6} xl={4} key={c.kind}>
              <UseCase
                icon={KINDS[c.kind].icon}
                title={c.title}
                badge={n > 0 ? <Badge bg="success" className="ms-2">{n}</Badge> : null}
                action={
                  unavailable ? (
                    <span className="small text-secondary">Connexion Google non configurée sur ce serveur.</span>
                  ) : (
                    <Button size="sm" variant="outline-secondary" onClick={() => setAdding(c.kind)}>
                      <i className="bi bi-plus-lg me-1" /> {c.kind === 'google' ? 'Connecter un compte Google' : 'Ajouter'}
                    </Button>
                  )
                }
              >
                {c.text}
              </UseCase>
            </Col>
          );
        })}
      </Row>
      <p className="small text-secondary">
        Vous en avez {mine.length === 0 ? 'aucun pour l’instant' : mine.length === 1 ? 'un' : mine.length} dans votre coffre. Tout se retrouve dans le{' '}
        <Link to="/vault">Coffre</Link> (menu de la barre latérale), avec les secrets et les comptes partagés.
      </p>
      {adding && (
        <VaultItemEditor
          item={null}
          initialKind={adding}
          owners={[{ projectId: null, label: 'Mon coffre personnel' }, ...projects.filter((p) => p.myRole === 'ADMIN').map((p) => ({ projectId: p.id, label: `Projet ${p.name}` }))]}
          tunnels={tunnelsOf(items)}
          googleAvailable={googleAvailable}
          onClose={() => setAdding(null)}
          onSaved={() => setAdding(null)}
        />
      )}
    </section>
  );
}

function DoneStep({ done, settings, goTo, finish }: { done: Record<StepKey, boolean>; settings: AppSettings; goTo: (s: StepKey) => void; finish: (to: string) => void }) {
  const rows: { key: StepKey; label: string; ok: string; todo: string }[] = [
    {
      key: 'claude',
      label: 'Claude',
      ok: settings.claudeAuth.usesCellAccount ? 'crédits Skipper' : settings.claudeAuth.mode === 'oauth' ? 'votre abonnement' : 'votre clé API',
      todo: 'à connecter pour lancer des sessions',
    },
    { key: 'git', label: 'GitHub / GitLab', ok: [settings.github.connected && 'GitHub', settings.gitlab.connected && 'GitLab'].filter(Boolean).join(' et '), todo: 'aucun compte relié' },
    { key: 'vault', label: 'Coffre', ok: 'des éléments prêts', todo: 'vide pour l’instant' },
  ];
  return (
    <section>
      <h2 className="h5">C’est parti</h2>
      <Card className="mb-4" style={{ maxWidth: 640 }}>
        <Card.Body>
          {rows.map((r) => (
            <div key={r.key} className="d-flex align-items-center gap-2 py-1">
              <i className={`bi ${done[r.key] ? 'bi-check-circle-fill text-success' : 'bi-circle text-secondary'}`} />
              <span className="fw-semibold">{r.label}</span>
              <span className="text-secondary small">{done[r.key] ? r.ok : r.todo}</span>
              <Button variant="link" size="sm" className="ms-auto p-0" onClick={() => goTo(r.key)}>
                {done[r.key] ? 'Revoir' : 'Configurer'}
              </Button>
            </div>
          ))}
        </Card.Body>
      </Card>
      {!done.claude && (
        <Alert variant="warning" className="small py-2" style={{ maxWidth: 640 }}>
          Sans compte Claude, vos sessions ne peuvent pas démarrer.
        </Alert>
      )}
      <p className="text-secondary">Et maintenant :</p>
      <div className="d-flex gap-2 flex-wrap">
        <Button onClick={() => finish('/projects/new')}>
          <i className="bi bi-folder-plus me-1" /> Créer un projet
        </Button>
        <Button variant="outline-secondary" onClick={() => finish('/me')}>
          <i className="bi bi-chat-dots me-1" /> Ouvrir mon espace personnel
        </Button>
        <Button variant="outline-secondary" onClick={() => finish('/')}>
          Aller au tableau de bord
        </Button>
      </div>
      <p className="small text-secondary mt-3">Vous retrouverez cet assistant dans le menu de votre compte (en bas de la barre latérale), à « Premiers pas ».</p>
    </section>
  );
}
