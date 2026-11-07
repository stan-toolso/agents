import { useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { SCHEDULE_PERMISSION_SUGGESTIONS, type ScheduleToolSuggestion } from '../graphql/operations';
import { parseRule, ruleCovered, ruleLabel } from '../lib/scheduleRules';

/** Pourquoi un outil est proposé. */
function sourceText(s: ScheduleToolSuggestion): string {
  if (s.source === 'PROMPT') return "élément du coffre avec approbation, cité par l'instruction";
  const times = s.count > 1 ? `${s.count} exécutions` : '1 exécution';
  return s.source === 'DENIED' ? `refusé ou resté sans réponse (${times})` : `demandé puis accordé (${times})`;
}

/** Ce que deviendra, avec ce mode d'autorisation, un outil soumis à autorisation qui n'est pas pré-autorisé. */
function fateOf(mode: string): string {
  if (mode === 'dontAsk') return "chacun sera refusé sans demande (ou, pour un élément du coffre, attendra une réponse) et l'exécution sera notée « Bloquée »";
  return "chacun attendra une réponse : sans réponse après 10 minutes, l'exécution sera notée « Bloquée »";
}

/**
 * Outils pré-autorisés d'une planification (modale de planification) : la liste, l'ajout d'une règle, les
 * outils proposés d'après les exécutions passées et l'instruction, et l'avertissement quand le mode
 * d'autorisation de la session bloquera une exécution.
 */
export default function ScheduleTools({ value, onChange, projectId, scheduleId, prompt, permissionMode }: { value: string[]; onChange: (rules: string[]) => void; projectId: string; scheduleId: string | null; prompt: string; permissionMode: string }) {
  const [draft, setDraft] = useState('');
  const [debouncedPrompt, setDebouncedPrompt] = useState(prompt);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedPrompt(prompt), 600);
    return () => clearTimeout(handle);
  }, [prompt]);
  const { data } = useQuery<{ schedulePermissionSuggestions: ScheduleToolSuggestion[] }>(SCHEDULE_PERMISSION_SUGGESTIONS, {
    variables: { projectId, scheduleId, prompt: debouncedPrompt },
    skip: !projectId,
    fetchPolicy: 'cache-and-network',
  });
  const missing = (data?.schedulePermissionSuggestions ?? []).filter((s) => !ruleCovered(value, s.rule));
  const draftValid = draft.trim() === '' || parseRule(draft) !== null;
  const add = (rules: string[]) => onChange([...value, ...rules.filter((r) => !value.includes(r))]);
  const addDraft = () => {
    const rule = draft.trim();
    if (!rule || !parseRule(rule)) return;
    add([rule]);
    setDraft('');
  };
  const warn = permissionMode !== 'bypassPermissions' && missing.length > 0;

  return (
    <Form.Group className="mb-3">
      <Form.Label className="mb-1">Outils pré-autorisés pour les exécutions</Form.Label>
      <Form.Text className="d-block mt-0 mb-2">
        Autorisés sans demande pendant les exécutions de cette planification seulement : quand vous écrivez à la session, ses autorisations habituelles s'appliquent. Règles au format Claude Code, ex. <code>Bash(git log *)</code>,{' '}
        <code>mcp__vault__sql_query(production)</code>.
      </Form.Text>
      {value.length > 0 ? (
        <ul className="sch-tools">
          {value.map((rule) => (
            <li key={rule} className="sch-tool">
              <span className="sch-tool-label">{ruleLabel(rule)}</span>
              <code className="sch-tool-rule">{rule}</code>
              <button type="button" className="sch-tool-remove" title="Retirer" aria-label={`Retirer ${rule}`} onClick={() => onChange(value.filter((r) => r !== rule))}>
                <i className="bi bi-x-lg" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="small text-secondary mb-2">Aucun outil pré-autorisé.</div>
      )}
      <div className="d-flex gap-2">
        <Form.Control
          size="sm"
          className="font-monospace"
          value={draft}
          isInvalid={!draftValid}
          placeholder="Bash(git status *)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDraft();
            }
          }}
        />
        <Button size="sm" variant="outline-secondary" className="flex-shrink-0" disabled={!draft.trim() || !draftValid} onClick={addDraft}>
          Ajouter
        </Button>
      </div>
      {missing.length > 0 && (
        <Alert variant={warn ? 'warning' : 'secondary'} className="mt-2 mb-0 py-2 small">
          <div className="d-flex align-items-start justify-content-between gap-2 mb-1">
            <span>
              {scheduleId ? 'Outils soumis à autorisation lors des exécutions passées ou cités par l’instruction' : 'Éléments du coffre cités par l’instruction'}
              {warn ? <> : sans pré-autorisation, {fateOf(permissionMode)}.</> : ' :'}
            </span>
            {missing.length > 1 && (
              <Button size="sm" variant="outline-secondary" className="flex-shrink-0" onClick={() => add(missing.map((s) => s.rule))}>
                Tout ajouter
              </Button>
            )}
          </div>
          <ul className="sch-tools-suggested">
            {missing.map((s) => (
              <li key={s.rule}>
                <span>
                  <strong>{ruleLabel(s.rule)}</strong> <code>{s.rule}</code> <span className="text-secondary">· {sourceText(s)}</span>
                </span>
                <button type="button" className="sch-link" onClick={() => add([s.rule])}>
                  Pré-autoriser
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </Form.Group>
  );
}
