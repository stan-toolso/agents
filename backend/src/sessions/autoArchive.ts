import type { Session } from './types.js';

/**
 * Archivage d'office en fin de tour des sessions d'agents lancées sans personne (déclencheurs : tâche créée ou prête, PR
 * fusionnée, fil suivi, mention ; convocation par une autre session ; lancement automatique d'une tâche débloquée).
 * Le drapeau `config.autoArchive` est posé à la création (`agentService.summon` avec `autoArchive`) ; personne ne
 * pilote ces sessions, elles se rangent donc d'elles-mêmes dès que l'agent a fini son tour, sans dépendre de l'appel
 * de `sessions.archive` par le modèle. La suite passe par le fil : la tâche ou le canal reconvoque l'agent.
 */
export const AUTO_ARCHIVE_KEY = 'autoArchive';

/** Configuration d'une session lancée sans personne : archivée d'office à la fin de chaque tour. */
export const autoArchiveConfig = (): Record<string, unknown> => ({ [AUTO_ARCHIVE_KEY]: true });

/** Configuration sans le drapeau (une personne pilote désormais la session). */
export function withoutAutoArchive(config: Record<string, unknown>): Record<string, unknown> {
  const { [AUTO_ARCHIVE_KEY]: _dropped, ...rest } = config ?? {};
  return rest;
}

/**
 * La session se range-t-elle d'office à la fin de son tour ? Pas si une personne la pilote (prise en main, ou une
 * instruction écrite directement dans la session, qui retire le drapeau), ni pour une sous-session (sa parente
 * l'archive après avoir lu sa réponse), ni déjà archivée.
 */
export function archivesWhenIdle(session: Pick<Session, 'config' | 'takenOverById' | 'parentSessionId' | 'archivedAt' | 'kind'>): boolean {
  if (session.config?.[AUTO_ARCHIVE_KEY] !== true) return false;
  if (session.takenOverById || session.parentSessionId || session.archivedAt) return false;
  return session.kind !== 'chat';
}
