import { gql } from '@apollo/client';
import { USER_FIELDS } from './operations';

export const SEARCH = gql`
  query Search($query: String!, $kinds: [SearchKind!], $limit: Int) {
    search(query: $query, kinds: $kinds, limit: $limit) {
      query
      groups {
        kind
        total
        hits {
          kind
          id
          title
          detail
          projectId
          projectName
          outsideProjects
          worksessionBranch
          status
          activity
          updatedAt
        }
      }
    }
  }
`;

export const USERS = gql`
  ${USER_FIELDS}
  query Users {
    users {
      ...UserFields
    }
  }
`;

export const INVITE_USER = gql`
  ${USER_FIELDS}
  mutation InviteUser($email: String!, $isAdmin: Boolean) {
    inviteUser(email: $email, isAdmin: $isAdmin) {
      ...UserFields
    }
  }
`;

export const SET_USER_ADMIN = gql`
  ${USER_FIELDS}
  mutation SetUserAdmin($userId: ID!, $isAdmin: Boolean!) {
    setUserAdmin(userId: $userId, isAdmin: $isAdmin) {
      ...UserFields
    }
  }
`;

export const SET_USER_SUPER_ADMIN = gql`
  ${USER_FIELDS}
  mutation SetUserSuperAdmin($userId: ID!, $isSuperAdmin: Boolean!) {
    setUserSuperAdmin(userId: $userId, isSuperAdmin: $isSuperAdmin) {
      ...UserFields
    }
  }
`;

export const DELETE_USER = gql`
  mutation DeleteUser($userId: ID!) {
    deleteUser(userId: $userId)
  }
`;

export const PUSH_PUBLIC_KEY = gql`
  query PushPublicKey {
    pushPublicKey
  }
`;

export const SUBSCRIBE_PUSH = gql`
  mutation SubscribePush($input: PushSubscriptionInput!) {
    subscribePush(input: $input)
  }
`;

export const UNSUBSCRIBE_PUSH = gql`
  mutation UnsubscribePush($endpoint: String!) {
    unsubscribePush(endpoint: $endpoint)
  }
`;

export const SEND_TEST_PUSH = gql`
  mutation SendTestPush {
    sendTestPush
  }
`;

export interface SharedPage {
  id: string;
  title: string;
  description: string | null;
  owner: { id: string; name: string; email: string };
  linkAccess: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  members: { user: { id: string; name: string; email: string }; addedBy: { id: string; name: string } | null; addedAt: string }[];
  versions: { version: number; size: number; createdBy: { id: string; name: string } | null; createdAt: string }[];
  project: { id: string; name: string } | null;
  session: { id: string; name: string } | null;
  sourcePath: string | null;
  viewerAccess: { owner: boolean; member: boolean };
  /** Commentaires non traités. */
  openComments: number;
}

/** Élément de la page visé par un commentaire (choisi en cliquant dans la page). */
export interface SharedPageAnchor {
  selector: string;
  text: string | null;
  tag: string | null;
}

/** Commentaire d'une page partagée : racine (micro-conversation avec `replies`, état traité) ou réponse. */
export interface SharedPageComment {
  id: string;
  author: { id: string; name: string };
  viaAgent: boolean;
  body: string;
  anchor: SharedPageAnchor | null;
  version: number;
  resolved: boolean;
  resolvedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  replies: SharedPageComment[];
}

export const SHARED_PAGE_FIELDS = gql`
  fragment SharedPageFields on SharedPage {
    id
    title
    description
    owner {
      id
      name
      email
    }
    linkAccess
    version
    createdAt
    updatedAt
    members {
      user {
        id
        name
        email
      }
      addedBy {
        id
        name
      }
      addedAt
    }
    versions {
      version
      size
      createdBy {
        id
        name
      }
      createdAt
    }
    project {
      id
      name
    }
    session {
      id
      name
    }
    sourcePath
    viewerAccess {
      owner
      member
    }
    openComments
  }
`;

