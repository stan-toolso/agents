import { canonicalContent, covers, parseRule, ruleMatches, splitShellCommand, type ParsedRule } from '../permissions/rules.js';
import { formatRule } from '../permissions/types.js';

/**
 * Outils pré-autorisés d'une planification : règles au format Claude Code (`Bash(git status *)`, `Read`,
 * `mcp__tasks`, `mcp__vault__sql_query(production)`), appliquées aux seuls tours lancés par la planification.
 * Ce module (pur, testé) les valide, décide si un appel est couvert, et propose des règles d'après les
 * exécutions passées (outils refusés ou demandés) et l'instruction (éléments du coffre avec approbation).
 */

/** Nombre maximal de règles d'une planification. */
export const MAX_SCHEDULE_RULES = 50;

/** Valide et normalise une liste de règles (forme canonique, sans doublon). Renvoie aussi les règles illisibles. */
export function normalizeRules(list: string[]): { rules: string[]; invalid: string[] } {
  const rules: string[] = [];
  const invalid: string[] = [];
  const parsed: ParsedRule[] = [];
  for (const raw of list) {
    const text = raw.trim();
    if (!text) continue;
    const rule = parseRule(text);
    if (!rule) {
      invalid.push(text);
      continue;
    }
    const canonical = { toolName: rule.toolName, ruleContent: canonicalContent(rule.toolName, rule.ruleContent) };
    if (parsed.some((p) => p.toolName === canonical.toolName && p.ruleContent === canonical.ruleContent)) continue;
    parsed.push(canonical);
    rules.push(formatRule(canonical));
  }
  return { rules, invalid };
}

