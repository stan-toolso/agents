import { describe, expect, it } from 'vitest';
import { toPublicEvents } from './publicEvents.js';

const ev = (id: string, type: string, payload: Record<string, unknown>) => ({ id, sessionId: 's1', type, payload, createdAt: new Date('2026-11-03T10:00:00Z') });

describe('toPublicEvents', () => {
  it('garde le transcript, retire réflexion, coût, fichiers joints et événements techniques', () => {
    const out = toPublicEvents([
      ev('1', 'instruction', { text: 'Fais X', attachments: [{ id: 'a', name: 'f.png' }] }),
      ev('2', 'claude.assistant', { message: { content: [{ type: 'thinking', thinking: 'secret interne' }, { type: 'text', text: 'Ok' }], usage: { input_tokens: 3 } } }),
      ev('3', 'claude.result', { subtype: 'success', duration_ms: 1200, total_cost_usd: 1.5, usage: {}, modelUsage: {} }),
      ev('4', 'stderr', { text: 'trace' }),
      ev('5', 'connection', { summary: 'select' }),
      ev('6', 'claude.system', { subtype: 'init', cwd: '/w', model: 'claude', tools: ['Bash'] }),
      ev('7', 'request', { type: 'question', title: 'Laquelle ?', payload: { questions: [] } }),
      ev('8', 'request.answered', { type: 'question', title: 'Laquelle ?', response: { answers: { q: 'A' } } }),
      ev('9', 'system', { message: 'interne' }),
      ev('10', 'rate_limit', {}),
    ]);
    expect(out.map((e) => e.id)).toEqual(['1', '2', '3', '6', '7', '8']);
    expect(out[0].payload).toEqual({ text: 'Fais X' });
    expect(out[1].payload).toEqual({ message: { content: [{ type: 'text', text: 'Ok' }] } });
    expect(out[2].payload).toEqual({ subtype: 'success', duration_ms: 1200 });
    expect(out[3].payload).toEqual({ subtype: 'init', cwd: '/w' });
    expect(out[5].payload.response).toEqual({ answers: { q: 'A' } });
    expect(out[0].createdAt).toBe('2026-11-03T10:00:00.000Z');
  });

  it('masque les secrets des appels d outils et de leurs résultats', () => {
    const out = toPublicEvents([
      ev('1', 'claude.assistant', { message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'export API_TOKEN=abcd1234' } }] } }),
      ev('2', 'claude.user', { message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ghp_abcdefghijklmnopqrstuvwxyz' }] } }),
    ]);
    expect(JSON.stringify(out)).not.toContain('abcd1234');
    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });
});
