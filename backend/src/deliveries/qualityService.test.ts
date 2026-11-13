import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskChange } from '../tasks/types.js';

// Tâches qualité : dépôt en mémoire (livraisons de référence, rattachements, réglages), tâches simulées.
const m = vi.hoisted(() => ({
  refs: [] as Array<{ id: string; at: Date; projectId: string }>,
  links: new Map<string, { taskId: string; deliveryId: string | null; source: 'auto' | 'manual'; linkedById: string | null; createdAt: Date }>(),
  settings: null as { tags: string[]; windowHours: number; updatedById: string | null; updatedAt: Date } | null,
  tasks: new Map<string, { id: string; projectId: string; tags: string[]; createdAt: Date }>(),
  deliveries: new Map<string, { id: string; projectId: string }>(),
  created: [] as Array<(task: unknown, actor: unknown) => unknown>,
  changed: [] as Array<(change: unknown) => unknown>,
}));

vi.mock('./qualityRepository.js', () => ({
  deliveryQualityRepository: {
    settings: async () => m.settings,
    setSettings: async (_p: string, s: { tags: string[]; windowHours: number } | null, userId: string) => {
      m.settings = s ? { ...s, updatedById: userId, updatedAt: new Date() } : null;
    },
    references: async (projectId: string, range: { from?: Date; to?: Date } = {}) =>
      m.refs.filter((r) => r.projectId === projectId && (!range.from || r.at >= range.from) && (!range.to || r.at <= range.to)).sort((a, b) => a.at.getTime() - b.at.getTime()),
    taggedTasksSince: async (projectId: string, since: Date) => [...m.tasks.values()].filter((t) => t.projectId === projectId && t.createdAt >= since && t.tags.length),
    linksOfProject: async () => new Map([...m.links].map(([id, l]) => [id, { deliveryId: l.deliveryId, source: l.source }])),
    linkOf: async (taskId: string) => m.links.get(taskId) ?? null,
    setAuto: async (taskId: string, deliveryId: string) => {
      const cur = m.links.get(taskId);
      if (cur?.source === 'manual') return;
      m.links.set(taskId, { taskId, deliveryId, source: 'auto', linkedById: null, createdAt: new Date() });
    },
    removeAuto: async (ids: string[]) => ids.forEach((id) => m.links.get(id)?.source === 'auto' && m.links.delete(id)),
    setManual: async (taskId: string, deliveryId: string | null, userId: string) => m.links.set(taskId, { taskId, deliveryId, source: 'manual', linkedById: userId, createdAt: new Date() }),
    remove: async (taskId: string) => void m.links.delete(taskId),
    qualityCounts: async (ids: string[]) => {
      const out = new Map<string, number>();
      for (const l of m.links.values()) if (l.deliveryId && ids.includes(l.deliveryId)) out.set(l.deliveryId, (out.get(l.deliveryId) ?? 0) + 1);
      return out;
    },
    authors: async () => [],
    projectsWithDeliveries: async () => ['p1'],
  },
}));
vi.mock('./repository.js', () => ({ deliveryRepository: { get: async (id: string) => m.deliveries.get(id) ?? null } }));
vi.mock('../tasks/service.js', () => ({
  taskService: {
    get: async (id: string) => {
      const t = m.tasks.get(id);
      if (!t) throw new Error('Tâche introuvable');
      return t;
    },
    onTaskCreated: (_n: string, fn: (task: unknown, actor: unknown) => unknown) => m.created.push(fn),
    onTaskChanged: (_n: string, fn: (change: unknown) => unknown) => m.changed.push(fn),
  },
}));
vi.mock('../log.js', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));

const { deliveryQualityService } = await import('./qualityService.js');

const H = 3_600_000;
const t0 = new Date('2026-11-10T12:00:00Z');
const at = (hours: number) => new Date(t0.getTime() + hours * H);
const task = (id: string, tags: string[], hours: number, projectId = 'p1') => {
  const t = { id, projectId, tags, createdAt: at(hours) };
  m.tasks.set(id, t);
  return t;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  m.refs = [];
  m.links.clear();
  m.settings = null;
  m.tasks.clear();
  m.deliveries.clear();
});

