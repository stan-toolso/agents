/**
 * Tâches « qualité » rattachées aux livraisons : règles pures (sans base), testées par quality.test.ts.
 *
 * Une tâche est « qualité » quand l'une de ses étiquettes figure dans la liste du projet (comparaison sans casse ni
 * accents : « Qualité » = « qualite »). Créée dans la fenêtre (48 h par défaut) qui suit une livraison de référence
 * réussie, elle est rattachée à la plus récente terminée avant sa création. Livraisons de référence : les déploiements
 * du projet, ou ses fusions « Livrer » s'il n'a jamais déployé par Skipper (choix fait par le dépôt, `referenceKind`).
 */

export const DEFAULT_QUALITY_TAGS = ['bug', 'regression', 'qualite'];
export const DEFAULT_WINDOW_HOURS = 48;
export const MAX_WINDOW_HOURS = 720;

/** Étiquette comparable : minuscules, sans accents ni espaces autour (« Régression » → « regression »). */
export function normalizeTag(tag: string): string {
  return tag
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/** Liste d'étiquettes qualité nettoyée (normalisée, sans doublon ni vide) ; vide → défaut. */
export function cleanQualityTags(tags: string[] | null | undefined): string[] {
  const out = [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))];
  return out.length ? out : [...DEFAULT_QUALITY_TAGS];
}

export function isQualityTask(taskTags: string[], qualityTags: string[]): boolean {
  const wanted = new Set(qualityTags.map(normalizeTag));
  return taskTags.some((t) => wanted.has(normalizeTag(t)));
}

/** Livraison de référence : quand elle s'est terminée (mise en production, fusion). */
export interface ReferenceDelivery {
  id: string;
  at: Date;
}

/**
 * Livraison à laquelle rattacher une tâche créée à `createdAt` : la plus récente terminée au plus tard à sa création
 * et depuis moins de `windowHours` ; null s'il n'y en a pas.
 */
export function pickDelivery(deliveries: ReferenceDelivery[], createdAt: Date, windowHours: number): ReferenceDelivery | null {
  const t = createdAt.getTime();
  const from = t - windowHours * 3_600_000;
  let best: ReferenceDelivery | null = null;
  for (const d of deliveries) {
    const at = d.at.getTime();
    if (at > t || at < from) continue;
    if (!best || at > best.at.getTime()) best = d;
  }
  return best;
}

export interface QualityTaskCandidate {
  id: string;
  tags: string[];
  createdAt: Date;
}

export interface ExistingLink {
  deliveryId: string | null;
  source: 'auto' | 'manual';
}

/**
 * Plan de rattrapage d'un projet : pour chaque tâche, le rattachement automatique attendu comparé à l'existant.
 * Les rattachements manuels ne sont jamais touchés.
 */
export function backfillPlan(
  tasks: QualityTaskCandidate[],
  deliveries: ReferenceDelivery[],
  existing: Map<string, ExistingLink>,
  settings: { tags: string[]; windowHours: number },
): { link: { taskId: string; deliveryId: string }[]; unlink: string[] } {
  const link: { taskId: string; deliveryId: string }[] = [];
  const unlink: string[] = [];
  for (const t of tasks) {
    const cur = existing.get(t.id);
    if (cur?.source === 'manual') continue;
    const target = isQualityTask(t.tags, settings.tags) ? pickDelivery(deliveries, t.createdAt, settings.windowHours) : null;
    if (target && cur?.deliveryId !== target.id) link.push({ taskId: t.id, deliveryId: target.id });
    else if (!target && cur) unlink.push(t.id);
  }
  return { link, unlink };
}

/** Une PR emportée par une livraison et son auteur (personne ou agent propriétaire de la session qui l'a ouverte). */
export interface DeliveryAuthorRow {
  deliveryId: string;
  pullRequestId: string;
  authorId: string | null;
}

export interface RegressionLine {
  deliveries: number;
  /** Livraisons auxquelles au moins une tâche qualité est rattachée. */
  deliveriesWithQualityTasks: number;
  qualityTasks: number;
  /** deliveriesWithQualityTasks / deliveries (null sans livraison). */
  regressionRate: number | null;
}

export interface RegressionStats extends RegressionLine {
  byAuthor: (RegressionLine & { authorId: string; pullRequests: number })[];
}

const line = (deliveryIds: Iterable<string>, counts: Map<string, number>): RegressionLine => {
  let deliveries = 0;
  let withQ = 0;
  let qualityTasks = 0;
  for (const id of deliveryIds) {
    deliveries++;
    const n = counts.get(id) ?? 0;
    if (n > 0) withQ++;
    qualityTasks += n;
  }
  return { deliveries, deliveriesWithQualityTasks: withQ, qualityTasks, regressionRate: deliveries ? withQ / deliveries : null };
};

/**
 * Taux de régression : part des livraisons suivies d'au moins une tâche qualité, pour le projet et par auteur des PR
 * emportées (une livraison compte pour chaque auteur dont elle emporte une PR). Auteurs triés par livraisons.
 */
export function regressionStats(deliveryIds: string[], qualityCounts: Map<string, number>, authors: DeliveryAuthorRow[]): RegressionStats {
  const ids = new Set(deliveryIds);
  const perAuthor = new Map<string, { deliveries: Set<string>; prs: Set<string> }>();
  for (const a of authors) {
    if (!a.authorId || !ids.has(a.deliveryId)) continue;
    const cur = perAuthor.get(a.authorId) ?? { deliveries: new Set<string>(), prs: new Set<string>() };
    cur.deliveries.add(a.deliveryId);
    cur.prs.add(a.pullRequestId);
    perAuthor.set(a.authorId, cur);
  }
  const byAuthor = [...perAuthor].map(([authorId, v]) => ({ authorId, pullRequests: v.prs.size, ...line(v.deliveries, qualityCounts) }));
  byAuthor.sort((a, b) => b.deliveries - a.deliveries || (b.regressionRate ?? 0) - (a.regressionRate ?? 0) || a.authorId.localeCompare(b.authorId));
  return { ...line(ids, qualityCounts), byAuthor };
}
