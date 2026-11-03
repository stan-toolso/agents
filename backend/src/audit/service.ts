import { createLogger } from '../log.js';
import { auditRepository } from './repository.js';
import type { AuditEntry, AuditFilter, AuditInput } from './types.js';

const log = createLogger('audit');

/** Taille maximale des détails gardés (JSON) : au-delà, les valeurs longues sont tronquées. */
const MAX_DETAIL_CHARS = 4_000;

/** Coupe les chaînes trop longues et les tableaux trop grands : le journal dit qui a fait quoi, pas le contenu. */
export function compactDetails(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => compactDetails(v, depth + 1));
    return value.length > 50 ? [...items, `… ${value.length - 50} de plus`] : items;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (depth > 4) return '…';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, compactDetails(v, depth + 1)]));
  }
  return value;
}

function boundedDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const compact = (compactDetails(details ?? {}) ?? {}) as Record<string, unknown>;
  const json = JSON.stringify(compact);
  return json.length > MAX_DETAIL_CHARS ? { truncated: json.slice(0, MAX_DETAIL_CHARS) } : compact;
}

export const auditService = {
  /**
   * Inscrit une action au journal. N'échoue jamais : une écriture ratée est journalisée mais ne doit pas faire échouer
   * l'action qui vient de réussir.
   */
  async record(input: AuditInput): Promise<void> {
    try {
      await auditRepository.insert({ ...input, details: boundedDetails(input.details) });
    } catch (err) {
      log.error(`écriture de « ${input.action} »`, err);
    }
  },

  list(filter: AuditFilter): Promise<AuditEntry[]> {
    return auditRepository.list({ ...filter, limit: Math.min(filter.limit ?? 100, 500) });
  },

  /** Pour l'export CSV : jusqu'à 10 000 entrées. */
  listForExport(filter: AuditFilter): Promise<AuditEntry[]> {
    return auditRepository.list({ ...filter, limit: 10_000 });
  },

  facets: (projectId: string) => auditRepository.facets(projectId),
};
