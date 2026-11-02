import { Form } from 'react-bootstrap';
import { MIN_CONTEXT_K, type ContextLimit, type ContextLimitAction } from '../lib/contextLimit';

/**
 * Choix de la limite de contexte d'une session (lancement, défaut du projet) : me proposer (aucune action), compacter ou
 * repartir d'une conversation neuve au-delà d'un seuil en milliers de tokens. `warnK` : seuil de signalement de la
 * personne (null : signalement désactivé). `hint` : texte sous le champ.
 */
export default function ContextLimitField({ value, onChange, warnK, label = 'Contexte', hint, id }: { value: ContextLimit; onChange: (v: ContextLimit) => void; warnK?: number | null; label?: string; hint?: React.ReactNode; id: string }) {
  return (
    <Form.Group className="mb-3">
      <Form.Label className="mb-1" htmlFor={id}>
        {label}
      </Form.Label>
      <div className="d-flex gap-2 align-items-center flex-wrap">
        <Form.Select id={id} className="w-auto flex-grow-1" value={value.action} onChange={(e) => onChange({ ...value, action: e.target.value as ContextLimitAction })}>
          <option value="">{warnK ? `Me proposer de nettoyer au-delà de ${warnK} k tokens` : warnK === null ? 'Ne rien faire (signalement désactivé)' : 'Me proposer de nettoyer quand il grossit'}</option>
          <option value="compact">Compacter au-delà de…</option>
          <option value="reset">Repartir d'une conversation neuve au-delà de…</option>
        </Form.Select>
        {value.action && (
          <span className="d-flex gap-2 align-items-center">
            <Form.Control type="number" min={MIN_CONTEXT_K} step={10} value={Number.isFinite(value.maxK) ? value.maxK : ''} onChange={(e) => onChange({ ...value, maxK: Number(e.target.value) })} style={{ width: '6rem' }} aria-label="Seuil en milliers de tokens" />
            <span>k tokens</span>
          </span>
        )}
      </div>
      <Form.Text>
        {value.action === 'compact' && "À la fin d'un tour où le contexte dépasse le seuil, l'agent résume la conversation et repart de ce résumé (/compact). "}
        {value.action === 'reset' && "À la fin d'un tour où le contexte dépasse le seuil, la conversation repart de zéro ; un résumé des derniers échanges accompagne l'instruction suivante. "}
        {!value.action && 'Rien n\'est fait sans vous : au-delà du seuil, la session propose de compacter ou de repartir de zéro. '}
        {hint}
      </Form.Text>
    </Form.Group>
  );
}
