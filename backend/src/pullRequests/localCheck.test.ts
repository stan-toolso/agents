import { describe, expect, it } from 'vitest';
import { localCheckRefusal, parseLocalCheckConfig } from './localCheck.js';

describe('parseLocalCheckConfig', () => {
  it('lit la commande et le délai (600 s par défaut)', () => {
    expect(parseLocalCheckConfig('{ "command": " npm run ci " }')).toEqual({ command: 'npm run ci', timeoutSeconds: 600 });
    expect(parseLocalCheckConfig('{ "command": "make check", "timeout": 120 }')).toEqual({ command: 'make check', timeoutSeconds: 120 });
  });

  it('refuse un fichier invalide, sans commande ou au délai absurde', () => {
    expect(() => parseLocalCheckConfig('pas du json')).toThrow('JSON valide');
    expect(() => parseLocalCheckConfig('[]')).toThrow('objet');
    expect(() => parseLocalCheckConfig('{}')).toThrow('command');
    expect(() => parseLocalCheckConfig('{ "command": "x", "timeout": 1 }')).toThrow('timeout');
    expect(() => parseLocalCheckConfig('{ "command": "x", "timeout": "10" }')).toThrow('timeout');
  });
});

describe('localCheckRefusal', () => {
  it('ne dit rien quand il n’y a pas de contrôle ou qu’il passe', () => {
    expect(localCheckRefusal({ status: 'none' })).toBeNull();
    expect(localCheckRefusal({ status: 'passed', seconds: 3, command: 'npm run ci' })).toBeNull();
  });

  it('distingue l’échec du dépassement de délai, et explique force', () => {
    const failed = localCheckRefusal({ status: 'failed', seconds: 9, command: 'npm run ci', code: 1, timedOut: false, log: 'boom\n' });
    expect(failed).toContain('échoué (code 1');
    expect(failed).toContain('boom');
    expect(failed).toContain('force: true');
    expect(localCheckRefusal({ status: 'failed', seconds: 600, command: 'npm run ci', code: 124, timedOut: true, log: '' })).toContain('dépassé le délai');
    expect(localCheckRefusal({ status: 'config_error', error: 'cassé' })).toContain('force: true');
  });
});
