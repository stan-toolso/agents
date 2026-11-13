import { describe, expect, it } from 'vitest';
import { curlExamples } from './apiKeys';

describe('curlExamples', () => {
  it("montre l'API des tâches pour une clé tasks:write", () => {
    const out = curlExamples('https://s.example', 'skp_x', ['tasks:read', 'tasks:write'], null);
    expect(out).toContain('POST https://s.example/api/v1/tasks');
    expect(out).not.toContain('/api/v1/inbound');
  });
  it('montre un événement entrant avec triage', () => {
    const out = curlExamples('https://s.example', 'skp_x', ['inbound:task', 'inbound:triage'], null);
    expect(out).toContain('/api/v1/inbound');
    expect(out).toContain('"triage":true');
    expect(out).not.toContain('X-Skipper-Signature');
  });
  it('signe quand la clé a un secret de signature', () => {
    const out = curlExamples('https://s.example', 'skp_x', ['inbound:triage'], 'whs_s');
    expect(out).toContain("-hmac 'whs_s'");
    expect(out).toContain('X-Skipper-Signature: sha256=$SIG');
    expect(out).not.toContain('"task"');
  });
});
