import { useQuery } from '@apollo/client';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { Alert } from 'react-bootstrap';
import { PROJECT_ROLE, GUEST_PROJECTS } from '../graphql/misc';
import { useAuth } from '../auth/AuthContext';
import PageLoading from './PageLoading';
import type { ReactNode } from 'react';

/**
 * Pages d'un projet : un invité du projet (rôle invité : conversations et artefacts partagés seulement) est ramené à
 * ses conversations, quelle que soit l'adresse qu'il ouvre (tableau de bord, tâches…). Les autres passent.
 * Une petite requête `project { myRole }`, servie par le cache Apollo dès la deuxième page.
 */
export function ProjectRoleGate({ children }: { children: ReactNode }) {
  const { id = '' } = useParams();
  const { pathname } = useLocation();
  const { data, loading } = useQuery<{ project: { id: string; myRole: string } | null }>(PROJECT_ROLE, { variables: { id }, skip: !id });
  if (loading && !data) return <PageLoading className="p-3" />;
  if (data?.project?.myRole === 'GUEST' && !pathname.startsWith(`/projects/${id}/conversations`)) return <Navigate to={`/projects/${id}/conversations`} replace />;
  return <>{children}</>;
}

/**
 * Accueil d'une personne qui n'a que des accès d'invité : droit aux conversations du projet où elle est invitée (le
 * premier, ou celui qui a des non-lus) ; sans projet, un mot d'explication.
 */
export function RestrictedHome() {
  const { user } = useAuth();
  const { data, loading } = useQuery<{ guestProjects: { id: string; name: string; unreadMessages: number }[] }>(GUEST_PROJECTS);
  if (loading && !data) return <PageLoading className="p-3" />;
  const projects = data?.guestProjects ?? [];
  const target = [...projects].sort((a, b) => b.unreadMessages - a.unreadMessages)[0];
  if (target) return <Navigate to={`/projects/${target.id}/conversations`} replace />;
  return (
    <Alert variant="light" className="m-3 border">
      <div className="fw-semibold mb-1">Bonjour {user?.name} !</div>
      Votre compte donne accès aux conversations des projets où l’on vous invite, et aux artefacts partagés avec vous. Pour le moment, aucun projet ne vous a invité : revenez quand on vous aura prévenu.
    </Alert>
  );
}