export const SHARED_PAGE_COMMENT_FIELDS = gql`
  fragment SharedPageCommentFields on SharedPageComment {
    id
    author {
      id
      name
    }
    viaAgent
    body
    anchor {
      selector
      text
      tag
    }
    version
    resolved
    resolvedBy {
      id
      name
    }
    resolvedAt
    createdAt
    updatedAt
  }
`;

/** Commentaires d'une page, avec leurs réponses (sondés à part de la page, plus souvent). */
export const SHARED_PAGE_COMMENTS = gql`
  ${SHARED_PAGE_COMMENT_FIELDS}
  query SharedPageComments($id: ID!) {
    sharedPage(id: $id) {
      id
      version
      openComments
      comments {
        ...SharedPageCommentFields
        replies {
          ...SharedPageCommentFields
        }
      }
    }
  }
`;

export const ADD_SHARED_PAGE_COMMENT = gql`
  mutation AddSharedPageComment($pageId: ID!, $body: String!, $anchor: SharedPageAnchorInput, $version: Int) {
    addSharedPageComment(pageId: $pageId, body: $body, anchor: $anchor, version: $version) {
      id
    }
  }
`;

export const REPLY_SHARED_PAGE_COMMENT = gql`
  mutation ReplySharedPageComment($commentId: ID!, $body: String!) {
    replySharedPageComment(commentId: $commentId, body: $body) {
      id
    }
  }
`;

export const UPDATE_SHARED_PAGE_COMMENT = gql`
  mutation UpdateSharedPageComment($id: ID!, $body: String!) {
    updateSharedPageComment(id: $id, body: $body) {
      id
      body
      updatedAt
    }
  }
`;

export const RESOLVE_SHARED_PAGE_COMMENT = gql`
  mutation ResolveSharedPageComment($id: ID!, $resolved: Boolean!) {
    resolveSharedPageComment(id: $id, resolved: $resolved) {
      id
      resolved
      resolvedAt
      resolvedBy {
        id
        name
      }
    }
  }
`;

export const REQUEST_SHARED_PAGE_UPDATE = gql`
  mutation RequestSharedPageUpdate($id: ID!, $instruction: String, $withComments: Boolean) {
    requestSharedPageUpdate(id: $id, instruction: $instruction, withComments: $withComments) {
      id
      name
    }
  }
`;

export const DELETE_SHARED_PAGE_COMMENT = gql`
  mutation DeleteSharedPageComment($id: ID!) {
    deleteSharedPageComment(id: $id)
  }
`;

export const SHARED_PAGES = gql`
  ${SHARED_PAGE_FIELDS}
  query SharedPages {
    sharedPages {
      ...SharedPageFields
    }
  }
`;

export const SHARED_PAGE = gql`
  ${SHARED_PAGE_FIELDS}
  query SharedPage($id: ID!) {
    sharedPage(id: $id) {
      ...SharedPageFields
    }
  }
`;

export const PUBLISH_SHARED_PAGE = gql`
  ${SHARED_PAGE_FIELDS}
  mutation PublishSharedPage($projectId: ID!, $worksessionId: ID, $path: String!, $title: String!, $pageId: ID) {
    publishSharedPage(projectId: $projectId, worksessionId: $worksessionId, path: $path, title: $title, pageId: $pageId) {
      ...SharedPageFields
    }
  }
`;

export const UPDATE_SHARED_PAGE = gql`
  ${SHARED_PAGE_FIELDS}
  mutation UpdateSharedPage($id: ID!, $input: SharedPageInput!) {
    updateSharedPage(id: $id, input: $input) {
      ...SharedPageFields
    }
  }
`;

export const ADD_SHARED_PAGE_MEMBER = gql`
  ${SHARED_PAGE_FIELDS}
  mutation AddSharedPageMember($id: ID!, $email: String!) {
    addSharedPageMember(id: $id, email: $email) {
      ...SharedPageFields
    }
  }
`;

