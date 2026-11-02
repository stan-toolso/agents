import { gql } from '@apollo/client';
import { CONVERSATION_FIELDS, type Conversation } from './conversations';
import { REQUEST_FIELDS, SESSION_FIELDS, TASK_FIELDS, type DashboardCounts, type DashboardUsage, type HumanRequest, type Session, type Task } from './operations';
import { TRACKED_PULL_REQUEST_FIELDS, type TrackedPullRequest } from './pullRequests';

/** Un membre du projet (personne ou agent) et ce qu'il fait. */
export interface ProjectTeamMember {
  user: { id: string; name: string; email: string; kind: 'PERSON' | 'AGENT'; lastLoginAt: string | null };
  agent: { id: string; name: string; kind: 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM'; description: string; avatar: { emoji: string | null; color: string | null } } | null;
  sessions: Pick<Session, 'id' | 'name' | 'status' | 'activity' | 'pendingRequestCount'>[];
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'statusTag'>[];
  lastActivityAt: string | null;
}

export interface ProjectSchedule {
  sessionId: string;
  name: string;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  session: { id: string; name: string; owner: { id: string; name: string } | null };
}

export interface ProjectDashboard {
  generatedAt: string;
  counts: DashboardCounts;
  usage: DashboardUsage;
  pendingRequests: HumanRequest[];
  runningSessions: Session[];
  recentSessions: Session[];
  attentionTasks: Task[];
  pullRequests: TrackedPullRequest[];
  mergedPullRequests: TrackedPullRequest[];
  staleTasks: Task[];
  schedules: ProjectSchedule[];
  general: Conversation | null;
  team: ProjectTeamMember[];
  tasks: Task[];
}

/** Tableau de bord d'un projet (onglet « Tableau de bord »), rafraîchi régulièrement. */
export const PROJECT_DASHBOARD = gql`
  ${SESSION_FIELDS}
  ${REQUEST_FIELDS}
  ${TASK_FIELDS}
  ${TRACKED_PULL_REQUEST_FIELDS}
  ${CONVERSATION_FIELDS}
  query ProjectDashboard($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      gitUrl
      git {
        branch
        commit
      }
    }
    projectDashboard(id: $id) {
      generatedAt
      counts {
        pendingRequests
        busySessions
        idleSessions
        failedSessions24h
        endedSessions24h
        todoTasks
        inProgressTasks
        overdueTasks
        doneTasks7d
        unreadNotifications
        openPullRequests
        pendingPullRequests
      }
      usage {
        monthStart
        monthUsd
        globalMonthUsd
        monthlyBudgetUsd
        todayUsd
        last7DaysUsd
        previous7DaysUsd
        byDay {
          day
          usd
        }
        topSessions {
          sessionId
          sessionName
          projectName
          usd
        }
        rateLimits {
          updatedAt
          status
          rateLimitType
          rateLimitLabel
          resetsAt
          overageStatus
          overageDisabledReason
          isUsingOverage
          windows {
            type
            label
            utilization
            resetsAt
            observedAt
          }
        }
      }
      pendingRequests {
        ...RequestFields
      }
      runningSessions {
        ...SessionFields
      }
      recentSessions {
        ...SessionFields
      }
      attentionTasks {
        ...TaskFields
      }
      pullRequests {
        ...TrackedPullRequestFields
      }
      mergedPullRequests {
        ...TrackedPullRequestFields
      }
      staleTasks {
        ...TaskFields
      }
      schedules {
        sessionId
        name
        cron
        enabled
        nextRunAt
        lastRunAt
        lastResult
        session {
          id
          name
          owner {
            id
            name
          }
        }
      }
      general {
        ...ConversationFields
      }
      team {
        user {
          id
          name
          email
          kind
          lastLoginAt
        }
        agent {
          id
          name
          kind
          description
          avatar {
            emoji
            color
          }
        }
        sessions {
          id
          name
          status
          activity
          pendingRequestCount
        }
        tasks {
          id
          title
          status
          statusTag
        }
        lastActivityAt
      }
      tasks {
        ...TaskFields
      }
    }
  }
`;
