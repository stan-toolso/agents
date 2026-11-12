import type { ProjectPageInfo, ProjectTabsSetting } from '../graphql/cockpit';

export interface ProjectTabDef {
  key: string;
  label: string;
  path: string;
  icon: string;
  title?: string;
  absolute?: boolean;
}

/**
 * Onglets effectifs d'un projet : les natifs moins ceux masqués, plus les pages personnalisées (`page:<slug>`), dans
 * l'ordre réglé (`projects.tabs.order`), les absents à leur place habituelle. Pur (testé dans projectTabs.test.ts).
 */
export function effectiveTabs<T extends ProjectTabDef>(base: T[], setting: ProjectTabsSetting | null | undefined, pages: ProjectPageInfo[]): T[] {
  const hidden = new Set(setting?.hidden ?? []);
  const all: T[] = [
    ...base.filter((t) => !hidden.has(t.key)),
    ...[...pages].sort((a, b) => a.position - b.position).map((p) => ({ key: `page:${p.slug}`, label: p.title, path: `/p/${p.slug}`, icon: p.icon ?? 'bi-layout-text-window', title: 'Page personnalisée du projet' }) as T),
  ];
  const order = setting?.order ?? [];
  const rank = new Map(order.map((k, i) => [k, i]));
  return [...all].sort((a, b) => {
    const ra = rank.get(a.key);
    const rb = rank.get(b.key);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return all.indexOf(a) - all.indexOf(b);
  });
}
