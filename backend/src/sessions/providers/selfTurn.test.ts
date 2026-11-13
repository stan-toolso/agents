import { describe, expect, it } from 'vitest';
import { assistantText, selfTurnExcerpt, selfTurnNotice, wakeTrigger } from './selfTurn.js';

describe('tours repris par l’agent de lui-même', () => {
  it('traduit la fin d’une commande de fond', () => {
    const summary = 'Background command "until [ $(date -u +%s) -ge 1 ]; do sleep 20; done; echo \\"16:12 Paris : contrôler\\"" completed (exit code 0)';
    expect(wakeTrigger({ summary })).toMatch(/^commande de fond terminée \(« until /);
    expect(wakeTrigger({ summary: 'Background command "sleep 5" failed (exit code 1)' })).toBe('commande de fond en échec (« sleep 5 »)');
  });

  it('garde un résumé inconnu, ou la description à défaut, borné', () => {
    expect(wakeTrigger({ summary: 'Agent "revue" completed' })).toBe('Agent "revue" completed');
    expect(wakeTrigger({ description: 'surveillance' })).toBe('surveillance');
    expect(wakeTrigger({ summary: 'x'.repeat(300) }).length).toBe(160);
    expect(wakeTrigger({})).toBe('');
  });

  it('libellé du repère', () => {
    expect(selfTurnNotice('commande de fond terminée')).toBe("L'agent reprend de lui-même : commande de fond terminée");
    expect(selfTurnNotice('')).toMatch(/fin d’une tâche de fond$/);
  });

  it('texte d’un message de l’agent', () => {
    expect(assistantText({ message: { content: [{ type: 'text', text: 'Bonjour' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'suite' }] } })).toBe('Bonjour\nsuite');
    expect(assistantText({ message: { content: [{ type: 'tool_use', name: 'Bash' }] } })).toBeNull();
    expect(assistantText({})).toBeNull();
  });

  it('extrait pour la notification : première ligne utile, sans Markdown', () => {
    expect(selfTurnExcerpt('\n## **Premier envoi** parti à 16:05\n\n| a | b |')).toBe('Premier envoi parti à 16:05');
    expect(selfTurnExcerpt('a'.repeat(300))!.length).toBe(200);
    expect(selfTurnExcerpt(null)).toBeNull();
    expect(selfTurnExcerpt('|---|')).toBeNull();
  });
});
