import { describe, expect, it } from 'vitest';
import { normalizeRules, ruleCovered, ruleForCall, scheduleAllows, scheduleAllowsVault, suggestionsFromPrompt, suggestionsFromRuns } from './permissions.js';

describe('normalizeRules', () => {
  it('normalise, déduplique et relève les règles illisibles', () => {
    expect(normalizeRules(['  Bash(git log:*) ', 'Bash(git log *)', 'mcp__vault__sql_query(production)', '', 'Bash(oops', 'Read'])).toEqual({
      rules: ['Bash(git log *)', 'mcp__vault__sql_query(production)', 'Read'],
      invalid: ['Bash(oops'],
    });
  });
});

describe('scheduleAllows', () => {
  const cwd = '/work';
  it('couvre une commande Bash dont chaque commande est autorisée', () => {
    const rules = ['Bash(git log *)', 'Bash(git status *)'];
    expect(scheduleAllows(rules, 'Bash', { command: 'git log --oneline -5' }, cwd)).toBe(true);
    expect(scheduleAllows(rules, 'Bash', { command: 'git status && git log -1' }, cwd)).toBe(true);
    expect(scheduleAllows(rules, 'Bash', { command: 'git log -1 && rm -rf /' }, cwd)).toBe(false);
    expect(scheduleAllows(rules, 'Bash', { command: 'git log $(rm -rf /)' }, cwd)).toBe(false);
    expect(scheduleAllows(rules, 'Bash', { command: 'git push' }, cwd)).toBe(false);
  });

  it('une règle Bash sans motif couvre toute commande', () => {
    expect(scheduleAllows(['Bash'], 'Bash', { command: 'echo `id`' }, cwd)).toBe(true);
  });

  it('couvre un outil entier, un serveur MCP et un chemin', () => {
    expect(scheduleAllows(['WebFetch'], 'WebFetch', { url: 'https://x.io' }, cwd)).toBe(true);
    expect(scheduleAllows(['mcp__google'], 'mcp__google__gmail_send', {}, cwd)).toBe(true);
    expect(scheduleAllows(['Edit(reports/**)'], 'Write', { file_path: '/work/reports/2026/a.md' }, cwd)).toBe(true);
    expect(scheduleAllows(['Edit(reports/**)'], 'Write', { file_path: '/work/src/a.ts' }, cwd)).toBe(false);
    expect(scheduleAllows([], 'Read', {}, cwd)).toBe(false);
  });
});

describe('scheduleAllowsVault', () => {
  it("autorise l'élément nommé, ou tout élément par une règle sans motif", () => {
    expect(scheduleAllowsVault(['mcp__vault__sql_query(Production)'], 'mcp__vault__sql_query', 'production')).toBe(true);
    expect(scheduleAllowsVault(['mcp__vault__sql_query(production)'], 'mcp__vault__sql_query', 'staging')).toBe(false);
    expect(scheduleAllowsVault(['mcp__vault__sql_query(production)'], 'mcp__vault__ssh_run', 'production')).toBe(false);
    expect(scheduleAllowsVault(['mcp__vault__sql_query'], 'mcp__vault__sql_query', 'staging')).toBe(true);
    expect(scheduleAllowsVault(['mcp__vault'], 'mcp__vault__ssh_run', 'serveur')).toBe(true);
  });
});

describe('ruleCovered', () => {
  it('reconnaît une règle déjà couverte par une plus large', () => {
    expect(ruleCovered(['Bash(git *)'], 'Bash(git log *)')).toBe(true);
    expect(ruleCovered(['mcp__vault'], 'mcp__vault__sql_query(production)')).toBe(true);
    expect(ruleCovered(['mcp__vault__sql_query(production)'], 'mcp__vault__sql_query(production)')).toBe(true);
    expect(ruleCovered(['Bash(git log *)'], 'Bash(git push *)')).toBe(false);
  });
});

describe('ruleForCall', () => {
  it('propose un préfixe Bash, un élément du coffre ou l’outil entier', () => {
    expect(ruleForCall('Bash', { command: 'git log --since=yesterday | head' })).toBe('Bash(git log *)');
    expect(ruleForCall('Bash', { command: 'NODE_ENV=prod node scripts/report.js' })).toBe('Bash(node *)');
    expect(ruleForCall('mcp__vault__sql_query', { item: 'production', sql: 'select 1' })).toBe('mcp__vault__sql_query(production)');
    expect(ruleForCall('WebFetch', { url: 'https://x.io' })).toBe('WebFetch');
  });
});

describe('suggestionsFromRuns', () => {
  const at = (d: string) => new Date(d);
  it('propose les outils refusés puis ceux accordés, comptés par exécution', () => {
    const runs = [
      {
        startedAt: at('2026-10-02T05:00:00Z'),
        events: [{ type: 'claude.result', payload: { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git fetch origin' } }, { tool_name: 'Bash', tool_input: { command: 'git fetch --all' } }] } }],
        requests: [
          { type: 'permission', status: 'pending', payload: { toolName: 'mcp__vault__sql_query', suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'mcp__vault__sql_query', ruleContent: 'production' }] }] }, response: null },
          { type: 'question', status: 'answered', payload: {}, response: {} },
        ],
      },
      {
        startedAt: at('2026-10-05T05:00:00Z'),
        events: [],
        requests: [
          { type: 'permission', status: 'answered', payload: { toolName: 'WebFetch', input: { url: 'https://x.io' } }, response: { decision: 'allow' } },
          { type: 'permission', status: 'answered', payload: { toolName: 'Bash', input: { command: 'git fetch' } }, response: { decision: 'allow' } },
        ],
      },
    ];
    expect(suggestionsFromRuns(runs)).toEqual([
      { rule: 'Bash(git fetch *)', source: 'denied', count: 2, lastSeenAt: at('2026-10-05T05:00:00Z') },
      { rule: 'mcp__vault__sql_query(production)', source: 'denied', count: 1, lastSeenAt: at('2026-10-02T05:00:00Z') },
      { rule: 'WebFetch', source: 'asked', count: 1, lastSeenAt: at('2026-10-05T05:00:00Z') },
    ]);
  });
});

describe('suggestionsFromPrompt', () => {
  it("propose les outils des éléments avec approbation cités par l'instruction", () => {
    const items = [
      { name: 'production', kind: 'postgres', requireApproval: true },
      { name: 'staging', kind: 'postgres', requireApproval: false },
      { name: 'skipper-1', kind: 'ssh', requireApproval: true },
      { name: 'prod', kind: 'postgres', requireApproval: true },
    ];
    expect(suggestionsFromPrompt('Fais le point sur la base Production et sur staging.', items).map((s) => s.rule)).toEqual(['mcp__vault__sql_query(production)']);
    expect(suggestionsFromPrompt('Regarde les logs de skipper-1', items).map((s) => s.rule)).toEqual(['mcp__vault__ssh_run(skipper-1)']);
  });
});
