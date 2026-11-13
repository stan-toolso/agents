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
  /** Artefact de données : intervalle du rafraîchissement automatique (null : à la demande). */
  refreshMinutes: number | null;
  /** Une source agent est en cours de calcul par une session. */
  refreshing: boolean;
  failingSources: number;
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
      refreshMinutes
      refreshing
      failingSources
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

// ---- Pages personnalisées et onglets d'un projet (lot 5) ---------------------------------------------------------------

export interface ProjectPageInfo {
  id: string;
  slug: string;
  title: string;
  icon: string | null;
  position: number;
}

export interface ProjectTabsSetting {
  hidden: string[];
  order: string[];
}

/** Onglets et pages d'un projet, lus par l'en-tête (cache partagé entre les pages du projet). */
export const PROJECT_TABS = gql`
  query ProjectTabs($id: ID!) {
    project(id: $id) {
      id
      gitUrl
      tabs
      pages {
        id
        slug
        title
        icon
        position
      }
    }
  }
`;

export const CREATE_PROJECT_PAGE = gql`
  mutation CreateProjectPage($projectId: ID!, $title: String!, $icon: String, $slug: String) {
    createProjectPage(projectId: $projectId, title: $title, icon: $icon, slug: $slug) {
      id
      slug
      title
      icon
      position
    }
  }
`;

export const UPDATE_PROJECT_PAGE = gql`
  mutation UpdateProjectPage($id: ID!, $title: String, $icon: String, $position: Int) {
    updateProjectPage(id: $id, title: $title, icon: $icon, position: $position) {
      id
      slug
      title
      icon
      position
    }
  }
`;

export const DELETE_PROJECT_PAGE = gql`
  mutation DeleteProjectPage($id: ID!) {
    deleteProjectPage(id: $id)
  }
`;

export const UPDATE_PROJECT_TABS = gql`
  mutation UpdateProjectTabs($projectId: ID!, $tabs: JSON!) {
    updateProjectTabs(projectId: $projectId, tabs: $tabs) {
      id
      tabs
    }
  }
`;
