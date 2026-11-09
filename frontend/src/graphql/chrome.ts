import { gql } from '@apollo/client';

/** Navigateur Chrome relié par la personne (extension « Skipper pour Chrome »). */
export interface ChromeBrowser {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  connected: boolean;
  connectedAt: string | null;
  userAgent: string | null;
  extensionVersion: string | null;
}

const FIELDS = gql`
  fragment ChromeBrowserFields on ChromeBrowser {
    id
    name
    prefix
    createdAt
    lastUsedAt
    connected
    connectedAt
    userAgent
    extensionVersion
  }
`;

export const MY_CHROME_BROWSERS = gql`
  query MyChromeBrowsers {
    myChromeBrowsers {
      ...ChromeBrowserFields
    }
  }
  ${FIELDS}
`;

export const CONNECT_CHROME_BROWSER = gql`
  mutation ConnectChromeBrowser($name: String!) {
    connectChromeBrowser(name: $name) {
      token
      browser {
        ...ChromeBrowserFields
      }
    }
  }
  ${FIELDS}
`;

export const REMOVE_CHROME_BROWSER = gql`
  mutation RemoveChromeBrowser($id: ID!) {
    removeChromeBrowser(id: $id)
  }
`;

/** Archive de l'extension servie par le backend (adresse du serveur déjà renseignée). */
export const CHROME_EXTENSION_ZIP = '/api/chrome/extension.zip';
