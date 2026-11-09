import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationJournalPath, missedMessages, parseJournal, readJournal, readSubagentEntries } from './cliJournal.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const assistant = (uuid: string, timestamp: string, text = uuid) => line({ type: 'assistant', uuid, timestamp, sessionId: 'conv', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const user = (uuid: string, timestamp: string, extra: Record<string, unknown> = {}) => line({ type: 'user', uuid, timestamp, sessionId: 'conv', message: { role: 'user', content: 'x' }, ...extra });
const costState = (total: number) => line({ type: 'cost-state', sessionId: 'conv', totalCostUSD: total, modelUsage: { 'claude-opus-5-5': { costUSD: total } } });

describe('conversationJournalPath', () => {
  it('encode le dossier de travail comme le CLI', () => {
    expect(conversationJournalPath('/h/.claude', '/home/skipper/ws/toolso.worktrees/revue-des-bases-09-11-08', 'abc')).toBe('/h/.claude/projects/-home-skipper-ws-toolso-worktrees-revue-des-bases-09-11-08/abc.jsonl');
  });
});

describe('parseJournal', () => {
  it('relève les cost-state et les messages, en ignorant le reste et une dernière ligne incomplète', () => {
    const text = [costState(3.74), assistant('a1', '2026-11-09T07:05:45.000Z'), line({ type: 'queue-operation', operation: 'enqueue' }), user('u1', '2026-11-09T07:06:26.000Z'), costState(4.35), '{"type":"assist'].join('\n');
    const parsed = parseJournal(text);
    expect(parsed.costStates).toEqual([
      { totalCostUSD: 3.74, modelCosts: { 'claude-opus-5-5': 3.74 } },
      { totalCostUSD: 4.35, modelCosts: { 'claude-opus-5-5': 4.35 } },
    ]);
    expect(parsed.entries.map((e) => e.uuid)).toEqual(['a1', 'u1']);
  });
});

describe('missedMessages', () => {
  // Cas du 09/11 : flux coupé à 07:05:45 ; les sous-agents puis l'agent ont continué dans le CLI.
  it('rend les messages postérieurs à la coupure et absents du flux, sous-agents rattachés à leur appel, dans l’ordre', () => {
    const main = parseJournal([assistant('a1', '2026-11-09T07:05:40.000Z'), user('n1', '2026-11-09T07:06:26.000Z'), assistant('a2', '2026-11-09T07:06:30.000Z'), user('meta', '2026-11-09T07:06:31.000Z', { isMeta: true })].join('\n')).entries;
    const subs = parseJournal([assistant('s1', '2026-11-09T07:05:49.000Z'), assistant('s0', '2026-11-09T07:05:44.000Z')].join('\n')).entries.map((e) => ({ ...e, parentToolUseId: 'toolu_fork' }));
    const missed = missedMessages(main, subs, '2026-11-09T07:05:45.000Z', new Set(['a2']));
    expect(missed.map((m) => m.uuid)).toEqual(['s1', 'n1']);
    expect(missed[0]).toMatchObject({ type: 'assistant', parent_tool_use_id: 'toolu_fork', recovered: true, session_id: 'conv' });
    expect(missed[1]).toMatchObject({ type: 'user', parent_tool_use_id: null });
  });
});

describe('lecture sur disque', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('lit le journal et ceux des sous-agents avec leur appel d’outil ; journal absent : null', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cli-journal-'));
    const file = path.join(dir, 'conv.jsonl');
    expect(await readJournal(file)).toBeNull();
    expect(await readSubagentEntries(file)).toEqual([]);
    await writeFile(file, [assistant('a1', '2026-11-09T07:00:00.000Z'), costState(1)].join('\n'));
    await mkdir(path.join(dir, 'conv', 'subagents'), { recursive: true });
    await writeFile(path.join(dir, 'conv', 'subagents', 'agent-x.jsonl'), assistant('s1', '2026-11-09T07:01:00.000Z'));
    await writeFile(path.join(dir, 'conv', 'subagents', 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'toolu_x' }));
    await writeFile(path.join(dir, 'conv', 'subagents', 'agent-y.jsonl'), assistant('s2', '2026-11-09T07:02:00.000Z'));
    expect((await readJournal(file))?.costStates).toHaveLength(1);
    const subs = await readSubagentEntries(file);
    expect(subs.map((s) => [s.uuid, s.parentToolUseId]).sort()).toEqual([
      ['s1', 'toolu_x'],
      ['s2', null],
    ]);
  });
});
