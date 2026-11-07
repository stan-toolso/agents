import { Suspense, lazy } from 'react';
import { Button } from 'react-bootstrap';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import PageLoading from './PageLoading';
import StatusBanners from './StatusBanners';
import '../workbench/workbench.css';
import './guestLayout.css';

const SharedPagesPage = lazy(() => import('../pages/SharedPagesPage'));
const SharedPagePage = lazy(() => import('../pages/SharedPagePage'));

/**
 * Interface d'un invité des pages partagées (`User.isGuest`) : ni sidebar, ni onglets, ni projets ; une barre avec la
 * liste des pages partagées avec lui et la déconnexion, puis la page ouverte. Le serveur ne lui ouvre que ces pages
 * (garde GraphQL backend/src/graphql/security.ts) : toute autre adresse ramène à la liste.
 */
export default function GuestLayout() {
  const { user, logout } = useAuth();
  return (
    <div className="guest-app">
      <StatusBanners />
      <header className="guest-bar">
        <Link to="/shared" className="guest-brand">
          ✻ Skipper
        </Link>
        <Link to="/shared" className="guest-link">
          <i className="bi bi-file-earmark-richtext" />
          <span>Pages partagées avec vous</span>
        </Link>
        <span className="guest-user" title={user?.email}>
          {user?.name}
        </span>
        <Button size="sm" variant="outline-secondary" className="guest-logout" onClick={() => void logout()} title="Se déconnecter">
          <i className="bi bi-box-arrow-right" />
          <span className="guest-logout-label">Déconnexion</span>
        </Button>
      </header>
      <main className="guest-main">
        <Suspense fallback={<PageLoading className="p-3" />}>
          <Routes>
            <Route
              path="/shared"
              element={
                <div className="guest-list">
                  <SharedPagesPage />
                </div>
              }
            />
            <Route path="/shared/:id" element={<SharedPagePage />} />
            <Route path="*" element={<Navigate to="/shared" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
