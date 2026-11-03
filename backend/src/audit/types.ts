/** Qui a agi : une personne, une session d'agent (avec la personne ou l'agent qui la porte), ou Skipper lui-même. */
export interface AuditActor {
  userId?: string | null;
  sessionId?: string | null;
  /** Nom affiché au moment de l'action (personne, session, clé d'API) ; complété par le service quand il manque. */
  label?: string | null;
}

export type AuditActorKind = 'human' | 'agent' | 'system';

export interface AuditInput {
  /** null : action de l'application (utilisateurs, réglages du serveur), hors de tout projet. */
  projectId: string | null;
  actor: AuditActor | null;
  /** `<type de cible>.<verbe>`, ex. `session.stop`, `request.answer` (libellés dans labels.ts). */
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  projectId: string | null;
  actorUserId: string | null;
  sessionId: string | null;
  actorLabel: string | null;
  actorKind: AuditActorKind;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditFilter {
  projectId: string;
  /** Personne (ou agent de projet) : ses actions directes et celles de ses sessions. */
  actorUserId?: string | null;
  sessionId?: string | null;
  actorKind?: AuditActorKind | null;
  targetType?: string | null;
  action?: string | null;
  from?: Date | null;
  to?: Date | null;
  /** Curseur : entrées plus anciennes que cet identifiant. */
  before?: string | null;
  limit?: number;
}

export const actorKindOf = (e: { actorUserId: string | null; sessionId: string | null }): AuditActorKind => (e.sessionId ? 'agent' : e.actorUserId ? 'human' : 'system');

/** Filtre tel que reçu de GraphQL ou de l'URL de l'export (valeurs en chaînes, type d'acteur en majuscules ou non). */
export interface RawAuditFilter {
  actorUserId?: string | null;
  actorKind?: string | null;
  targetType?: string | null;
  action?: string | null;
  from?: string | Date | null;
  to?: string | Date | null;
}

const toDate = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function parseAuditFilter(projectId: string, raw: RawAuditFilter | null | undefined): AuditFilter {
  const kind = raw?.actorKind?.toLowerCase();
  return {
    projectId,
    actorUserId: raw?.actorUserId || null,
    actorKind: kind === 'human' || kind === 'agent' || kind === 'system' ? kind : null,
    targetType: raw?.targetType || null,
    action: raw?.action || null,
    from: toDate(raw?.from),
    to: toDate(raw?.to),
  };
}
