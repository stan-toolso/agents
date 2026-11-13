import type { ReactNode } from 'react';
import { useQuery } from '@apollo/client';
import { Link, useLocation, useParams } from 'react-router-dom';
import { PROJECT_CONFIG_SHELL } from '../graphql/projectConfig';
import { CONFIG_GROUPS, ProjectConfigContext, type ProjectHeaderProject } from './ProjectHeader';

/**
 * Espace « Configuration » d'un projet : tout ce qui sert à gérer et paramétrer le projet (réglages, membres, agents,
 * contexte, coffre, environnement, planifications, workflows, consommation, journal, historique), à part des pages de
 * travail. Entoure chaque page de configuration (routes inchangées) : retour au projet, menu par groupes à gauche (une
 * bande défilante sur mobile), la page à droite. Dans ce cadre, `ProjectHeader` ne rend que le titre de la section et
 * ses actions (ProjectConfigContext).
 *
 * L'espace personnel garde ses onglets d'avant (pas de configuration à part) : la page s'affiche telle quelle.
 */
export default function ProjectConfigShell({ children }: { children: ReactNode }) {
  const { id = '' } = useParams();
  const { pathname } = useLocation();
  const { data } = useQuery<{ project: ProjectHeaderProject | null }>(PROJECT_CONFIG_SHELL, { variables: { id }, skip: !id, fetchPolicy: 'cache-first' });
  const project = data?.project;
  if (project?.isPersonal || project?.myRole === 'GUEST') return <>{children}</>;
  const isAdmin = project?.myRole === 'ADMIN';
  const base = `/projects/${id}`;
  const isActive = (path: string) => pathname === base + path || pathname.startsWith(`${base}${path}/`);
  return (
    <ProjectConfigContext.Provider value>
      <div className="project-config">
        <div className="project-config-head">
          <Link to={base} className="small">
            ← {project?.name ?? 'Projet'}
          </Link>
          <h1 className="h3 mb-0">
            <i className="bi bi-gear me-2 text-secondary" />
            Configuration
          </h1>
        </div>
        <div className="project-config-body">
          <nav className="project-config-nav" aria-label="Configuration du projet">
            {CONFIG_GROUPS.map((g) => {
              const items = g.items.filter((t) => !t.adminOnly || isAdmin);
              if (!items.length) return null;
              return (
                <div key={g.label} className="project-config-group">
                  <div className="project-config-group-label">{g.label}</div>
                  {items.map((t) => (
                    <Link key={t.key} to={base + t.path} className={`project-config-link${isActive(t.path) ? ' active' : ''}`} title={t.title} aria-current={isActive(t.path) ? 'page' : undefined}>
                      <i className={`bi ${t.icon}`} />
                      {t.label}
                    </Link>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="project-config-main">{children}</div>
        </div>
      </div>
    </ProjectConfigContext.Provider>
  );
}
