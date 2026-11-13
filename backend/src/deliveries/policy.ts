import { ciVerdict } from '../git/ci.js';
import type { ReviewVerdict } from '../reviews/types.js';

/**
 * Politique de livraison d'un projet, par étiquette de tâche (pur, sans dépendance à la base : testé).
 * - `manual` (défaut, et prioritaire) : une personne fusionne (bouton « Livrer », fusion à la main).
 * - `auto_merge` : Skipper fusionne la PR suivie de la tâche quand (1) la PR est ouverte et prête (pas brouillon),
 *   (2) une relecture par un agent (backend/src/reviews) du commit courant du dossier de travail est favorable
 *   (« ✅ Rien de bloquant »), (3) la CI est verte. La relecture est demandée d'office par Skipper.
 * Le déploiement n'est jamais automatique : il reste soumis à l'accord d'une personne.
 */

export type DeliveryPolicyMode = 'manual' | 'auto_merge';
export const DELIVERY_POLICY_MODES: DeliveryPolicyMode[] = ['manual', 'auto_merge'];

export interface DeliveryPolicyRule {
  /** Étiquette de tâche (comparée sans la casse ni les espaces autour). */
  tag: string;
  mode: DeliveryPolicyMode;
}

export interface DeliveryPolicy {
  projectId: string;
  rules: DeliveryPolicyRule[];
  /** Compte avec lequel Skipper fusionne : l'administrateur du projet qui a enregistré la politique. */
  mergeUserId: string | null;
  updatedAt: Date;
}

/** Nombre maximal de règles d'un projet. */
export const MAX_POLICY_RULES = 20;
/** Relectures automatiques au plus par pull request (une par commit relu) : au-delà, une personne prend la main. */
export const MAX_AUTO_REVIEWS = 3;

const tagKey = (tag: string) => tag.trim().toLowerCase();

/** Règles saisies → règles enregistrables (étiquettes nettoyées, doublons retirés : la dernière l'emporte). Lève Error. */
export function normalizePolicyRules(input: { tag: string; mode: string }[]): DeliveryPolicyRule[] {
  const byTag = new Map<string, DeliveryPolicyRule>();
  for (const r of input) {
    const tag = r.tag.trim();
    if (!tag) continue;
    if (tag.length > 60) throw new Error(`Étiquette trop longue : ${tag.slice(0, 60)}…`);
    const mode = r.mode.toLowerCase() as DeliveryPolicyMode;
    if (!DELIVERY_POLICY_MODES.includes(mode)) throw new Error(`Politique inconnue : ${r.mode}`);
    byTag.set(tagKey(tag), { tag, mode });
  }
  const rules = [...byTag.values()];
  if (rules.length > MAX_POLICY_RULES) throw new Error(`Au plus ${MAX_POLICY_RULES} règles de livraison par projet`);
  return rules;
}

/** Politique applicable à une tâche d'après ses étiquettes : `manual` l'emporte sur `auto_merge` ; aucune règle : manuel. */
export function policyFor(rules: DeliveryPolicyRule[], tags: string[]): { mode: DeliveryPolicyMode; tag: string | null } {
  const keys = new Set(tags.map(tagKey));
  const matching = rules.filter((r) => keys.has(tagKey(r.tag)));
  const manual = matching.find((r) => r.mode === 'manual');
  if (manual) return { mode: 'manual', tag: manual.tag };
  const auto = matching.find((r) => r.mode === 'auto_merge');
  return auto ? { mode: 'auto_merge', tag: auto.tag } : { mode: 'manual', tag: null };
}

/** Une relecture par un agent du dossier de travail de la PR. */
export interface ReviewState {
  sessionId: string;
  headSha: string | null;
  /** Rapport publié (ou relecture arrêtée). */
  done: boolean;
  verdict: ReviewVerdict | null;
  error: string | null;
  auto: boolean;
}

export interface AutoMergeInput {
  pr: { status: string; isDraft: boolean; checksState: string | null };
  /** Commit courant du dossier de travail (null : inconnu). */
  headSha: string | null;
  reviews: ReviewState[];
  /** L'agent de la session du dossier est au travail (tour en cours). */
  authorBusy: boolean;
  /** Une livraison est déjà en cours pour ce dossier. */
  deliveryActive: boolean;
}

export type AutoMergeDecision =
  | { action: 'skip'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'review' }
  | { action: 'merge'; reviewSessionId: string };

/** Que faire maintenant d'une PR dont la tâche est en fusion automatique ? */
export function autoMergeDecision(input: AutoMergeInput): AutoMergeDecision {
  const { pr } = input;
  if (pr.status !== 'open') return { action: 'skip', reason: "la pull request n'est pas ouverte" };
  if (pr.isDraft) return { action: 'wait', reason: 'pull request en brouillon' };
  if (input.deliveryActive) return { action: 'wait', reason: 'livraison déjà en cours' };
  if (input.authorBusy) return { action: 'wait', reason: "l'agent de la branche est au travail" };
  if (!input.headSha) return { action: 'wait', reason: 'commit courant inconnu' };
  const ci = ciVerdict(pr.checksState);
  if (ci === 'failure') return { action: 'wait', reason: 'CI rouge' };
  const current = input.reviews.filter((r) => r.headSha === input.headSha);
  if (current.some((r) => !r.done)) return { action: 'wait', reason: 'relecture en cours' };
  const approved = current.find((r) => r.verdict === 'approved' && !r.error);
  if (approved) {
    if (ci !== 'success') return { action: 'wait', reason: ci === 'pending' ? 'CI en cours' : 'aucun check de CI sur la pull request' };
    return { action: 'merge', reviewSessionId: approved.sessionId };
  }
  // Une relecture de ce commit a déjà conclu sans accord : on attend un nouveau commit (corrections), pas une autre relecture.
  if (current.some((r) => r.done && !r.error)) return { action: 'wait', reason: 'relecture défavorable : en attente de corrections' };
  if (input.reviews.filter((r) => r.auto).length >= MAX_AUTO_REVIEWS) return { action: 'wait', reason: `${MAX_AUTO_REVIEWS} relectures automatiques déjà faites : une personne prend la main` };
  return { action: 'review' };
}
