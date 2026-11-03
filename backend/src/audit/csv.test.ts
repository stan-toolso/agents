import { describe, expect, it } from 'vitest';
import { auditToCsv, csvField } from './csv.js';
import type { AuditEntry } from './types.js';

describe('csvField', () => {
  it('échappe séparateurs, guillemets et sauts de ligne', () => {
    expect(csvField('simple')).toBe('simple');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvField('ligne\nsuivante')).toBe('"ligne\nsuivante"');
    expect(csvField(null)).toBe('');
  });
  it('neutralise les formules de tableur', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('@cmd')).toBe("'@cmd");
  });
});

describe('auditToCsv', () => {
  it('une ligne par entrée, BOM et en-tête', () => {
    const entry: AuditEntry = {
      id: '1',
      projectId: 'p1',
      actorUserId: 'u1',
      sessionId: null,
      actorLabel: 'Alice',
      actorKind: 'human',
      action: 'task.status',
      targetType: 'task',
      targetId: 't1',
      targetLabel: 'Faire le journal',
      details: { from: 'todo', to: 'done' },
      createdAt: new Date('2026-11-03T10:00:00Z'),
    };
    const csv = auditToCsv([entry], () => 'Alice Martin');
    expect(csv.startsWith('﻿date,')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('2026-11-03T10:00:00.000Z,Alice,personne,Alice Martin,,task.status,a changé le statut de la tâche,Tâche,Faire le journal,t1,"{""from"":""todo"",""to"":""done""}"');
  });
});
