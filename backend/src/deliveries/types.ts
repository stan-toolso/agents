/** Livraison d'un projet : fusion d'une branche sur la base (« merge ») ou mise en production (« deploy »). */
export type DeliveryKind = 'merge' | 'deploy';
export type DeliveryStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'cancelled';
export const DELIVERY_ACTIVE: DeliveryStatus[] = ['queued', 'running'];

export interface DeliveryStep {
  at: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  /** Étape « commande » d'un déploiement : une fois lancée, la livraison ne s'annule plus. */
  phase?: 'command';
}

export interface Delivery {
  id: string;
  projectId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  requestedById: string | null;
  /** Personnes qui ont rejoint ce déploiement pendant qu'il attendait (lot). */
  joinedByIds: string[];
  sessionId: string | null;
  worksessionId: string | null;
  taskId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  sha: string | null;
  steps: DeliveryStep[];
  output: string | null;
  error: string | null;
  instanceId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Commande de déploiement d'un projet, lancée sur un serveur SSH du coffre. */
export interface DeployConfig {
  projectId: string;
  /** Nom de l'élément SSH du coffre du projet. */
  vaultItem: string;
  /** Commande ; `{sha}` et `{branch}` sont remplacés par le commit vérifié et sa branche. */
  command: string;
  /** Branche dont la CI doit être verte (null : branche principale du projet). */
  branch: string | null;
  timeoutMinutes: number;
  updatedById: string | null;
  updatedAt: Date;
}

export interface DeployConfigInput {
  vaultItem: string;
  command: string;
  branch?: string | null;
  timeoutMinutes?: number | null;
}
