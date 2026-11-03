import { redactDeep } from './redact.js';

/** Événement de session tel que le lien public le renvoie (même forme que `SessionEvent` côté GraphQL). */
export interface PublicEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface SourceEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  createdAt: Date | string;
}

/** Champs d'un résultat de tour gardés : durée et issue ; jamais le coût ni la consommation (confidentiels). */
const RESULT_FIELDS = ['subtype', 'is_error', 'duration_ms', 'num_turns', 'terminal_reason', 'errors', 'origin'] as const;

function pick(p: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

/**
 * Payload montré par le lien public, ou null pour ne pas montrer l'événement. Liste blanche des types affichés
 * par le transcript (frontend/src/components/Transcript.tsx) : instructions (sans leurs fichiers joints, servis
 * seulement aux membres), réponses et appels d'outils (sans la réflexion ni la consommation), fins de tour (sans le
 * coût), demandes et leurs réponses, notes de tâche, réglages, planification, nettoyage, états et avis. Exclus :
 * erreurs brutes du CLI (stderr), audit des connexions, événements techniques.
 */
function publicPayload(type: string, p: Record<string, unknown>): Record<string, unknown> | null {
  switch (type) {
    case 'instruction':
      return pick(p, ['text', 'preamble']);
    case 'claude.assistant': {
      const message = (p.message ?? {}) as { content?: unknown };
      const content = Array.isArray(message.content) ? (message.content as Array<{ type?: string }>).filter((b) => b && b.type !== 'thinking' && b.type !== 'redacted_thinking') : [];
      return { ...pick(p, ['parent_tool_use_id']), message: { content } };
    }
    case 'claude.user': {
      const message = (p.message ?? {}) as { content?: unknown };
      return { ...pick(p, ['parent_tool_use_id']), message: { content: message.content ?? '' } };
    }
    case 'claude.result':
      return pick(p, RESULT_FIELDS);
    case 'claude.system':
      if (p.subtype === 'compact_boundary') return pick(p, ['subtype', 'compact_metadata']);
      if (p.subtype === 'task_notification') return pick(p, ['subtype', 'summary']);
      // Dossier de travail seul : le transcript s'en sert pour raccourcir les chemins.
      if (p.subtype === 'init') return pick(p, ['subtype', 'cwd']);
      return null;
    case 'system':
      return p.notice ? pick(p, ['notice', 'message']) : null;
    case 'request':
      return pick(p, ['type', 'title', 'message', 'payload']);
    case 'request.answered':
      return pick(p, ['type', 'title', 'response']);
    case 'task_note':
    case 'cleanup':
    case 'config':
    case 'schedule':
    case 'status':
    case 'stdout':
      return p;
    default:
      return null;
  }
}

/** Événements d'une session pour le lien public : filtrés (liste blanche) et secrets masqués. */
export function toPublicEvents(events: SourceEvent[]): PublicEvent[] {
  const out: PublicEvent[] = [];
  for (const e of events) {
    const payload = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {};
    const shown = publicPayload(e.type, payload);
    if (!shown) continue;
    out.push({ id: e.id, sessionId: e.sessionId, type: e.type, payload: redactDeep(shown), createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt });
  }
  return out;
}