/** Une commande Bash qui en exécute d'autres (substitution, sous-shell) n'est jamais couverte par un préfixe. */
const SHELL_SUBSTITUTION = /`|\$\(|<\(|>\(/;

/**
 * L'appel est-il couvert par les règles de la planification ? Plus strict que la correspondance qui date
 * l'usage des règles du projet : une commande Bash composée n'est couverte que si chacune de ses commandes
 * l'est, et une commande avec substitution ne l'est que par une règle `Bash` sans motif.
 */
export function scheduleAllows(rules: string[], toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  const parsed = rules.map(parseRule).filter((r): r is ParsedRule => r !== null);
  if (toolName === 'Bash') {
    if (parsed.some((r) => r.toolName === 'Bash' && r.ruleContent === null)) return true;
    if (typeof input.command !== 'string' || !input.command.trim() || SHELL_SUBSTITUTION.test(input.command)) return false;
    const bash = parsed.filter((r) => r.toolName === 'Bash' && r.ruleContent !== null);
    const parts = splitShellCommand(input.command);
    return parts.length > 0 && parts.every((part) => bash.some((r) => ruleMatches(r, 'Bash', { command: part }, cwd)));
  }
  return parsed.some((r) => ruleMatches(r, toolName, input, cwd));
}

/**
 * Un usage du coffre soumis à approbation (`mcp__vault__sql_query` sur l'élément `key`) est-il pré-autorisé ?
 * Règle sans motif (`mcp__vault__sql_query`, `mcp__vault`) : tout élément ; avec motif : le nom de l'élément.
 */
export function scheduleAllowsVault(rules: string[], toolName: string, key: string): boolean {
  return rules.some((text) => {
    const rule = parseRule(text);
    if (!rule) return false;
    if (rule.ruleContent === null) return ruleMatches(rule, toolName, {}, '/');
    return rule.toolName === toolName && rule.ruleContent.trim().toLowerCase() === key.trim().toLowerCase();
  });
}

/** Une règle est-elle déjà couverte par la liste ? (même outil plus large, ou serveur MCP entier) */
export function ruleCovered(rules: string[], text: string): boolean {
  const target = parseRule(text);
  if (!target) return false;
  return rules.some((r) => {
    const rule = parseRule(r);
    if (!rule) return false;
    if (covers(rule, target)) return true;
    return rule.ruleContent === null && ruleMatches(rule, target.toolName, {}, '/');
  });
}

/** Outils dont le premier mot ne suffit pas à dire ce que fait la commande : la sous-commande fait partie du préfixe. */
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'docker', 'kubectl', 'gh', 'aws', 'gcloud', 'scw', 'systemctl', 'cargo', 'go', 'pip', 'psql']);

/** Règle proposée pour autoriser un appel : `Bash(git log *)`, `mcp__vault__sql_query(production)`, sinon l'outil entier. */
export function ruleForCall(toolName: string, input: Record<string, unknown> | null | undefined): string {
  const args = input ?? {};
  if (toolName === 'Bash' && typeof args.command === 'string') {
    const first = splitShellCommand(args.command)[0] ?? '';
    const words = first.split(/\s+/).filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
    if (!words.length) return 'Bash';
    const prefix = SUBCOMMAND_TOOLS.has(words[0]) && words[1] && /^[a-z][\w:-]*$/.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
    return `Bash(${prefix} *)`;
  }
  if (toolName.startsWith('mcp__vault__') && typeof args.item === 'string' && args.item.trim()) return `${toolName}(${args.item.trim()})`;
  return toolName;
}

export type SuggestionSource = 'denied' | 'asked' | 'prompt';

export interface ToolSuggestion {
  rule: string;
  /** `denied` : refusé (mode « Refuser sans demander », refus, demande expirée) ; `asked` : demandé puis accordé ; `prompt` : élément du coffre cité par l'instruction. */
  source: SuggestionSource;
  /** Nombre d'exécutions passées où l'outil a été refusé ou demandé. */
  count: number;
  lastSeenAt: Date | null;
}

/** Une exécution passée : ses événements (après son jalon de début) et les demandes d'autorisation créées pendant elle. */
export interface PastRun {
  startedAt: Date;
  events: { type: string; payload: Record<string, unknown> }[];
  requests: { type: string; status: string; payload: Record<string, unknown>; response: Record<string, unknown> | null }[];
}

type Input = Record<string, unknown>;

/** Règles proposées par une demande d'autorisation : celles que suggérait le SDK (ou le coffre), sinon déduites de l'appel. */
function rulesOfRequest(payload: Input): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(payload.suggestions) ? (payload.suggestions as Input[]) : []) {
    if (s?.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules)) continue;
    for (const r of s.rules as Input[]) {
      if (typeof r?.toolName === 'string' && r.toolName) out.push(formatRule({ toolName: r.toolName, ruleContent: typeof r.ruleContent === 'string' ? r.ruleContent : null }));
    }
  }
  if (out.length) return out;
  return typeof payload.toolName === 'string' && payload.toolName ? [ruleForCall(payload.toolName, payload.input as Input)] : [];
}

/** Outils à pré-autoriser d'après les exécutions passées : refusés d'abord, puis accordés par un humain. */
export function suggestionsFromRuns(runs: PastRun[]): ToolSuggestion[] {
  const found = new Map<string, ToolSuggestion>();
  for (const run of runs) {
    const seen = new Map<string, SuggestionSource>();
    const note = (rule: string, source: SuggestionSource) => {
      if (seen.get(rule) !== 'denied') seen.set(rule, source);
    };
    for (const e of run.events) {
      if (e.type !== 'claude.result' || !Array.isArray(e.payload.permission_denials)) continue;
      for (const d of e.payload.permission_denials as Input[]) {
        if (typeof d?.tool_name === 'string' && d.tool_name) note(ruleForCall(d.tool_name, d.tool_input as Input), 'denied');
      }
    }
    for (const r of run.requests) {
      if (r.type !== 'permission') continue;
      const granted = r.status === 'answered' && r.response?.decision === 'allow';
      for (const rule of rulesOfRequest(r.payload)) note(rule, granted ? 'asked' : 'denied');
    }
    for (const [rule, source] of seen) {
      const prev = found.get(rule);
      found.set(rule, {
        rule,
        source: prev?.source === 'denied' || source === 'denied' ? 'denied' : 'asked',
        count: (prev?.count ?? 0) + 1,
        lastSeenAt: prev?.lastSeenAt && prev.lastSeenAt > run.startedAt ? prev.lastSeenAt : run.startedAt,
      });
    }
  }
  return [...found.values()].sort((a, b) => (a.source === b.source ? b.count - a.count : a.source === 'denied' ? -1 : 1));
}

/** Outils du coffre par type d'élément : ceux qu'une planification a besoin d'appeler. */
const VAULT_TOOLS: Partial<Record<string, string[]>> = {
  postgres: ['sql_query'],
  ssh: ['ssh_run'],
  api: ['http_request'],
  aws: ['aws_run'],
  scaleway: ['scw_run', 'scw_api'],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Éléments du coffre « avec approbation » cités par l'instruction : chaque usage attendrait un humain. */
export function suggestionsFromPrompt(prompt: string, items: { name: string; kind: string; requireApproval: boolean }[]): ToolSuggestion[] {
  const out: ToolSuggestion[] = [];
  for (const item of items) {
    const tools = VAULT_TOOLS[item.kind];
    if (!item.requireApproval || !tools || !item.name.trim()) continue;
    if (!new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRe(item.name.trim())}($|[^\\p{L}\\p{N}_-])`, 'iu').test(prompt)) continue;
    for (const tool of tools) out.push({ rule: `mcp__vault__${tool}(${item.name.trim()})`, source: 'prompt', count: 0, lastSeenAt: null });
  }
  return out;
}
