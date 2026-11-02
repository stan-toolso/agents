import { apiBaseUrl } from '../apollo';

/** Téléchargement d'une session en Markdown (route HTTP authentifiée par le cookie, backend/src/exports/routes.ts). */
export const sessionExportUrl = (sessionId: string) => `${apiBaseUrl}/api/sessions/${sessionId}/export.md`;

/** Téléchargement de l'archive d'un projet (tar.gz ; administrateurs du projet). */
export const projectExportUrl = (projectId: string) => `${apiBaseUrl}/api/projects/${projectId}/export.tar.gz`;
