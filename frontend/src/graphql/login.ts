import { gql } from '@apollo/client';

export interface LoginIdentity {
  provider: string;
  email: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MyLoginMethods {
  email: string;
  hasPassword: boolean;
  passwordSetAt: string | null;
  passwordLoginEnabled: boolean;
  googleLinked: boolean;
  identities: LoginIdentity[];
  providers: { id: string; label: string; configured: boolean }[];
}

const FIELDS = gql`
  fragment MyLoginMethodsFields on MyLoginMethods {
    email
    hasPassword
    passwordSetAt
    passwordLoginEnabled
    googleLinked
    identities {
      provider
      email
      createdAt
      lastUsedAt
    }
    providers {
      id
      label
      configured
    }
  }
`;

export const MY_LOGIN_METHODS = gql`
  ${FIELDS}
  query MyLoginMethods {
    myLoginMethods {
      ...MyLoginMethodsFields
    }
  }
`;

export const SET_MY_PASSWORD = gql`
  ${FIELDS}
  mutation SetMyPassword($currentPassword: String, $newPassword: String!) {
    setMyPassword(currentPassword: $currentPassword, newPassword: $newPassword) {
      ...MyLoginMethodsFields
    }
  }
`;

export const REMOVE_MY_PASSWORD = gql`
  ${FIELDS}
  mutation RemoveMyPassword {
    removeMyPassword {
      ...MyLoginMethodsFields
    }
  }
`;

export const UNLINK_MY_LOGIN_IDENTITY = gql`
  ${FIELDS}
  mutation UnlinkMyLoginIdentity($provider: String!) {
    unlinkMyLoginIdentity(provider: $provider) {
      ...MyLoginMethodsFields
    }
  }
`;

export const CREATE_PASSWORD_LINK = gql`
  mutation CreatePasswordLink($userId: ID!, $sendEmail: Boolean) {
    createPasswordLink(userId: $userId, sendEmail: $sendEmail) {
      url
      expiresAt
      emailed
    }
  }
`;
