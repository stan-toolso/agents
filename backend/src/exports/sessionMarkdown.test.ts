import { describe, expect, it } from 'vitest';
import { fence, MAX_TOOL_TEXT, sessionToMarkdown, type MarkdownEvent, type MarkdownSession } from './sessionMarkdown.js';

const session: MarkdownSession = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Corriger le build',
  provider: 'claude',
  status: 'completed',
  prompt: 'Corrige le build',
  createdAt: new Date('2026-11-02T09:00:00Z'),
  projectName: 'Skipper',
  branch: 'task/build',
  ownerName: 'Camille',
  url: 'https://skipper.example/sessions/00000000-0000-0000-0000-000000000001',
};

const at = (min: number) => new Date(Date.UTC(2026, 10, 2, 9, min));
const assistant = (min: number, content: unknown[], parent: string | null = null): MarkdownEvent => ({ type: 'claude.assistant', createdAt: at(min), payload: { parent_tool_use_id: parent, message: { content } } });
const toolResult = (min: number, id: string, content: unknown, isError = false): MarkdownEvent => ({ type: 'claude.user', createdAt: at(min), payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } } });

const events: MarkdownEvent[] = [
  { type: 'instruction', createdAt: at(0), payload: { text: 'Corrige le build\nmerci', attachments: [{ name: 'log.txt' }] } },
  assistant(1, [{ type: 'thinking', thinking: 'secret de fabrication' }, { type: 'text', text: 'Je regarde le **build**.' }]),
  assistant(1, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }]),
  toolResult(2, 't1', 'error TS2322 ```code```', true),
  assistant(2, [{ type: 'tool_use', id: 't2', name: 'Agent', input: { description: 'Explorer', prompt: 'cherche' } }]),
  assistant(2, [{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/x' } }], 't2'),
  assistant(2, [{ type: 'text', text: 'message interne du sous-agent' }], 't2'),
  toolResult(3, 't2', [{ type: 'text', text: 'trouvé' }]),
  { type: 'request', createdAt: at(4), payload: { type: 'permission', title: 'Bash', payload: { toolName: 'Bash', input: { command: 'git push' } } } },
  { type: 'request.answered', createdAt: at(5), payload: { type: 'permission', response: { decision: 'deny', message: 'pas maintenant' } } },
  { type: 'request', createdAt: at(6), payload: { type: 'input', title: 'Quel environnement ?', message: 'Préproduction ou production ?', payload: {} } },
  { type: 'request.answered', createdAt: at(7), payload: { type: 'input', response: { text: 'Préproduction' } } },
  assistant(8, [{ type: 'text', text: 'Corrigé.' }]),
  { type: 'claude.result', createdAt: at(9), payload: { duration_ms: 75_000, total_cost_usd: 1.23 } },
  { type: 'rate_limit', createdAt: at(9), payload: { foo: 1 } },
];

describe('sessionToMarkdown', () => {
  const md = sessionToMarkdown(session, events, { now: new Date('2026-11-02T12:00:00Z') });

  it('met en tête le nom et les informations de la session', () => {
    expect(md.startsWith('# Corriger le build\n')).toBe(true);
    expect(md).toContain('- **Projet** : Skipper');
    expect(md).toContain('`task/build`');
    expect(md).toContain(session.url!);
  });

  it('cite les instructions et rend les réponses de l’agent', () => {
    expect(md).toContain('## 👤 Instruction');
    expect(md).toContain('> Corrige le build\n> merci');
    expect(md).toContain('📎 Fichiers joints : log.txt');
    expect(md).toContain('Je regarde le **build**.');
    expect(md).toContain('Corrigé.');
    // Un seul en-tête « Agent » par suite de messages de l'agent.
    expect(md.split('### 🤖 Agent').length - 1).toBe(2);
  });

  it('replie les appels d’outils avec leur entrée et leur résultat', () => {
    expect(md).toContain('<summary>🔧 Bash · npm run build · ⚠ erreur</summary>');
    expect(md).toContain('```bash\nnpm run build\n```');
    // Le résultat contient des accents graves : la clôture est plus longue.
    expect(md).toContain('````\nerror TS2322 ```code```\n````');
    expect(md).toContain('<summary>🔧 Sous-agent · Explorer · 1 appel d\'outils</summary>');
    expect(md.split('<details>').length).toBe(md.split('</details>').length);
  });

  it('omet le détail interne des sous-agents, la réflexion, le coût et les événements techniques', () => {
    expect(md).not.toContain('message interne du sous-agent');
    expect(md).not.toContain('secret de fabrication');
    expect(md).not.toContain('1.23');
    expect(md).not.toContain('foo');
  });

  it('montre les demandes faites aux humains et leurs réponses', () => {
    expect(md).toContain('### ⏸ Autorisation demandée');
    expect(md).toContain('**Bash · git push**');
    expect(md).toContain('> Refusé : pas maintenant');
    expect(md).toContain('**Quel environnement ?**');
    expect(md).toContain('> Préproduction ou production ?');
    expect(md).toContain('> Préproduction');
    expect(md).toContain('✻ Fin du tour · 1 min 15 s');
  });

  it('reprend la consigne de départ quand aucune instruction n’est journalisée', () => {
    const out = sessionToMarkdown(session, [assistant(1, [{ type: 'text', text: 'ok' }])]);
    expect(out).toContain('> Corrige le build');
  });

  it('coupe les sorties trop longues', () => {
    const out = sessionToMarkdown(session, [assistant(1, [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }]), toolResult(2, 'x', 'a'.repeat(MAX_TOOL_TEXT + 10))]);
    expect(out).toContain('10 caractères de plus, coupés à l\'export');
  });
});

describe('fence', () => {
  it('allonge la clôture au-delà des accents graves du contenu', () => {
    expect(fence('a ```` b')).toBe('`````\na ```` b\n`````');
    expect(fence('simple', 'json')).toBe('```json\nsimple\n```');
  });
});
