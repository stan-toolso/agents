import { describe, expect, it } from 'vitest';
import type { ConfigField } from '../graphql/operations';
import { agentConfigFields, agentConfigValues, agentProvider } from './agentSessions';

const fields: ConfigField[] = [
  { key: 'permissionMode', label: 'Autorisations', type: 'select', required: false, options: [{ value: 'default', label: 'Demander' }, { value: 'plan', label: 'Plan' }] },
  { key: 'model', label: 'Modèle', type: 'select', required: false, advanced: true, options: [{ value: '', label: 'Par défaut' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] },
];

describe('sessions jouées par un agent', () => {
  it('type de session : celui de l’agent s’il est proposé, Claude Code sinon', () => {
    expect(agentProvider({ defaults: { provider: 'opencode' }, allowedModels: [] }, ['claude', 'opencode'])).toBe('opencode');
    expect(agentProvider({ defaults: {}, allowedModels: [] }, ['claude', 'opencode'])).toBe('claude');
    expect(agentProvider({ defaults: { provider: 'opencode' }, allowedModels: [] }, ['claude'])).toBeNull();
  });

  it('valeurs : modèle de l’agent s’il est autorisé, sinon le premier autorisé ; autorisations de l’agent', () => {
    expect(agentConfigValues({ defaults: { model: 'sonnet', permissionMode: 'plan' }, allowedModels: [] }, fields)).toEqual({ model: 'sonnet', permissionMode: 'plan' });
    expect(agentConfigValues({ defaults: { model: 'haiku' }, allowedModels: ['opus'] }, fields)).toEqual({ model: 'opus' });
    expect(agentConfigValues({ defaults: {}, allowedModels: [] }, fields)).toEqual({ model: '' });
  });

  it('champs : le modèle ne propose que les modèles autorisés', () => {
    const out = agentConfigFields({ defaults: {}, allowedModels: ['sonnet', 'custom-x'] }, fields);
    expect(out[1].options).toEqual([{ value: 'sonnet', label: 'Sonnet' }, { value: 'custom-x', label: 'custom-x' }]);
    expect(agentConfigFields({ defaults: {}, allowedModels: [] }, fields)).toBe(fields);
    expect(agentConfigFields(null, fields)).toBe(fields);
  });
});
