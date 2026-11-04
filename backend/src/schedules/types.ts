import type { SessionCleanup } from '../sessions/types.js';

/**
 * Archivage automatique des sessions d'exécution (chaque exécution a sa propre session) : dès la fin de
 * l'exécution, les précédentes au lancement d'une nouvelle (défaut), un délai après la fin, ou jamais.
 */
export type ScheduleArchivePolicy = 'on_finish' | 'previous_on_run' | 'after_delay' | 'never';
export const SCHEDULE_ARCHIVE_POLICIES: ScheduleArchivePolicy[] = ['on_finish', 'previous_on_run', 'after_delay', 'never'];
export const DEFAULT_ARCHIVE_POLICY: ScheduleArchivePolicy = 'previous_on_run';

/**
 * Planification portée par une session : à chaque échéance de l'expression cron, une nouvelle session est créée
 * (mêmes projet, propriétaire, provider et réglages que la session de la planification) et reçoit l'instruction.
 */
export interface SessionSchedule {
  /** Session de la planification : elle porte les réglages des exécutions, et n'exécute rien elle-même. */
  sessionId: string;
  /** Nom de la planification (« Revue quotidienne Curso ») ; null : celui de la session. */
  name: string | null;
  /** Cinq champs : minute heure jour mois jour-de-semaine (ou alias @daily, @hourly...). */
  cron: string;
  /** Fuseau IANA dans lequel l'expression est interprétée. */
  timezone: string;
  /** Instruction envoyée à la session à chaque exécution. */
  prompt: string;
  enabled: boolean;
  /** Terminer la session d'une exécution à la fin de son tour (sinon elle reste ouverte aux instructions). */
  endAfterRun: boolean;
  /** Archivage automatique des sessions d'exécution. */
  archivePolicy: ScheduleArchivePolicy;
  /** Délai avant archivage après la fin d'une exécution (`after_delay`), en minutes. */
  archiveAfterMinutes: number | null;
  /**
   * Outils pré-autorisés pour les seules exécutions de la planification (règles au format Claude Code :
   * `Bash(git status *)`, `mcp__vault__sql_query(production)`…). Hors exécution planifiée, ils ne valent rien.
   */
  allowedTools: string[];
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Compte rendu texte de la dernière exécution (gardé pour compatibilité ; l'historique est dans `ScheduleRun`). */
  lastResult: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionScheduleInput {
  /** Nom de la planification (vide : celui de la session). Absent : inchangé. */
  name?: string | null;
  cron: string;
  timezone?: string | null;
  prompt: string;
  enabled?: boolean | null;
  endAfterRun?: boolean | null;
  /** Archivage des sessions d'exécution (absent : inchangé ; défaut à la création : previous_on_run). */
  archivePolicy?: ScheduleArchivePolicy | null;
  /** Délai en minutes pour `after_delay`. */
  archiveAfterMinutes?: number | null;
  /** Outils pré-autorisés pour les exécutions (absent ou null : inchangés). */
  allowedTools?: string[] | null;
  /** Réglage de nettoyage de la session, enregistré en même temps (null ou absent : inchangé). */
  cleanup?: SessionCleanup | null;
}

/** Ce qui a déclenché une exécution : l'échéance, ou « Exécuter maintenant ». */
export type ScheduleRunTrigger = 'schedule' | 'manual';

/**
 * Issue d'une exécution. `blocked` : l'agent n'a pas pu faire son travail faute d'autorisation (outil refusé,
 * demande restée sans réponse) ; `timeout` : toujours au travail après le délai d'attente ; `skipped` : échéance
 * ignorée (agent occupé, budget, maintenance) ; `missed` : échéance passée pendant un arrêt du serveur.
 */
export type ScheduleRunStatus = 'running' | 'done' | 'blocked' | 'failed' | 'timeout' | 'skipped' | 'missed';

export interface ScheduleRun {
  id: string;
  /** Session de la planification. */
  sessionId: string;
  /** Session créée pour cette exécution (null : exécution d'avant, jouée dans la session de la planification, ou ignorée). */
  runSessionId: string | null;
  trigger: ScheduleRunTrigger;
  triggeredBy: string | null;
  status: ScheduleRunStatus;
  scheduledFor: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  costUsd: number | null;
  durationMs: number | null;
  message: string | null;
  /** Début de la dernière réponse de l'agent pendant l'exécution. */
  answer: string | null;
  startEventId: string | null;
}

/** Planification et session, pour la liste des planifications. */
export interface ScheduleWithSession extends SessionSchedule {
  projectId: string;
}
