import { gql } from '@apollo/client';

/**
 * Livraisons d'un projet : « Livrer » une branche (base fusionnée, push, PR, CI verte, fusion) et déploiements
 * (commande du projet sous verrou, après CI verte de la branche principale). Voir backend/src/deliveries.
 */

export type DeliveryKind = 'MERGE' | 'DEPLOY';
export type DeliveryStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CONFLICT' | 'CANCELLED';

export interface DeliveryStep {
  at: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
}

export interface Delivery {
  id: string;
  projectId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  requestedBy: { id: string; name: string } | null;
  joinedBy: { id: string; name: string }[];
  session: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
  worksessionId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  sha: string | null;
  steps: DeliveryStep[];
  output: string | null;
  error: string | null;
  cancellable: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  qualityTasks: DeliveryQualityTask[];
}

/** Tâche qualité (bug, régression…) rattachée à une livraison : calculée, ou corrigée à la main. */
export interface DeliveryQualityTask {
  task: { id: string; title: string; status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'; tags: string[]; createdAt: string } | null;
  source: 'AUTO' | 'MANUAL';
  linkedBy: { id: string; name: string } | null;
  linkedAt: string;
}

export interface DeliveryQualitySettings {
  tags: string[];
  windowHours: number;
  custom: boolean;
  updatedBy: { id: string; name: string } | null;
  updatedAt: string | null;
}

export interface DeliveryQualityLine {
  deliveries: number;
  deliveriesWithQualityTasks: number;
  qualityTasks: number;
  regressionRate: number | null;
}

export interface DeliveryQualityReport extends DeliveryQualityLine {
  since: string;
  settings: DeliveryQualitySettings;
  byAuthor: (DeliveryQualityLine & { user: { id: string; name: string } | null; isAgent: boolean; pullRequests: number })[];
}

export interface DeployConfig {
  vaultItem: string;
  command: string;
  branch: string | null;
  timeoutMinutes: number;
  updatedBy: { id: string; name: string } | null;
  updatedAt: string;
}

export interface CiStatus {
  ref: string;
  sha: string;
  state: string | null;
  verdict: 'success' | 'failure' | 'pending' | 'none';
  checks: { name: string; state: string; url: string | null }[];
}

export const DELIVERY_ACTIVE: DeliveryStatus[] = ['QUEUED', 'RUNNING'];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, { label: string; variant: string }> = {
  QUEUED: { label: 'en attente', variant: 'secondary' },
  RUNNING: { label: 'en cours', variant: 'info' },
  SUCCEEDED: { label: 'réussie', variant: 'success' },
  FAILED: { label: 'en échec', variant: 'danger' },
  CONFLICT: { label: 'conflit', variant: 'warning' },
  CANCELLED: { label: 'annulée', variant: 'secondary' },
};

const DELIVERY_FIELDS = gql`
  fragment DeliveryFields on Delivery {
    id
    projectId
    kind
    status
    requestedBy {
      id
      name
    }
    joinedBy {
      id
      name
    }
    session {
      id
      name
    }
    task {
      id
      title
    }
    worksessionId
    branch
    prNumber
    prUrl
    sha
    steps {
      at
      message
      level
    }
    output
    error
    cancellable
    createdAt
    startedAt
    finishedAt
    durationSeconds
    qualityTasks {
      task {
        id
        title
        status
        tags
        createdAt
      }
      source
      linkedBy {
        id
        name
      }
      linkedAt
    }
  }
`;

export const DELIVERIES = gql`
  ${DELIVERY_FIELDS}
  query Deliveries($projectId: ID!, $worksessionId: ID, $taskId: ID, $kind: String, $limit: Int) {
    deliveries(projectId: $projectId, worksessionId: $worksessionId, taskId: $taskId, kind: $kind, limit: $limit) {
      ...DeliveryFields
    }
  }
`;

export const DEPLOY_CONFIG = gql`
  query DeployConfig($projectId: ID!) {
    deployConfig(projectId: $projectId) {
      vaultItem
      command
      branch
      timeoutMinutes
      updatedBy {
        id
        name
      }
      updatedAt
    }
  }
`;

export const CI_STATUS = gql`
  query CiStatus($projectId: ID!, $ref: String) {
    ciStatus(projectId: $projectId, ref: $ref) {
      ref
      sha
      state
      verdict
      checks {
        name
        state
        url
      }
    }
  }
`;

export const DELIVERIES_PROJECT = gql`
  query DeliveriesProject($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      gitUrl
      gitBranch
    }
  }
`;

export const DELIVER = gql`
  ${DELIVERY_FIELDS}
  mutation Deliver($sessionId: ID, $taskId: ID, $deploy: Boolean) {
    deliver(sessionId: $sessionId, taskId: $taskId, deploy: $deploy) {
      ...DeliveryFields
    }
  }
`;

export const REQUEST_DEPLOY = gql`
  ${DELIVERY_FIELDS}
  mutation RequestDeploy($projectId: ID!) {
    requestDeploy(projectId: $projectId) {
      ...DeliveryFields
    }
  }
`;

export const CANCEL_DELIVERY = gql`
  ${DELIVERY_FIELDS}
  mutation CancelDelivery($id: ID!) {
    cancelDelivery(id: $id) {
      ...DeliveryFields
    }
  }
`;

export const SET_DEPLOY_CONFIG = gql`
  mutation SetDeployConfig($projectId: ID!, $input: DeployConfigInput) {
    setDeployConfig(projectId: $projectId, input: $input) {
      vaultItem
      command
      branch
      timeoutMinutes
      updatedAt
    }
  }
`;

export type DeliveryPolicyMode = 'MANUAL' | 'AUTO_MERGE';

export interface DeliveryPolicy {
  rules: { tag: string; mode: DeliveryPolicyMode }[];
  /** Compte avec lequel Skipper fusionne : l'administrateur qui a enregistré la politique. */
  mergeUser: { id: string; name: string } | null;
  updatedAt: string;
}

export const DELIVERY_POLICY = gql`
  query DeliveryPolicy($projectId: ID!) {
    deliveryPolicy(projectId: $projectId) {
      rules {
        tag
        mode
      }
      mergeUser {
        id
        name
      }
      updatedAt
    }
  }
`;

const QUALITY_SETTINGS_FIELDS = gql`
  fragment DeliveryQualitySettingsFields on DeliveryQualitySettings {
    tags
    windowHours
    custom
    updatedBy {
      id
      name
    }
    updatedAt
  }
`;

export const DELIVERY_QUALITY_REPORT = gql`
  ${QUALITY_SETTINGS_FIELDS}
  query DeliveryQualityReport($projectId: ID!, $days: Int) {
    deliveryQualityReport(projectId: $projectId, days: $days) {
      since
      settings {
        ...DeliveryQualitySettingsFields
      }
      deliveries
      deliveriesWithQualityTasks
      qualityTasks
      regressionRate
      byAuthor {
        user {
          id
          name
        }
        isAgent
        pullRequests
        deliveries
        deliveriesWithQualityTasks
        qualityTasks
        regressionRate
      }
    }
  }
`;

export const SET_DELIVERY_QUALITY_SETTINGS = gql`
  ${QUALITY_SETTINGS_FIELDS}
  mutation SetDeliveryQualitySettings($projectId: ID!, $tags: [String!], $windowHours: Int, $reset: Boolean) {
    setDeliveryQualitySettings(projectId: $projectId, tags: $tags, windowHours: $windowHours, reset: $reset) {
      ...DeliveryQualitySettingsFields
    }
  }
`;

export const BACKFILL_DELIVERY_QUALITY_TASKS = gql`
  mutation BackfillDeliveryQualityTasks($projectId: ID!) {
    backfillDeliveryQualityTasks(projectId: $projectId)
  }
`;

/** Rattachement d'une tâche à une livraison (fiche de la tâche). */
export const TASK_QUALITY_DELIVERY = gql`
  query TaskQualityDelivery($taskId: ID!, $projectId: ID!) {
    task(id: $taskId) {
      id
      tags
      qualityDelivery {
        source
        linkedBy {
          id
          name
        }
        linkedAt
        delivery {
          id
          kind
          sha
          branch
          prNumber
          createdAt
          finishedAt
        }
      }
    }
    deliveryQualitySettings(projectId: $projectId) {
      tags
      windowHours
    }
  }
`;

export interface TaskQualityDelivery {
  id: string;
  tags: string[];
  qualityDelivery: {
    source: 'AUTO' | 'MANUAL';
    linkedBy: { id: string; name: string } | null;
    linkedAt: string;
    delivery: Pick<Delivery, 'id' | 'kind' | 'sha' | 'branch' | 'prNumber' | 'createdAt' | 'finishedAt'> | null;
  } | null;
}

export const SET_TASK_DELIVERY = gql`
  mutation SetTaskDelivery($taskId: ID!, $deliveryId: ID, $reset: Boolean) {
    setTaskDelivery(taskId: $taskId, deliveryId: $deliveryId, reset: $reset) {
      id
      qualityDelivery {
        source
        linkedAt
        delivery {
          id
        }
      }
    }
  }
`;

export const SET_DELIVERY_POLICY = gql`
  mutation SetDeliveryPolicy($projectId: ID!, $rules: [DeliveryPolicyRuleInput!]!) {
    setDeliveryPolicy(projectId: $projectId, rules: $rules) {
      rules {
        tag
        mode
      }
      mergeUser {
        id
        name
      }
      updatedAt
    }
  }
`;

/** Étiquette comparable (minuscules, sans accents), comme le backend (deliveries/quality.ts). */
export const normalizeQualityTag = (tag: string) =>
  tag
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
