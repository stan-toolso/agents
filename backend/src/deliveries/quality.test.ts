import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY_TAGS, backfillPlan, cleanQualityTags, isQualityTask, normalizeTag, pickDelivery, regressionStats, type ExistingLink } from './quality.js';

const H = 3_600_000;
const t0 = new Date('2026-11-10T12:00:00Z');
const at = (hours: number) => new Date(t0.getTime() + hours * H);

describe('étiquettes qualité', () => {
  it('compare sans casse ni accents', () => {
    expect(normalizeTag(' Régression ')).toBe('regression');
    expect(isQualityTask(['frontend', 'Qualité'], DEFAULT_QUALITY_TAGS)).toBe(true);
    expect(isQualityTask(['BUG'], DEFAULT_QUALITY_TAGS)).toBe(true);
    expect(isQualityTask(['bugfix', 'regressions'], DEFAULT_QUALITY_TAGS)).toBe(false);
    expect(isQualityTask([], DEFAULT_QUALITY_TAGS)).toBe(false);
  });

  it('suit les étiquettes du projet', () => {
    expect(isQualityTask(['incident'], ['incident'])).toBe(true);
    expect(isQualityTask(['bug'], ['incident'])).toBe(false);
  });

  it('nettoie une liste réglée (doublons, vides) et retombe sur le défaut', () => {
    expect(cleanQualityTags(['Bug', 'bug', ' ', 'Incident'])).toEqual(['bug', 'incident']);
    expect(cleanQualityTags([])).toEqual(DEFAULT_QUALITY_TAGS);
    expect(cleanQualityTags(null)).toEqual(DEFAULT_QUALITY_TAGS);
  });
});

describe('choix de la livraison', () => {
  const d1 = { id: 'd1', at: at(0) };
  const d2 = { id: 'd2', at: at(10) };
  const d3 = { id: 'd3', at: at(30) };

  it('prend la plus récente terminée avant la création', () => {
    expect(pickDelivery([d3, d1, d2], at(20), 48)?.id).toBe('d2');
    expect(pickDelivery([d1, d2, d3], at(31), 48)?.id).toBe('d3');
  });

  it('ignore une livraison terminée après la création', () => {
    expect(pickDelivery([d2], at(9), 48)).toBeNull();
    expect(pickDelivery([d1, d2], at(9), 48)?.id).toBe('d1');
  });

  it('fenêtre de 48 h : incluse jusqu’à 48 h, exclue au-delà', () => {
    expect(pickDelivery([d1], at(47.9), 48)?.id).toBe('d1');
    expect(pickDelivery([d1], at(48), 48)?.id).toBe('d1');
    expect(pickDelivery([d1], at(48.01), 48)).toBeNull();
    expect(pickDelivery([d1], at(5), 4)).toBeNull();
  });

  it('une tâche créée à l’instant de la livraison lui est rattachée', () => {
    expect(pickDelivery([d1], at(0), 48)?.id).toBe('d1');
  });

  it('la plus récente reste choisie même si la précédente est dans la fenêtre', () => {
    expect(pickDelivery([d1, d2], at(11), 48)?.id).toBe('d2');
  });
});

describe('rattrapage', () => {
  const refs = [
    { id: 'd1', at: at(0) },
    { id: 'd2', at: at(100) },
  ];
  const settings = { tags: DEFAULT_QUALITY_TAGS, windowHours: 48 };

  it('rattache, déplace et retire les rattachements automatiques, jamais les manuels', () => {
    const tasks = [
      { id: 'new', tags: ['bug'], createdAt: at(2) },
      { id: 'same', tags: ['bug'], createdAt: at(3) },
      { id: 'moved', tags: ['qualite'], createdAt: at(101) },
      { id: 'untagged', tags: ['ux'], createdAt: at(4) },
      { id: 'late', tags: ['bug'], createdAt: at(60) },
      { id: 'manual', tags: ['ux'], createdAt: at(5) },
      { id: 'plain', tags: ['ux'], createdAt: at(6) },
    ];
    const existing = new Map<string, ExistingLink>([
      ['same', { deliveryId: 'd1', source: 'auto' }],
      ['moved', { deliveryId: 'd1', source: 'auto' }],
      ['untagged', { deliveryId: 'd1', source: 'auto' }],
      ['late', { deliveryId: 'd1', source: 'auto' }],
      ['manual', { deliveryId: 'd2', source: 'manual' }],
    ]);
    const plan = backfillPlan(tasks, refs, existing, settings);
    expect(plan.link).toEqual([
      { taskId: 'new', deliveryId: 'd1' },
      { taskId: 'moved', deliveryId: 'd2' },
    ]);
    expect(plan.unlink.sort()).toEqual(['late', 'untagged']);
  });
});

describe('taux de régression', () => {
  it('par livraison et par auteur des PR emportées', () => {
    const counts = new Map([
      ['d1', 2],
      ['d3', 1],
    ]);
    const authors = [
      { deliveryId: 'd1', pullRequestId: 'p1', authorId: 'ben' },
      { deliveryId: 'd1', pullRequestId: 'p2', authorId: 'stan' },
      { deliveryId: 'd2', pullRequestId: 'p3', authorId: 'ben' },
      { deliveryId: 'd3', pullRequestId: 'p4', authorId: 'ben' },
      { deliveryId: 'd3', pullRequestId: 'p5', authorId: 'ben' },
      { deliveryId: 'other', pullRequestId: 'p6', authorId: 'stan' },
      { deliveryId: 'd2', pullRequestId: 'p7', authorId: null },
    ];
    const stats = regressionStats(['d1', 'd2', 'd3', 'd4'], counts, authors);
    expect(stats).toMatchObject({ deliveries: 4, deliveriesWithQualityTasks: 2, qualityTasks: 3, regressionRate: 0.5 });
    expect(stats.byAuthor).toEqual([
      { authorId: 'ben', pullRequests: 4, deliveries: 3, deliveriesWithQualityTasks: 2, qualityTasks: 3, regressionRate: 2 / 3 },
      { authorId: 'stan', pullRequests: 1, deliveries: 1, deliveriesWithQualityTasks: 1, qualityTasks: 2, regressionRate: 1 },
    ]);
  });

  it('sans livraison : taux nul', () => {
    expect(regressionStats([], new Map(), [])).toEqual({ deliveries: 0, deliveriesWithQualityTasks: 0, qualityTasks: 0, regressionRate: null, byAuthor: [] });
  });
});
