import { actionLabel, targetTypeLabel } from './labels.js';
import type { AuditEntry } from './types.js';

const KIND_LABELS = { human: 'personne', agent: 'agent', system: 'Skipper' } as const;

/** Champ CSV : entre guillemets dès qu'il contient un séparateur, un guillemet ou un saut de ligne ; formule neutralisée. */
export function csvField(value: unknown): string {
  let s = value == null ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Un tableur exécuterait =, +, -, @ en tête de cellule : préfixe d'une apostrophe.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = ['date', 'acteur', 'type d’acteur', 'personne', 'session', 'action', 'libellé', 'type de cible', 'cible', 'identifiant de la cible', 'détails'];

/** Journal en CSV (séparateur virgule, BOM UTF-8 pour Excel). `userName` : nom de la personne par identifiant. */
export function auditToCsv(entries: AuditEntry[], userName: (id: string) => string | null): string {
  const lines = [HEADER.map(csvField).join(',')];
  for (const e of entries) {
    lines.push(
      [
        e.createdAt,
        e.actorLabel ?? (e.actorUserId ? userName(e.actorUserId) : null) ?? KIND_LABELS[e.actorKind],
        KIND_LABELS[e.actorKind],
        e.actorUserId ? (userName(e.actorUserId) ?? e.actorUserId) : '',
        e.sessionId ?? '',
        e.action,
        actionLabel(e.action),
        targetTypeLabel(e.targetType),
        e.targetLabel ?? '',
        e.targetId ?? '',
        Object.keys(e.details).length ? e.details : '',
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
