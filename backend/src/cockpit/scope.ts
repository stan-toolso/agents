import { AppError } from '../errors.js';
import type { Scope, ScopeKind } from './types.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SLUG = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
const PATTERNS: { kind: ScopeKind; re: RegExp }[] = [
  { kind: 'home', re: /^home$/ },
  { kind: 'home', re: /^home:default$/ },
  { kind: 'tasks', re: new RegExp(`^project:(${UUID}):tasks$`) },
  { kind: 'page', re: new RegExp(`^project:(${UUID}):page:(${SLUG})$`) },
  { kind: 'project', re: new RegExp(`^project:(${UUID})$`) },
  { kind: 'agent', re: new RegExp(`^agent:(${UUID})$`) },
];

/** Portées composables aujourd'hui ; les autres sont réservées (voir docs/conception/cockpit-configurable.md). */
export const SUPPORTED_SCOPE_KINDS: ScopeKind[] = ['home', 'project', 'tasks', 'agent'];

/**
 * Analyse une clé de portée (`home`, `project:<id>`, `project:<id>:tasks`, `agent:<id>`, `project:<id>:page:<slug>`).
 * Lève une erreur lisible sur une clé inconnue ou une portée pas encore composable.
 */
export function parseScope(key: string): Scope {
  const k = String(key ?? '').trim().toLowerCase();
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(k);
    if (!m) continue;
    const scope: Scope = { kind, key: k, projectId: null, agentId: null, slug: null };
    if (k === 'home:default') scope.cell = true;
    if (kind === 'project' || kind === 'tasks' || kind === 'page') scope.projectId = m[1];
    if (kind === 'page') scope.slug = m[2];
    if (kind === 'agent') scope.agentId = m[1];
    if (!SUPPORTED_SCOPE_KINDS.includes(kind)) throw new AppError(`La portée « ${k} » n'est pas encore composable (bientôt : pages personnalisées)`, 'VALIDATION');
    return scope;
  }
  throw new AppError(`Portée inconnue : « ${key} » (attendu : home, project:<id>, project:<id>:tasks, agent:<id>, project:<id>:page:<slug>)`, 'VALIDATION');
}

export const projectScopeKey = (projectId: string) => `project:${projectId}`;
export const tasksScopeKey = (projectId: string) => `project:${projectId}:tasks`;
export const agentScopeKey = (agentId: string) => `agent:${agentId}`;
/** Défaut de l'accueil pour toute la cellule (administrateurs de Skipper). */
export const HOME_DEFAULT_KEY = 'home:default';
