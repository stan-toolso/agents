import { describe, expect, it } from 'vitest';
import type { Tab } from './TabsContext';
import { withoutTabs } from './tabList';

const tabs: Tab[] = [
  { key: '/', url: '/', title: 'Tableau de bord', kind: 'dashboard' },
  { key: '/terminals/t1', url: '/terminals/t1', title: 'Terminal', kind: 'terminal' },
  { key: '/sessions/s1', url: '/terminals/t2', title: 'skipper · main', kind: 'workspace' },
];

describe('withoutTabs', () => {
  it("retire l'onglet d'un élément disparu", () => {
    expect(withoutTabs(tabs, (k) => k === '/terminals/t1').map((t) => t.key)).toEqual(['/', '/sessions/s1']);
  });

  it("ramène sur sa session l'onglet de dossier dont seule la page affichée a disparu", () => {
    const out = withoutTabs(tabs, (k) => k === '/terminals/t2');
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ ...tabs[2], url: '/sessions/s1' });
  });

  it("ferme l'onglet de dossier quand c'est sa clé qui correspond", () => {
    expect(withoutTabs(tabs, (k) => k === '/sessions/s1').map((t) => t.key)).toEqual(['/', '/terminals/t1']);
  });
});
