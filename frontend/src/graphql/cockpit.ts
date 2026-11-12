import { gql } from '@apollo/client';
import type { Layout, ScopeKind, WidgetDef } from '../cockpit/types';

/** Un artefact épinglé, tel que la personne connectée le voit. */
export interface CockpitArtifactInfo {
  id: string;
  viewable: boolean;
  title: string | null;
  kind: 'PAGE' | 'DATA' | 'SLIDES' | null;
  version: number | null;
  dataRefreshedAt: string | null;
  linkAccess: boolean | null;
  projectAccess: boolean | null;
  owner: { id: string; name: string } | null;
  canManage: boolean;
}

/** Un artefact qu'on peut épingler (catalogue du mode « Personnaliser »). */
export interface PinnablePage {
  id: string;
  title: string;
  kind: 'PAGE' | 'DATA' | 'SLIDES';
  linkAccess: boolean;
  projectAccess: boolean;
  updatedAt: string;
  owner: { id: string; name: string };
  viewerAccess: { admin: boolean };
}

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
  artifacts: CockpitArtifactInfo[];
  warnings: string[];
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
    artifacts {
      id
      viewable
      title
      kind
      version
      dataRefreshedAt
      linkAccess
      projectAccess
      owner {
        id
        name
      }
      canManage
    }
    warnings
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

export const PIN_ARTIFACT_TO_COCKPIT = gql`
  ${COCKPIT_LAYOUT_FIELDS}
  mutation PinArtifactToCockpit($scope: String!, $artifactId: ID!, $region: String, $title: String) {
    pinArtifactToCockpit(scope: $scope, artifactId: $artifactId, region: $region, title: $title) {
      ...CockpitLayoutFields
    }
  }
`;

/** Artefacts épinglables : ceux du projet (visibles par la personne), ou les siens et ses favoris sur l'accueil. */
export const COCKPIT_PINNABLE_PAGES = gql`
  query CockpitPinnablePages($projectId: ID) {
    sharedPages(projectId: $projectId) {
      id
      title
      kind
      linkAccess
      projectAccess
      updatedAt
      owner {
        id
        name
      }
      viewerAccess {
        admin
      }
    }
  }
`;

export const OPEN_PAGE_TO_PROJECT = gql`
  mutation OpenSharedPageToProject($id: ID!) {
    updateSharedPage(id: $id, input: { projectAccess: true }) {
      id
      projectAccess
    }
  }
`;
