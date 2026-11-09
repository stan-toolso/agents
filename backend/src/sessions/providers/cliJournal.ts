import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Journal d'une conversation Claude Code (`<config>/projects/<cwd encodé>/<id>.jsonl`, et les journaux de ses
 * sous-agents dans `<id>/subagents/agent-*.jsonl`). C'est le relevé complet de ce que le CLI a fait, y compris quand le
 * flux vers Skipper est coupé : processus arrêté par Skipper alors que des sous-agents tournaient (le CLI, lancé par
 * `docker exec`, finit leur travail en orphelin), plantage, redémarrage du serveur. Skipper s'en sert pour ne rien
 * perdre (tâche 4df8e69d) :
 * - coût : à chaque sortie, le CLI écrit une ligne `cost-state` (coût cumulé de la conversation), qu'il reprend au
 *   lancement suivant. Comparée au dernier total relevé, elle donne le travail fait après le dernier tour (orphelin)
 *   ou, si elle est plus basse (processus tué sans l'écrire), le total de départ du prochain processus ;
 * - transcript : les messages (agent et sous-agents) écrits après la coupure du flux sont importés dans la session.
 */

export interface CostState {
  /** Coût cumulé de la conversation selon le CLI (dollars). */
  totalCostUSD: number;
  /** Coût cumulé par modèle. */
  modelCosts: Record<string, number>;
}

export interface JournalEntry {
  type: 'assistant' | 'user';
  uuid: string;
  timestamp: string;
  /** Ligne brute du journal. */
  line: Record<string, unknown>;
}

export interface ParsedJournal {
  costStates: CostState[];
  entries: JournalEntry[];
}

/** Chemin du journal d'une conversation, comme l'écrit le CLI (dossier de travail encodé). */
export function conversationJournalPath(configDir: string, cwd: string, conversationId: string): string {
  return path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${conversationId}.jsonl`);
}

/** Lecture d'un journal JSONL : lignes `cost-state` et messages (lignes illisibles ignorées, la dernière peut être en cours d'écriture). */
export function parseJournal(text: string): ParsedJournal {
  const costStates: CostState[] = [];
  const entries: JournalEntry[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (line.type === 'cost-state' && typeof line.totalCostUSD === 'number') {
      const modelCosts: Record<string, number> = {};
      for (const [model, usage] of Object.entries((line.modelUsage as Record<string, { costUSD?: unknown }> | undefined) ?? {})) {
        if (typeof usage?.costUSD === 'number') modelCosts[model] = usage.costUSD;
      }
      costStates.push({ totalCostUSD: line.totalCostUSD, modelCosts });
      continue;
    }
    if ((line.type === 'assistant' || line.type === 'user') && typeof line.uuid === 'string' && typeof line.timestamp === 'string' && line.message) {
      entries.push({ type: line.type, uuid: line.uuid, timestamp: line.timestamp, line });
    }
  }
  return { costStates, entries };
}

/** Message d'un sous-agent : sa ligne et l'appel d'outil qui l'a lancé (`parent_tool_use_id` des messages du flux). */
export interface SubagentEntry extends JournalEntry {
  parentToolUseId: string | null;
}

/**
 * Messages écrits après `after` (horodatage ISO) que le flux n'a pas apportés (`seen` : uuid reçus), du plus ancien au
 * plus récent, au format des messages du SDK (`recovered: true`). Les messages techniques du CLI (`isMeta`) sont écartés.
 */
export function missedMessages(main: JournalEntry[], subagents: SubagentEntry[], after: string, seen: ReadonlySet<string>): Record<string, unknown>[] {
  const pick = (e: JournalEntry) => e.timestamp > after && !seen.has(e.uuid) && !e.line.isMeta;
  const out = [
    ...main.filter(pick).map((e) => ({ e, parent: null as string | null })),
    ...subagents.filter(pick).map((e) => ({ e, parent: e.parentToolUseId })),
  ];
  out.sort((a, b) => (a.e.timestamp < b.e.timestamp ? -1 : a.e.timestamp > b.e.timestamp ? 1 : 0));
  return out.map(({ e, parent }) => ({
    type: e.type,
    uuid: e.uuid,
    session_id: e.line.sessionId ?? null,
    message: e.line.message,
    parent_tool_use_id: parent,
    timestamp: e.timestamp,
    recovered: true,
  }));
}

/** Lit le journal d'une conversation (null s'il n'existe pas). */
export async function readJournal(file: string): Promise<ParsedJournal | null> {
  try {
    return parseJournal(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Messages des sous-agents de la conversation, avec l'appel d'outil qui a lancé chacun (`<id>.meta.json`). */
export async function readSubagentEntries(file: string): Promise<SubagentEntry[]> {
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentEntry[] = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
    const meta = await readFile(path.join(dir, name.replace(/\.jsonl$/, '.meta.json')), 'utf8')
      .then((t) => JSON.parse(t) as { toolUseId?: unknown })
      .catch(() => null);
    const parentToolUseId = typeof meta?.toolUseId === 'string' ? meta.toolUseId : null;
    const parsed = await readJournal(path.join(dir, name)).catch(() => null);
    for (const e of parsed?.entries ?? []) out.push({ ...e, parentToolUseId });
  }
  return out;
}
