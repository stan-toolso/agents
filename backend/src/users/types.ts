export type ProjectRole = 'admin' | 'member' | 'viewer';

/** Ordre des rôles : un rôle donne tous les droits des rôles inférieurs. */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, admin: 2 };

/** Une personne, ou un agent de projet (utilisateur qui ne se connecte jamais, propriétaire des sessions qu'il joue ; voir agents/). */
export type UserKind = 'person' | 'agent';

export interface User {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  avatarUrl: string | null;
  googleSub: string | null;
  /** Administrateur de l'application : paramètres généraux, utilisateurs. Les droits sur les projets restent par projet. */
  isAdmin: boolean;
  /** Super administrateur : administrateur de l'application qui administre aussi tous les projets, membre ou non. */
  isSuperAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Date du mot de passe en cours ; null : pas de mot de passe (l'empreinte n'est jamais chargée avec l'utilisateur). */
  passwordSetAt: Date | null;
}

/** Compte externe (Microsoft, GitHub) relié à une personne pour la connexion. */
export interface UserIdentity {
  provider: string;
  subject: string;
  userId: string;
  email: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Compte externe tel que le décrit le fournisseur après connexion. */
export interface ExternalIdentity {
  provider: 'microsoft' | 'github';
  subject: string;
  /** Adresses dont le fournisseur garantit la propriété (minuscules) ; seules elles retrouvent une invitation. */
  verifiedEmails: string[];
  /** Adresse à afficher (vérifiée ou non). */
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectRole;
  invitedById: string | null;
  createdAt: Date;
}

/** Profil renvoyé par Google après connexion. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Éléments ouverts dans les onglets d'une personne, par type (sidebar d'un super administrateur). */
export interface OpenItems {
  projectIds?: string[] | null;
  worksessionIds?: string[] | null;
  sessionIds?: string[] | null;
  terminalIds?: string[] | null;
  taskIds?: string[] | null;
}
