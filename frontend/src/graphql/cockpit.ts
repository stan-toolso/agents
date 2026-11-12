import { gql } from '@apollo/client';
import type { Layout, ScopeKind, WidgetDef } from '../cockpit/types';

export interface CockpitLayoutData {
  scope: string;
  kind: ScopeKind;
  projectId: string | null;
  layout: Layout;
  version: number;
  isDefault: boolean;
  canEdit: boolean;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
  catalog: WidgetDef[];
}

export interface CockpitLayoutVersion {
  version: number;
  layout: Layout;
  reset: boolean;
  author: { id: string; name: string } | null;
  sessionId: string | null;
  note: string | null;
  createdAt: string;
}

export const COCKPIT_LAYOUT_FIELDS = gql`
  fragment CockpitLayoutFields on CockpitLayout {
    scope
    kind
    projectId
    layout
    version
    isDefault
    canEdit
    updatedAt
    updatedBy {
      id
      name
    }
    catalog {
      key
      label
      description
      region
      regions
      singleton
      params {
        key
        label
        type
        description
        min
        max
        options {
          value
          label
        }
        default
      }
    }
  }
`;

export const COCKPIT_LAYOUT = gql`
  ${COCKPIT_LAYOUT_FIELDS}
  query CockpitLayout($scope: String!) {
    cockpitLayout(scope: $scope) {
      ...CockpitLayoutFields
    }
  }
`;

export const COCKPIT_LAYOUT_HISTORY = gql`
  query CockpitLayoutHistory($scope: String!) {
    cockpitLayoutHistory(scope: $scope) {
      version
      layout
      reset
      author {
        id
        name
      }
      sessionId
      note
      createdAt
    }
  }
`;

export const UPDATE_COCKPIT_LAYOUT = gql`
  ${COCKPIT_LAYOUT_FIELDS}
  mutation UpdateCockpitLayout($scope: String!, $layout: JSON!, $note: String) {
    updateCockpitLayout(scope: $scope, layout: $layout, note: $note) {
      ...CockpitLayoutFields
    }
  }
`;

export const RESET_COCKPIT_LAYOUT = gql`
  ${COCKPIT_LAYOUT_FIELDS}
  mutation ResetCockpitLayout($scope: String!) {
    resetCockpitLayout(scope: $scope) {
      ...CockpitLayoutFields
    }
  }
`;

export const RESTORE_COCKPIT_LAYOUT = gql`
  ${COCKPIT_LAYOUT_FIELDS}
  mutation RestoreCockpitLayout($scope: String!, $version: Int!) {
    restoreCockpitLayout(scope: $scope, version: $version) {
      ...CockpitLayoutFields
    }
  }
`;