describe('rattachement à la création', () => {
  it('rattache une tâche bug créée dans les 48 h à la livraison la plus récente', async () => {
    m.refs = [
      { id: 'd1', at: at(0), projectId: 'p1' },
      { id: 'd2', at: at(5), projectId: 'p1' },
      { id: 'dx', at: at(6), projectId: 'p2' },
    ];
    expect(await deliveryQualityService.evaluate(task('t1', ['Bug'], 8))).toBe('d2');
    expect(m.links.get('t1')).toMatchObject({ deliveryId: 'd2', source: 'auto' });
  });

  it('rien hors fenêtre, ni sans étiquette qualité', async () => {
    m.refs = [{ id: 'd1', at: at(0), projectId: 'p1' }];
    expect(await deliveryQualityService.evaluate(task('late', ['bug'], 49))).toBeNull();
    expect(await deliveryQualityService.evaluate(task('ux', ['ux'], 2))).toBeNull();
    expect(m.links.size).toBe(0);
  });

  it('suit les étiquettes et la fenêtre réglées pour le projet', async () => {
    m.refs = [{ id: 'd1', at: at(0), projectId: 'p1' }];
    m.settings = { tags: ['incident'], windowHours: 72, updatedById: 'u', updatedAt: new Date() };
    expect(await deliveryQualityService.evaluate(task('a', ['bug'], 2))).toBeNull();
    expect(await deliveryQualityService.evaluate(task('b', ['Incident'], 60))).toBe('d1');
  });

  it('branché sur la création et sur le changement d’étiquettes', async () => {
    deliveryQualityService.register();
    m.refs = [{ id: 'd1', at: at(0), projectId: 'p1' }];
    const t = task('t', ['ux'], 1) as unknown as Task;
    await m.created.at(-1)!(t, { type: 'human' });
    await flush();
    expect(m.links.has('t')).toBe(false);
    const after = { ...t, tags: ['ux', 'regression'] };
    await m.changed.at(-1)!({ kind: 'updated', before: t, task: after, actor: null, addedAttachments: [] } satisfies TaskChange);
    await flush();
    expect(m.links.get('t')).toMatchObject({ deliveryId: 'd1', source: 'auto' });
    await m.changed.at(-1)!({ kind: 'updated', before: after, task: { ...after, tags: ['ux'] }, actor: null, addedAttachments: [] } satisfies TaskChange);
    await flush();
    expect(m.links.has('t')).toBe(false);
  });
});

describe('correction à la main', () => {
  it('un rattachement manuel n’est plus recalculé, reset revient au calcul', async () => {
    m.refs = [
      { id: 'd1', at: at(0), projectId: 'p1' },
      { id: 'd2', at: at(5), projectId: 'p1' },
    ];
    m.deliveries.set('d1', { id: 'd1', projectId: 'p1' });
    task('t', ['bug'], 6);
    await deliveryQualityService.evaluate(m.tasks.get('t')!);
    await deliveryQualityService.setLink('t', 'd1', 'stan');
    expect(m.links.get('t')).toMatchObject({ deliveryId: 'd1', source: 'manual', linkedById: 'stan' });
    await deliveryQualityService.evaluate(m.tasks.get('t')!);
    await deliveryQualityService.backfill('p1');
    expect(m.links.get('t')).toMatchObject({ deliveryId: 'd1', source: 'manual' });
    await deliveryQualityService.setLink('t', null, 'stan');
    expect(m.links.get('t')).toMatchObject({ deliveryId: null, source: 'manual' });
    await deliveryQualityService.setLink('t', null, 'stan', { reset: true });
    expect(m.links.get('t')).toMatchObject({ deliveryId: 'd2', source: 'auto' });
  });

  it('refuse une livraison d’un autre projet', async () => {
    m.deliveries.set('dx', { id: 'dx', projectId: 'p2' });
    task('t', ['bug'], 1);
    await expect(deliveryQualityService.setLink('t', 'dx', 'stan')).rejects.toThrow(/projet/);
  });
});

describe('réglages et rattrapage', () => {
  it('changer les étiquettes recalcule les rattachements automatiques', async () => {
    m.refs = [{ id: 'd1', at: at(0), projectId: 'p1' }];
    task('a', ['bug'], 1);
    task('b', ['incident'], 2);
    expect(await deliveryQualityService.backfill('p1')).toBe(1);
    expect([...m.links.keys()]).toEqual(['a']);
    const s = await deliveryQualityService.setSettings('p1', { tags: ['Incident'], windowHours: 48 }, 'stan');
    expect(s).toMatchObject({ tags: ['incident'], windowHours: 48, custom: true });
    expect([...m.links.keys()]).toEqual(['b']);
    expect((await deliveryQualityService.setSettings('p1', null, 'stan')).custom).toBe(false);
    expect([...m.links.keys()].sort()).toEqual(['a']);
  });

  it('refuse une fenêtre hors bornes', async () => {
    await expect(deliveryQualityService.setSettings('p1', { windowHours: 0 }, 'stan')).rejects.toThrow(/Fenêtre/);
  });

  it('relevé : taux de régression des livraisons de la période', async () => {
    const now = Date.now();
    m.refs = [
      { id: 'd1', at: new Date(now - 10 * 86_400_000), projectId: 'p1' },
      { id: 'd2', at: new Date(now - 5 * 86_400_000), projectId: 'p1' },
    ];
    m.links.set('t', { taskId: 't', deliveryId: 'd2', source: 'auto', linkedById: null, createdAt: new Date() });
    const r = await deliveryQualityService.report('p1', 30);
    expect(r).toMatchObject({ deliveries: 2, deliveriesWithQualityTasks: 1, qualityTasks: 1, regressionRate: 0.5 });
  });
});
