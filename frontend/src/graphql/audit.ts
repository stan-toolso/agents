import { gql } from '@apollo/client';

export type AuditActorKind = 'HUMAN' | 'AGENT' | 'SYSTEM';

export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  actionLabel: string;
  targetType: string;
  targetTypeLabel: string;
  targetId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown>;
  actorKind: AuditActorKind;
  actor: { id: string; name: string | null; email: string; avatarUrl?: string | null } | null;
  sessionId: string | null;
  actorLabel: string | null;
}

export interface AuditOption {
  value: string;
  label: string;
}

export interface AuditFacets {
  actors: { id: string; name: string | null; email: string }[];
  targetTypes: AuditOption[];
  actions: AuditOption[];
}

export interface AuditFilterInput {
  actorUserId?: string | null;
  actorKind?: AuditActorKind | null;
  targetType?: string | null;
  action?: string | null;
  from?: string | null;
  to?: string | null;
}

export const AUDIT_PROJECT = gql`
  query AuditProject($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
    }
    auditFacets(projectId: $id) {
      actors {
        id
        name
        email
      }
      targetTypes {
        value
        label
      }
      actions {
        value
        label
      }
    }
  }
`;

export const AUDIT_LOG = gql`
  query AuditLog($projectId: ID!, $filter: AuditFilterInput, $limit: Int, $before: ID) {
    auditLog(projectId: $projectId, filter: $filter, limit: $limit, before: $before) {
      id
      createdAt
      action
      actionLabel
      targetType
      targetTypeLabel
      targetId
      targetLabel
      details
      actorKind
      actor {
        id
        name
        email
      }
      sessionId
      actorLabel
    }
  }
`;
