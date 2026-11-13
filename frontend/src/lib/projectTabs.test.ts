import { describe, expect, it } from 'vitest';
import { effectiveTabs } from './projectTabs';

const TABS = ['overview', 'conversations', 'repo', 'tasks', 'pullRequests', 'settings'].map((key) => ({ key, label: key, path: `/${key}`, icon: 'bi-dot' }));

describe('effectiveTabs', () => {
  const pages = [
    { id: '1', slug: 'reporting', title: 'Reporting', icon: 'bi-graph-up', position: 1 },
    { id: '2', slug: 'client', title: 'Client', icon: null, position: 0 },
  ];
  it('sans réglage : le tableau de bord, les pages par position, puis les autres natifs', () => {
    const t = effectiveTabs(TABS, null, pages);
    expect(t.map((x) => x.key)).toEqual(['overview', 'page:client', 'page:reporting', ...TABS.slice(1).map((x) => x.key)]);
    expect(t.find((x) => x.key === 'page:client')).toMatchObject({ label: 'Client', path: '/p/client', icon: 'bi-layout-text-window' });
  });
  it('masque les onglets cités et place en tête ceux de l’ordre réglé', () => {
    const t = effectiveTabs(TABS, { hidden: ['repo', 'pullRequests'], order: ['overview', 'page:reporting', 'tasks'] }, pages);
    expect(t.map((x) => x.key).slice(0, 3)).toEqual(['overview', 'page:reporting', 'tasks']);
    expect(t.some((x) => x.key === 'repo' || x.key === 'pullRequests')).toBe(false);
    expect(t.map((x) => x.key).slice(3)).toEqual(['page:client', 'conversations', 'settings']);
  });
});
