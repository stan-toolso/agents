import { usePollingQuery } from '../lib/usePollingQuery';
import { useEffect, useState } from 'react';
import { Alert, Button, ButtonGroup, Card, Col, Dropdown, Row, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { DASHBOARD, type Dashboard } from '../graphql/operations';
import { timeAgo } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';
import { useSessionLauncher } from '../components/SessionLauncher';
import { useAuth } from '../auth/AuthContext';
import ChatComposer from '../components/ChatComposer';
import OnboardingBanner from '../components/OnboardingBanner';
import TaskModal from '../components/TaskModal';
import CockpitBoard, { CustomizeButton } from '../cockpit/CockpitBoard';
import type { CockpitContext } from '../cockpit/registry';
import { useCockpit } from '../cockpit/useCockpit';
import './dashboard.css';

/**
 * Page d'accueil : un tableau de bord qui répond à « qu'est-ce qui m'attend ? » — demandes en
 * attente, agents au travail ou en attente d'instructions, tâches à surveiller, consommation
 * du mois — puis une ligne par projet et l'activité récente. Tout vient d'une seule query,
 * rafraîchie régulièrement. Les blocs et leur ordre sont l'agencement « home » de la personne
 * (cockpit configurable : bouton « Personnaliser »).
 */
export default function DashboardPage() {
  const { openNewSession } = useSessionLauncher();
  useTabTitle('Tableau de bord');
  const { data, loading, error, refetch } = usePollingQuery<{ dashboard: Dashboard }>(DASHBOARD, { pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const d = data?.dashboard;
  const [newTask, setNewTask] = useState(false);
  // Sans facturation configurée, les coûts sont en dollars (tarif API) : la tuile n'est montrée qu'aux super
  // administrateurs ; les autres ne voient de coût qu'en crédits, dans une cellule facturée.
  const { user, costUnit } = useAuth();
  const showCostTile = costUnit === 'CREDIT' || Boolean(user?.isSuperAdmin);
  // Un administrateur de Skipper peut aussi régler l'accueil par défaut de toute la cellule (hérité par qui n'a rien réglé).
  const [scope, setScope] = useState<'home' | 'home:default'>('home');
  const [wantEdit, setWantEdit] = useState(false);
  const cockpit = useCockpit(d && d.projects.length > 0 ? scope : null);
  const { data: layoutData, editing, startEdit } = cockpit;
  // Édition d'un autre agencement : on change de portée, on attend qu'il soit chargé, puis on ouvre l'édition ; en sortant, retour à « home ».
  useEffect(() => {
    if (wantEdit && layoutData?.scope === scope && !editing) {
      setWantEdit(false);
      startEdit();
    } else if (!wantEdit && !editing && scope !== 'home') setScope('home');
  }, [wantEdit, layoutData?.scope, scope, editing, startEdit]);
  const editScope = (s: 'home' | 'home:default') => {
    setScope(s);
    setWantEdit(true);
  };

  if (!d && loading) {
    return (
      <div className="d-flex align-items-center gap-2 text-secondary">
        <Spinner animation="border" size="sm" /> Chargement du tableau de bord…
      </div>
    );
  }
  if (!d) return <Alert variant="danger">{error?.message ?? 'Tableau de bord indisponible.'}</Alert>;

  if (d.projects.length === 0)
    return (
      <>
        <ChatComposer withGreeting />
        <OnboardingBanner />
        <EmptyState />
      </>
    );

  // Projets où l'on peut créer une tâche (pas lecteur), proposés dans la modale de création.
  const writableProjects = d.projects.filter((p) => p.project.myRole !== 'VIEWER' && p.project.myRole !== 'GUEST').map((p) => p.project);
  const ctx: CockpitContext = { kind: 'home', viewer: user, showCostTile, home: d, project: null, refetch: ['Dashboard'] };

  return (
    <>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <h1 className="h3 mb-0">Tableau de bord</h1>
        <div className="d-flex align-items-center gap-2">
          <span className="text-secondary small d-none d-sm-inline">Mis à jour {timeAgo(d.generatedAt)}</span>
          <Button size="sm" variant="outline-secondary" className="d-none d-sm-inline-block" onClick={() => refetch()} title="Rafraîchir">
            <i className="bi bi-arrow-clockwise" />
          </Button>
          {user?.isAdmin && !cockpit.editing ? (
            <Dropdown as={ButtonGroup} size="sm">
              <Button size="sm" variant="outline-secondary" onClick={() => editScope('home')} title="Choisir, ordonner et régler les blocs de votre accueil">
                <i className="bi bi-sliders me-1" /> Personnaliser
              </Button>
              <Dropdown.Toggle split size="sm" variant="outline-secondary" title="Autres agencements" />
              <Dropdown.Menu align="end">
                <Dropdown.Item onClick={() => editScope('home')}>Mon accueil</Dropdown.Item>
                <Dropdown.Item onClick={() => editScope('home:default')}>L’accueil par défaut de tout le monde</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>
          ) : (
            <CustomizeButton cockpit={cockpit} />
          )}
          {writableProjects.length > 0 && (
            <Button size="sm" variant="outline-primary" onClick={() => setNewTask(true)} title="Créer une tâche dans l'un de vos projets">
              <i className="bi bi-plus-lg me-1" /> Tâche
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => openNewSession()}>
            <i className="bi bi-plus-lg me-1" /> Session
          </Button>
        </div>
      </div>
      {error && <Alert variant="warning" className="py-2 small">Dernier rafraîchissement en échec : {error.message}</Alert>}
      <OnboardingBanner />

      {!cockpit.editing && <ChatComposer withGreeting />}

      {cockpit.layout ? <CockpitBoard cockpit={cockpit} ctx={ctx} scopeLabel={scope === 'home:default' ? "l’accueil par défaut de tout le monde" : 'votre accueil'} /> : <div className="text-secondary small"><Spinner animation="border" size="sm" /> Agencement…</div>}

      {newTask && <TaskModal task={null} projectId={writableProjects[0]?.id ?? ''} projects={writableProjects} onClose={() => setNewTask(false)} />}
    </>
  );
}

/** Sans projet : le parcours en trois étapes, comme avant. */
function EmptyState() {
  return (
    <>
      <h1 className="h3 mb-2">Bienvenue sur Skipper</h1>
      <p className="text-secondary mb-4" style={{ maxWidth: 720 }}>
        Skipper vous permet de confier du travail à des agents (Claude Code, pour commencer) qui travaillent en arrière-plan sur vos projets.
        Vous gardez la main : vous leur donnez des instructions, vous suivez ce qu'ils font, et ils vous demandent votre accord avant les actions sensibles.
      </p>
      <Row className="g-3">
        {[
          { n: 1, icon: 'bi-folder2', title: 'Créez un projet', text: 'Un projet regroupe un dossier de travail (avec, si vous voulez, un dépôt git), des instructions permanentes pour les agents, et leurs sessions.', to: '/projects/new', cta: 'Nouveau projet', primary: true },
          { n: 2, icon: 'bi-chat-dots', title: 'Lancez une session', text: "Décrivez ce que l'agent doit faire. Il travaille en arrière-plan, vous suivez ses actions en direct et pouvez lui écrire à tout moment.", to: '/sessions', cta: 'Nouvelle session', disabled: true },
          { n: 3, icon: 'bi-bell', title: 'Répondez aux demandes', text: "Quand un agent veut modifier un fichier, lancer une commande ou a une question, il vous demande. Autorisez, refusez ou expliquez.", to: '/requests', cta: 'Voir les demandes' },
        ].map((step) => (
          <Col md={4} key={step.n}>
            <Card className="h-100">
              <Card.Body>
                <div className="fs-4 mb-2">
                  <i className={`bi ${step.icon} text-secondary`} /> <span className="badge bg-secondary">{step.n}</span>
                </div>
                <Card.Title className="h6">{step.title}</Card.Title>
                <Card.Text className="text-secondary small">{step.text}</Card.Text>
                <Button as={Link as any} to={step.to} size="sm" variant={step.primary ? 'primary' : 'outline-secondary'} disabled={step.disabled}>
                  {step.cta}
                </Button>
              </Card.Body>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  );
}
