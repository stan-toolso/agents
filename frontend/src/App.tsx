import { lazy, Suspense } from 'react';
import { Spinner } from 'react-bootstrap';
import { Navigate, Route, Routes, useLocation, type Location } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import { DialogProvider } from './components/Dialogs';
import TabPages from './workbench/TabPages';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage'));
import LoginPage from './pages/LoginPage';
import SessionsPage from './pages/SessionsPage';
import SessionDetailPage from './pages/SessionDetailPage';
import RequestsPage from './pages/RequestsPage';
import InboxPage from './pages/InboxPage';
import DashboardPage from './pages/DashboardPage';
import TasksPage from './pages/TasksPage';
const ConversationsPage = lazy(() => import('./pages/ConversationsPage'));
import TaskPage from './pages/TaskPage';
import PersonalSpaceRedirect from './pages/PersonalSpaceRedirect';
import PageLoading from './components/PageLoading';

// Pages chargées à la demande (découpage du bundle) : éditeurs CodeMirror (fichiers, contexte), terminal xterm,
// graphe des workflows (xyflow, dagre) et pages rarement ouvertes restent hors du bundle principal, que
// l'application analyse et compile à chaque démarrage. Le service worker les précache après coup.
const ProjectFormPage = lazy(() => import('./pages/ProjectFormPage'));
const ContextPage = lazy(() => import('./pages/ContextPage'));
const SessionHistoryPage = lazy(() => import('./pages/SessionHistoryPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const BrowserPage = lazy(() => import('./pages/BrowserPage'));
const TerminalPage = lazy(() => import('./pages/TerminalPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const FilesPage = lazy(() => import('./pages/FilesPage'));
const VaultPage = lazy(() => import('./pages/VaultPage'));
const ProjectVaultPage = lazy(() => import('./pages/ProjectVaultPage'));
const ProjectEnvPage = lazy(() => import('./pages/ProjectEnvPage'));
const SharedPagesPage = lazy(() => import('./pages/SharedPagesPage'));
const SharedPagePage = lazy(() => import('./pages/SharedPagePage'));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage'));
const SchedulesPage = lazy(() => import('./pages/SchedulesPage'));
const WorkflowPage = lazy(() => import('./pages/WorkflowPage'));
const WorkflowRunPage = lazy(() => import('./pages/WorkflowRunPage'));
const ChatsPage = lazy(() => import('./pages/ChatsPage'));
const ProjectPullRequestsPage = lazy(() => import('./pages/ProjectPullRequestsPage'));
const ProjectDeliveriesPage = lazy(() => import('./pages/ProjectDeliveriesPage'));
const ProjectUsagePage = lazy(() => import('./pages/ProjectUsagePage'));
const RepoPage = lazy(() => import('./pages/RepoPage'));
const ProjectAgentsPage = lazy(() => import('./pages/ProjectAgentsPage'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const SharedSessionPage = lazy(() => import('./pages/SharedSessionPage'));

/** Routes des pages ; `location` est celle de l'onglet rendu (figée pour un onglet caché). */
function PageRoutes({ location, isAdmin }: { location: Location; isAdmin: boolean }) {
  return (
    <Suspense fallback={<PageLoading className="p-3" />}>
      <Routes location={location}>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/new" element={<ProjectFormPage />} />
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
      <Route path="/projects/:id/edit" element={<ProjectFormPage />} />
      <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
      <Route path="/projects/:id/context" element={<ContextPage />} />
      <Route path="/projects/:id/tasks" element={<TasksPage />} />
      <Route path="/projects/:id/conversations" element={<ConversationsPage />} />
      <Route path="/projects/:id/conversations/:slug" element={<ConversationsPage />} />
      <Route path="/projects/:id/agents" element={<ProjectAgentsPage />} />
      <Route path="/projects/:id/agents/:agentId" element={<AgentPage />} />
      <Route path="/projects/:id/pull-requests" element={<ProjectPullRequestsPage />} />
      <Route path="/projects/:id/deliveries" element={<ProjectDeliveriesPage />} />
      <Route path="/projects/:id/usage" element={<ProjectUsagePage />} />
      <Route path="/projects/:id/repo" element={<RepoPage />} />
      <Route path="/projects/:id/vault" element={<ProjectVaultPage />} />
      <Route path="/projects/:id/env" element={<ProjectEnvPage />} />
      <Route path="/projects/:id/history" element={<SessionHistoryPage />} />
      <Route path="/projects/:id/audit" element={<AuditPage />} />
      <Route path="/projects/:id/connections" element={<RedirectToVault />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/:id" element={<TaskPage />} />
      <Route path="/vault" element={<VaultPage />} />
      <Route path="/schedules" element={<SchedulesPage />} />
      <Route path="/projects/:id/schedules" element={<SchedulesPage />} />
      <Route path="/workflows" element={<WorkflowsPage />} />
      <Route path="/workflows/:id" element={<WorkflowPage />} />
      <Route path="/workflows/:id/runs/:runId" element={<WorkflowRunPage />} />
      <Route path="/projects/:id/workflows" element={<WorkflowsPage />} />
      <Route path="/shared" element={<SharedPagesPage />} />
      <Route path="/shared/:id" element={<SharedPagePage />} />
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/sessions/:id" element={<SessionDetailPage />} />
      <Route path="/chats" element={<ChatsPage />} />
      <Route path="/chats/:id" element={<SessionDetailPage />} />
      <Route path="/me" element={<PersonalSpaceRedirect />} />
      <Route path="/sessions/:id/browser" element={<BrowserPage />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/requests" element={<RequestsPage />} />
      <Route path="/terminals/:id" element={<TerminalPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      {isAdmin && <Route path="/users" element={<UsersPage />} />}
      {isAdmin && <Route path="/billing" element={<BillingPage />} />}
      <Route path="/projects/:id/files" element={<FilesPage />} />
      <Route path="/projects/:id/files/*" element={<FilesPage />} />
      <Route path="/sessions/:id/files" element={<FilesPage />} />
      <Route path="/sessions/:id/files/*" element={<FilesPage />} />
      <Route path="/worktrees/*" element={<Navigate to="/" replace />} />
      <Route path="/worksessions/*" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function RedirectToVault() {
  const path = window.location.pathname.replace(/\/connections$/, '/vault');
  return <Navigate to={path} replace />;
}

/** Sans utilisateur connecté, seule la page de connexion est affichée. */
function Gate() {
  const { user, loading, error } = useAuth();
  if (loading && !user) {
    return (
      <div className="d-flex align-items-center justify-content-center" style={{ minHeight: '100vh' }}>
        <Spinner animation="border" size="sm" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="d-flex align-items-center justify-content-center text-secondary" style={{ minHeight: '100vh' }}>
        Le serveur ne répond pas ({error.message}).
      </div>
    );
  }
  if (!user) return <LoginPage />;
  return (
    <Layout>
      <TabPages render={(location) => <PageRoutes location={location} isAdmin={user.isAdmin} />} />
    </Layout>
  );
}

export default function App() {
  // Lien public d'une session (/share/<token>) : lisible sans compte, hors de l'application (ni connexion, ni sidebar).
  const { pathname } = useLocation();
  if (pathname.startsWith('/share/'))
    return (
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/share/:token" element={<SharedSessionPage />} />
        </Routes>
      </Suspense>
    );
  return (
    <AuthProvider>
      <DialogProvider>
        <Gate />
      </DialogProvider>
    </AuthProvider>
  );
}
