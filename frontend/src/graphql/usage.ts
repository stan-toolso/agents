import { gql } from '@apollo/client';

/** Relevé de consommation (Query.usageReport) : coûts dans l'unité d'affichage (formatCost). */
export interface UsageReportDay {
  day: string;
  usd: number;
  turns: number;
}
export interface UsageReportProject {
  projectId: string | null;
  projectName: string;
  isPersonal: boolean;
  usd: number;
  turns: number;
  sessions: number;
  monthUsd: number;
  monthlyBudgetUsd: number | null;
}
export interface UsageReportModel {
  model: string;
  usd: number;
  turns: number;
}
export interface UsageReportSession {
  sessionId: string | null;
  sessionName: string | null;
  projectId: string | null;
  projectName: string | null;
  ownerName: string | null;
  usd: number;
  turns: number;
}
export interface UsageReport {
  from: string;
  to: string;
  days: number;
  usd: number;
  turns: number;
  sessions: number;
  byProject: UsageReportProject[];
  byModel: UsageReportModel[];
  byDay: UsageReportDay[];
  byWeek: UsageReportDay[];
  topSessions: UsageReportSession[];
}

export const USAGE_REPORT = gql`
  query UsageReport($projectId: ID, $days: Int) {
    usageReport(projectId: $projectId, days: $days) {
      from
      to
      days
      usd
      turns
      sessions
      byProject {
        projectId
        projectName
        isPersonal
        usd
        turns
        sessions
        monthUsd
        monthlyBudgetUsd
      }
      byModel {
        model
        usd
        turns
      }
      byDay {
        day
        usd
        turns
      }
      byWeek {
        day
        usd
        turns
      }
      topSessions {
        sessionId
        sessionName
        projectId
        projectName
        ownerName
        usd
        turns
      }
    }
  }
`;

/** Ce que l'onglet Consommation d'un projet doit savoir du projet (en-tête commun, budget). */
export const USAGE_PROJECT = gql`
  query UsageProject($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      monthlyBudgetUsd
      monthUsd
    }
  }
`;

export const SET_PROJECT_BUDGET = gql`
  mutation SetProjectBudget($projectId: ID!, $monthlyBudgetUsd: Float) {
    setProjectBudget(projectId: $projectId, monthlyBudgetUsd: $monthlyBudgetUsd) {
      id
      monthlyBudgetUsd
      monthUsd
    }
  }
`;
