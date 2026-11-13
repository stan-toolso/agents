/**
 * Archivage automatique des sessions d'exécution (chaque exécution a sa propre session) : dès la fin de
 * l'exécution, les précédentes au lancement d'une nouvelle (défaut), un délai après la fin, ou jamais.
 */
export type ScheduleArchivePolicy = 'on_finish' | 'previous_on_run' | 'after_delay' | 'never';
export const SCHEDULE_ARCHIVE_POLICIES: ScheduleArchivePolicy[] = ['on_finish', 'previous_on_run', 'after_delay', 'never'];
export const DEFAULT_ARCHIVE_POLICY: ScheduleArchivePolicy = 'previous_on_run';

/**
 * Planification : objet à part entière, rattaché à un projet. À chaque échéance de l'expression cron, elle lance une
 * nouvelle session indépendante (son propre dossier de travail) avec ses réglages, qui reçoit l'instruction.
 */
export interface SessionSchedule {
  id: string;
  projectId: string;
  /** Propriétaire des sessions d'exécution (personne ou agent de projet) : ses comptes, son budget. */
  ownerId: string | null;
  /** Personne qui a demandé la planification quand le propriétaire est un agent. */
  requestedById: string | null;
  /** Provider des sessions d'exécution (claude, opencode…). */
  provider: string;
  /** Réglages du provider copiés dans chaque session d'exécution (mode d'autorisation, modèle…). */
  config: Record<string, unknown>;
  /** Nom de la planification (« Revue quotidienne Curso ») ; null : déduit de l'instruction. */
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
  /** Plafond de coût d'une exécution en USD (null : aucun) : atteint, la session de l'exécution est arrêtée. */
  maxRunUsd: number | null;
  /** Budget mensuel de la planification en USD (null : aucun) : atteint, les échéances sont ignorées jusqu'au mois suivant. */
  monthlyBudgetUsd: number | null;
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
  /** Réglages du provider fusionnés à ceux de la planification (mode d'autorisation, modèle ; valeur vide : retirée). Absent : inchangés. */
  config?: Record<string, unknown> | null;
  /** Plafond de coût d'une exécution, en USD (absent : inchangé ; null ou 0 : retiré). */
  maxRunUsd?: number | null;
  /** Budget mensuel, en USD (absent : inchangé ; null ou 0 : retiré). */
  monthlyBudgetUsd?: number | null;
}

/** Nouvelle planification : son projet, son provider et ses réglages. */
export interface CreateScheduleInput extends SessionScheduleInput {
  projectId: string;
  name: string;
  provider?: string | null;
  /** Lance une première exécution tout de suite. */
  runNow?: boolean | null;
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
  scheduleId: string;
  /** Session créée pour cette exécution (null : ignorée, manquée, ou session non créée). */
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
