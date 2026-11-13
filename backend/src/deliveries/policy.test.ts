import { describe, expect, it } from 'vitest';
import { reviewVerdict } from '../reviews/types.js';
import { autoMergeDecision, MAX_AUTO_REVIEWS, normalizePolicyRules, policyFor, type AutoMergeInput, type ReviewState } from './policy.js';

describe('règles de la politique de livraison', () => {
  it('nettoie les étiquettes, retire les doublons (la dernière l’emporte) et refuse un mode inconnu', () => {
    expect(normalizePolicyRules([{ tag: ' auto ', mode: 'AUTO_MERGE' }, { tag: '', mode: 'manual' }, { tag: 'AUTO', mode: 'manual' }])).toEqual([{ tag: 'AUTO', mode: 'manual' }]);
    expect(() => normalizePolicyRules([{ tag: 'x', mode: 'deploy' }])).toThrow(/inconnue/);
    expect(() => normalizePolicyRules(Array.from({ length: 21 }, (_, i) => ({ tag: `t${i}`, mode: 'manual' })))).toThrow(/Au plus/);
  });

  it('politique d’une tâche : manuel prioritaire, sans casse, manuel par défaut', () => {
    const rules = normalizePolicyRules([{ tag: 'auto', mode: 'auto_merge' }, { tag: 'sécurité', mode: 'manual' }]);
    expect(policyFor(rules, ['Auto'])).toEqual({ mode: 'auto_merge', tag: 'auto' });
    expect(policyFor(rules, ['auto', 'Sécurité'])).toEqual({ mode: 'manual', tag: 'sécurité' });
    expect(policyFor(rules, ['backend'])).toEqual({ mode: 'manual', tag: null });
    expect(policyFor([], ['auto'])).toEqual({ mode: 'manual', tag: null });
  });
});

describe('verdict d’un rapport de relecture', () => {
  it('lit la première ligne', () => {
    expect(reviewVerdict('✅ Rien de bloquant. Bon travail.\n\n- suggestion')).toBe('approved');
    expect(reviewVerdict('\n**✅ Rien de bloquant**')).toBe('approved');
    expect(reviewVerdict('⚠️ À corriger avant fusion')).toBe('changes');
    expect(reviewVerdict('❌ Problèmes bloquants')).toBe('blocking');
    expect(reviewVerdict('Voici mon rapport : ✅')).toBeNull();
    expect(reviewVerdict('')).toBeNull();
    expect(reviewVerdict(null)).toBeNull();
  });
});

const review = (over: Partial<ReviewState> = {}): ReviewState => ({ sessionId: 'r1', headSha: 'abc', done: true, verdict: 'approved', error: null, auto: true, ...over });
const input = (over: Partial<AutoMergeInput> = {}): AutoMergeInput => ({
  pr: { status: 'open', isDraft: false, checksState: 'SUCCESS' },
  headSha: 'abc',
  reviews: [],
  authorBusy: false,
  deliveryActive: false,
  ...over,
});

describe('décision de fusion automatique', () => {
  it('fusionne quand la relecture du commit courant est favorable et la CI verte', () => {
    expect(autoMergeDecision(input({ reviews: [review()] }))).toEqual({ action: 'merge', reviewSessionId: 'r1' });
  });

  it('demande une relecture du commit courant (même CI en cours), une seule fois', () => {
    expect(autoMergeDecision(input())).toEqual({ action: 'review' });
    expect(autoMergeDecision(input({ pr: { status: 'open', isDraft: false, checksState: 'PENDING' } }))).toEqual({ action: 'review' });
    expect(autoMergeDecision(input({ reviews: [review({ done: false, verdict: null })] }))).toEqual({ action: 'wait', reason: 'relecture en cours' });
  });

  it('une relecture d’un ancien commit ne vaut pas pour le nouveau', () => {
    expect(autoMergeDecision(input({ headSha: 'def', reviews: [review()] }))).toEqual({ action: 'review' });
  });

  it('attend la CI verte après une relecture favorable ; CI rouge : ni relecture ni fusion', () => {
    expect(autoMergeDecision(input({ pr: { status: 'open', isDraft: false, checksState: 'PENDING' }, reviews: [review()] }))).toMatchObject({ action: 'wait', reason: 'CI en cours' });
    expect(autoMergeDecision(input({ pr: { status: 'open', isDraft: false, checksState: null }, reviews: [review()] }))).toMatchObject({ action: 'wait' });
    expect(autoMergeDecision(input({ pr: { status: 'open', isDraft: false, checksState: 'FAILURE' } }))).toEqual({ action: 'wait', reason: 'CI rouge' });
  });

  it('relecture défavorable : attend un nouveau commit ; relecture en échec : en relance une', () => {
    expect(autoMergeDecision(input({ reviews: [review({ verdict: 'changes' })] }))).toMatchObject({ action: 'wait', reason: expect.stringMatching(/défavorable/) });
    expect(autoMergeDecision(input({ reviews: [review({ verdict: 'approved', error: 'Processus tué' })] }))).toEqual({ action: 'review' });
    expect(autoMergeDecision(input({ reviews: [review({ verdict: null })] }))).toMatchObject({ action: 'wait' });
  });

  it('limite le nombre de relectures automatiques par PR', () => {
    const old = Array.from({ length: MAX_AUTO_REVIEWS }, (_, i) => review({ sessionId: `r${i}`, headSha: `old${i}`, verdict: 'blocking' }));
    expect(autoMergeDecision(input({ reviews: old }))).toMatchObject({ action: 'wait', reason: expect.stringMatching(/une personne prend la main/) });
    // Les relectures demandées par une personne ne comptent pas.
    expect(autoMergeDecision(input({ reviews: old.map((r) => ({ ...r, auto: false })) }))).toEqual({ action: 'review' });
  });

  it('attend : brouillon, agent au travail, livraison en cours, commit inconnu ; ignore une PR non ouverte', () => {
    expect(autoMergeDecision(input({ pr: { status: 'open', isDraft: true, checksState: 'SUCCESS' }, reviews: [review()] })).action).toBe('wait');
    expect(autoMergeDecision(input({ authorBusy: true, reviews: [review()] })).action).toBe('wait');
    expect(autoMergeDecision(input({ deliveryActive: true, reviews: [review()] })).action).toBe('wait');
    expect(autoMergeDecision(input({ headSha: null })).action).toBe('wait');
    expect(autoMergeDecision(input({ pr: { status: 'merged', isDraft: false, checksState: 'SUCCESS' } })).action).toBe('skip');
  });
});
