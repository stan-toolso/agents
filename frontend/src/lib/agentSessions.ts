import type { ConfigField } from '../graphql/operations';

/** Ce que les lanceurs de session lisent d'un agent : son type de session et ses modèles. */
export interface AgentSessionDefaults {
  defaults: Record<string, unknown>;
  allowedModels: string[];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Type de session par défaut de l'agent parmi ceux proposés (Claude Code sinon). */
export function agentProvider(agent: AgentSessionDefaults, available: string[]): string | null {
  const wanted = str(agent.defaults.provider) ?? 'claude';
  return available.includes(wanted) ? wanted : null;
}

/** Valeurs du formulaire préremplies par l'agent : son modèle (ou le premier autorisé) et ses autorisations par défaut. */
export function agentConfigValues(agent: AgentSessionDefaults, fields: ConfigField[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (fields.some((f) => f.key === 'model')) {
    const model = str(agent.defaults.model);
    const allowed = agent.allowedModels;
    out.model = allowed.length ? (model && allowed.includes(model) ? model : allowed[0]) : (model ?? '');
  }
  const mode = str(agent.defaults.permissionMode);
  const modeField = fields.find((f) => f.key === 'permissionMode');
  if (mode && modeField?.options?.some((o) => o.value === mode)) out.permissionMode = mode;
  return out;
}

/**
 * Champs de configuration pour une session jouée par l'agent : le modèle ne propose que ses modèles autorisés (ceux
 * absents de la liste du provider ajoutés tels quels), sans l'option « par défaut » qui pourrait en sortir.
 */
export function agentConfigFields(agent: AgentSessionDefaults | null, fields: ConfigField[]): ConfigField[] {
  if (!agent?.allowedModels.length) return fields;
  return fields.map((f) => {
    if (f.key !== 'model') return f;
    const options = agent.allowedModels.map((m) => f.options?.find((o) => o.value === m) ?? { value: m, label: m });
    return { ...f, options, defaultValue: options[0]?.value ?? null, advanced: false, description: 'Les modèles autorisés pour cet agent (réglés dans sa fiche).' };
  });
}
