import { gql } from '@apollo/client';

/** Ce que l'espace Configuration d'un projet affiche autour de ses pages (nom, rôle, espace personnel ou non). */
export const PROJECT_CONFIG_SHELL = gql`
  query ProjectConfigShell($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
    }
  }
`;
