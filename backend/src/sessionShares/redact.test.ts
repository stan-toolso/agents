import { describe, expect, it } from 'vitest';
import { MASK, redactDeep, redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it.each([
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_'],
    ['glpat-abcdefghij0123456789', 'glpat-'],
    ['skp_abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'skp_'],
    ['AKIATWHKSEC6VQU6DFFL', 'AKIA'],
    ['xoxb-1234567890-abcdefghij', 'xox-'],
  ])('masque %s', (secret, prefix) => {
    const out = redactSecrets(`avant ${secret} après`);
    expect(out).not.toContain(secret);
    expect(out).toBe(`avant ${prefix}${MASK} après`);
  });

  it('masque en-têtes, URL, PEM, JWT et affectations', () => {
    const text = [
      'curl -H "Authorization: Bearer abc.def-ghi_jkl" https://x',
      'postgres://skipper:motdepasse123@db:5432/skipper',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\nC1yc2E\n-----END OPENSSH PRIVATE KEY-----',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'DATABASE_PASSWORD=hunter2hunter',
      'export GITHUB_TOKEN="tok-1234"',
      '{"apiKey": "valeur-secrete", "name": "visible"}',
    ].join('\n');
    const out = redactSecrets(text);
    for (const secret of ['abc.def-ghi_jkl', 'motdepasse123', 'AAAAB3Nza', 'dozjgNryP4J3jVmNHl0w5N', 'hunter2hunter', 'tok-1234', 'valeur-secrete']) expect(out).not.toContain(secret);
    expect(out).toContain('postgres://skipper:[masqué]@db:5432/skipper');
    expect(out).toContain('DATABASE_PASSWORD=[masqué]');
    expect(out).toContain('"name": "visible"');
  });

  it('laisse le texte ordinaire intact', () => {
    const text = 'Le token de session expire ; voir https://skipper.toolso.io/sessions/abc et input_tokens: 1234.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('masque les chaînes et les champs sensibles, garde le reste', () => {
    const out = redactDeep({ input: { command: 'echo sk-ant-abcdefghijklmnop', password: 'x1', db_secret: 'y2', count: 3 }, list: ['ghp_abcdefghijklmnopqrstuvwxyz'] });
    expect(out).toEqual({ input: { command: `echo sk-ant-${MASK}`, password: MASK, db_secret: MASK, count: 3 }, list: [`ghp_${MASK}`] });
  });
});