export const REMOVE_SHARED_PAGE_MEMBER = gql`
  ${SHARED_PAGE_FIELDS}
  mutation RemoveSharedPageMember($id: ID!, $userId: ID!) {
    removeSharedPageMember(id: $id, userId: $userId) {
      ...SharedPageFields
    }
  }
`;

export const DELETE_SHARED_PAGE = gql`
  mutation DeleteSharedPage($id: ID!) {
    deleteSharedPage(id: $id)
  }
`;

/** Famille de notifications qu'une personne reçoit ou non en push (et en notification du navigateur). */
export interface PushCategory {
  key: string;
  label: string;
  description: string;
  types: string[];
  enabled: boolean;
  adminsOnly: boolean;
}

export const PUSH_PREFERENCES = gql`
  query PushPreferences {
    pushPreferences {
      key
      label
      description
      types
      enabled
      adminsOnly
    }
  }
`;

export const SET_PUSH_PREFERENCE = gql`
  mutation SetPushPreference($category: String!, $enabled: Boolean!) {
    setPushPreference(category: $category, enabled: $enabled) {
      key
      label
      description
      types
      enabled
      adminsOnly
    }
  }
`;

export interface NotificationChannel {
  id: string;
  projectId: string | null;
  userId: string | null;
  kind: 'slack' | 'discord' | 'email';
  targetHint: string;
  categories: string[];
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const CHANNEL_FIELDS = gql`
  fragment NotificationChannelFields on NotificationChannel {
    id
    projectId
    userId
    kind
    targetHint
    categories
    enabled
    lastSentAt
    lastError
    createdAt
  }
`;

export const MY_NOTIFICATION_CHANNELS = gql`
  query MyNotificationChannels {
    myNotificationChannels {
      ...NotificationChannelFields
    }
    emailNotificationsAvailable
  }
  ${CHANNEL_FIELDS}
`;

export const PROJECT_NOTIFICATION_CHANNELS = gql`
  query ProjectNotificationChannels($projectId: ID!) {
    projectNotificationChannels(projectId: $projectId) {
      ...NotificationChannelFields
    }
    emailNotificationsAvailable
  }
  ${CHANNEL_FIELDS}
`;

export const CREATE_NOTIFICATION_CHANNEL = gql`
  mutation CreateNotificationChannel($input: NotificationChannelInput!) {
    createNotificationChannel(input: $input) {
      ...NotificationChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

export const UPDATE_NOTIFICATION_CHANNEL = gql`
  mutation UpdateNotificationChannel($id: ID!, $patch: NotificationChannelPatch!) {
    updateNotificationChannel(id: $id, patch: $patch) {
      ...NotificationChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

export const DELETE_NOTIFICATION_CHANNEL = gql`
  mutation DeleteNotificationChannel($id: ID!) {
    deleteNotificationChannel(id: $id)
  }
`;

export const TEST_NOTIFICATION_CHANNEL = gql`
  mutation TestNotificationChannel($id: ID!) {
    testNotificationChannel(id: $id) {
      ...NotificationChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

export interface SmtpSettings {
  source: 'env' | 'settings' | 'none';
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
}

const SMTP_FIELDS = gql`
  fragment SmtpSettingsFields on SmtpSettings {
    source
    host
    port
    secure
    user
    from
    hasPassword
  }
`;

export const SMTP_SETTINGS = gql`
  query SmtpSettings {
    smtpSettings {
      ...SmtpSettingsFields
    }
  }
  ${SMTP_FIELDS}
`;

export const UPDATE_SMTP_SETTINGS = gql`
  mutation UpdateSmtpSettings($input: SmtpSettingsInput!) {
    updateSmtpSettings(input: $input) {
      ...SmtpSettingsFields
    }
  }
  ${SMTP_FIELDS}
`;

export const CLEAR_SMTP_SETTINGS = gql`
  mutation ClearSmtpSettings {
    clearSmtpSettings {
      ...SmtpSettingsFields
    }
  }
  ${SMTP_FIELDS}
`;

export const SEND_TEST_EMAIL = gql`
  mutation SendTestEmail {
    sendTestEmail
  }
`;
