/**
 * Fenêtre dédiée à un projet : une fenêtre du navigateur ouverte depuis le menu d'un projet (« Ouvrir dans une
 * nouvelle fenêtre ») où tout se limite à ce projet — sidebar, notifications, « À traiter », messages, recherche,
 * onglets. Les pages globales sont remplacées par celles du projet ; celles d'un autre projet ne s'y affichent pas
 * (un bouton les ouvre dans Skipper complet).
 *
 * L'état tient au nom de la fenêtre (`window.name`) : il survit aux rechargements et aux navigations de cette
 * fenêtre, sans jamais passer aux autres (contrairement au localStorage, partagé, ou au sessionStorage, recopié
 * dans les fenêtres ouvertes depuis celle-ci). Le paramètre `?projectWindow=<id>` de l'adresse d'ouverture le pose
 * (utile aussi quand le navigateur ne garde pas le nom, ex. application installée) puis disparaît de l'adresse.
 */

const NAME_PREFIX = 'skipper-project:';
export const PROJECT_WINDOW_PARAM = 'projectWindow';
/** Identifiant de projet accepté (uuid en production ; lettres, chiffres et tirets, sans barre ni point). */
const UUID = /^[0-9A-Za-z-]{1,64}$/;

/** Lit (et pose, depuis l'adresse) le projet de la fenêtre ; null : Skipper complet. */
export function detectProjectWindow(win: Pick<Window, 'name' | 'location' | 'history'> = window): string | null {
  try {
    const params = new URLSearchParams(win.location.search);
    const fromUrl = params.get(PROJECT_WINDOW_PARAM);
    if (fromUrl !== null) {
      params.delete(PROJECT_WINDOW_PARAM);
      const search = params.toString();
      win.history.replaceState(win.history.state, '', `${win.location.pathname}${search ? `?${search}` : ''}${win.location.hash}`);
      if (UUID.test(fromUrl)) win.name = `${NAME_PREFIX}${fromUrl}`;
    }
    if (win.name.startsWith(NAME_PREFIX)) {
      const id = win.name.slice(NAME_PREFIX.length);
      return UUID.test(id) ? id : null;
    }
  } catch {
    /* hors navigateur */
  }
  return null;
}

/** Projet de cette fenêtre, lu une fois au chargement (changer de mode recharge la page). */
export const projectWindowId: string | null = typeof window === 'undefined' ? null : detectProjectWindow();

/** Ouvre (ou ramène au premier plan) la fenêtre dédiée au projet, sur `path` (défaut : son tableau de bord). */
export function openProjectWindow(projectId: string, path = `/projects/${projectId}`): void {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${path}${sep}${PROJECT_WINDOW_PARAM}=${projectId}`;
  // Une vraie fenêtre (pas un onglet) de la taille de celle-ci ; le nom la retrouve si elle est déjà ouverte.
  const w = Math.max(800, window.outerWidth || 1280);
  const h = Math.max(600, window.outerHeight || 800);
  const opened = window.open(url, `${NAME_PREFIX}${projectId}`, `popup=yes,width=${w},height=${h},left=${(window.screenX || 0) + 40},top=${(window.screenY || 0) + 40}`);
  opened?.focus();
}

/** Ouvre Skipper complet dans un nouvel onglet, sur la page donnée (défaut : la page affichée). */
export function openFullSkipper(path = `${window.location.pathname}${window.location.search}`): void {
  // noopener : le nouvel onglet ne reçoit ni le nom de cette fenêtre ni son sessionStorage.
  window.open(path, '_blank', 'noopener');
}

/** Rend à cette fenêtre tout Skipper (sur la page affichée). */
export function leaveProjectWindow(): void {
  window.name = '';
  window.location.assign(`${window.location.pathname}${window.location.search}`);
}

/** Ce que devient une adresse dans la fenêtre d'un projet. */
export type ProjectWindowRoute = { redirect: string } | { foreign: true } | null;

/**
 * Pages globales → leur équivalent dans le projet ; pages d'un autre projet ou d'administration de Skipper →
 * « hors de ce projet » ; le reste (pages du projet, sessions, tâches, paramètres personnels…) → null, inchangé.
 */
export function projectWindowRoute(pathname: string, projectId: string): ProjectWindowRoute {
  const home = `/projects/${projectId}`;
  const redirects: Record<string, string> = {
    '/': home,
    '/projects': home,
    '/me': home,
    '/chats': home,
    '/requests': '/inbox',
    '/sessions': `${home}/history`,
    '/tasks': `${home}/tasks`,
    '/shared': `${home}/artifacts`,
    '/vault': `${home}/vault`,
    '/schedules': `${home}/schedules`,
    '/workflows': `${home}/workflows`,
  };
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (redirects[path]) return { redirect: redirects[path] };
  const project = path.match(/^\/projects\/([^/]+)/);
  if (project && project[1] !== projectId) return { foreign: true };
  if (/^\/chats\//.test(path) || path === '/users' || path === '/billing') return { foreign: true };
  return null;
}
