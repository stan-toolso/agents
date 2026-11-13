/**
 * Export d'une session en Markdown, lisible sans l'application : les instructions, les réponses de l'agent, ses appels
 * d'outils repliés (`<details>`, que GitHub, GitLab, VS Code ou Obsidian affichent repliés et qui restent lisibles en
 * texte brut), les demandes faites aux humains et leurs réponses. Calcul pur, à partir des événements journalisés.
 */

export interface MarkdownSession {
  id: string;
  name: string;
  provider: string;
  status: string;
  prompt: string | null;
  createdAt: Date;
  projectName: string;
  branch: string | null;
  ownerName: string | null;
  /** Adresse de la session dans Skipper (rappelée en tête, pour qui a accès). */
  url: string | null;
}

export interface MarkdownEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date | string;
}

export interface MarkdownOptions {
  /** Fuseau des dates affichées. */
  timeZone?: string;
  /** Date de l'export (tests). */
  now?: Date;
}

/** Longueur maximale d'une entrée ou d'un résultat d'outil reproduits ; au-delà, la fin est coupée. */
export const MAX_TOOL_TEXT = 4000;

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const statusLabels: Record<string, string> = {
  pending: 'en attente',
  queued: 'en file d’attente',
  running: 'en cours',
  waiting: 'en attente d’une réponse',
  completed: 'terminée',
  failed: 'en échec',
  stopped: 'arrêtée',
  interrupted: 'interrompue',
};

function formatDate(value: Date | string, timeZone: string): string {
  return new Date(value).toLocaleString('fr-FR', { timeZone, dateStyle: 'long', timeStyle: 'short' });
}

/** Bloc de code dont la clôture est plus longue que toute suite d'accents graves du contenu. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${lang}\n${text.replace(/\n+$/, '')}\n${marks}`;
}

function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} caractères de plus, coupés à l'export)` : text;
}

/** Texte cité (blockquote), ligne à ligne, pour distinguer les messages humains. */
function quote(text: string): string {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** Texte sur une ligne, sans ce qui casserait un `<summary>`. */
function inline(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const short = one.length > max ? `${one.slice(0, max - 1)}…` : one;
  return short.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const str = (o: Record<string, unknown>, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined);

/** Libellé court d'un appel d'outil, comme dans le transcript : Bash(commande), Update(fichier), serveur - outil (MCP)… */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `Bash · ${str(input, 'command') ?? ''}`;
    case 'Read':
    case 'Write':
      return `${name} · ${str(input, 'file_path') ?? ''}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Update · ${str(input, 'file_path') ?? str(input, 'notebook_path') ?? ''}`;
    case 'Glob':
    case 'Grep':
      return `Search · ${str(input, 'pattern') ?? ''}`;
    case 'WebFetch':
      return `Fetch · ${str(input, 'url') ?? ''}`;
    case 'WebSearch':
      return `Web Search · ${str(input, 'query') ?? ''}`;
    case 'Task':
    case 'Agent':
      return `Sous-agent · ${str(input, 'description') ?? ''}`;
    case 'TodoWrite':
      return 'Liste de tâches';
    case 'Skill':
      return `Skill · ${str(input, 'skill') ?? ''}`;
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : name;
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return (content as Block[]).map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type ?? 'contenu'}]`)).join('\n');
  return content == null ? '' : JSON.stringify(content, null, 2);
}

/** Entrée d'un outil : la commande ou le contenu tels quels pour les plus courants, du JSON sinon. */
function toolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') return fence(clip(input.command), 'bash');
  if (name === 'Write' && typeof input.content === 'string') return fence(clip(input.content));
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const diff = [...input.old_string.split('\n').map((l) => `- ${l}`), ...input.new_string.split('\n').map((l) => `+ ${l}`)].join('\n');
    return fence(clip(diff), 'diff');
  }
  if (!Object.keys(input).length) return '';
  return fence(clip(JSON.stringify(input, null, 2)), 'json');
}

function describeAnswer(type: string, response: Record<string, unknown>): string {
  if (response.decision === 'allow') return response.always ? 'Autorisé pour toute la session' : 'Autorisé';
  if (response.decision === 'deny') return `Refusé${response.message ? ` : ${String(response.message)}` : ''}`;
  if (response.answers && typeof response.answers === 'object') {
    return Object.entries(response.answers as Record<string, unknown>)
      .map(([q, a]) => (type === 'question' ? `${q} → ${String(a)}` : String(a)))
      .join('\n');
  }
  if (typeof response.text === 'string') return response.text;
  if (typeof response.message === 'string') return response.message;
  return JSON.stringify(response);
}

export function sessionToMarkdown(session: MarkdownSession, events: MarkdownEvent[], opts: MarkdownOptions = {}): string {
  const timeZone = opts.timeZone ?? 'Europe/Paris';
  const date = (d: Date | string) => formatDate(d, timeZone);
  const out: string[] = [];
  const push = (...parts: string[]) => out.push(...parts, '');

  push(`# ${session.name}`);
  const meta = [
    `- **Projet** : ${session.projectName}`,
    `- **Agent** : ${session.provider}${session.ownerName ? ` · pilotée par ${session.ownerName}` : ''}`,
    `- **Créée le** : ${date(session.createdAt)} · ${statusLabels[session.status] ?? session.status}`,
  ];
  if (session.branch) meta.push(`- **Branche** : \`${session.branch}\``);
  if (session.url) meta.push(`- **Dans Skipper** : ${session.url}`);
  meta.push(`- **Exportée le** : ${date(opts.now ?? new Date())}`);
  push(meta.join('\n'));

  // Résultat de chaque appel d'outil (événement claude.user), et nombre d'appels internes des sous-agents.
  const results = new Map<string, { text: string; isError: boolean }>();
  const subCalls = new Map<string, number>();
  for (const e of events) {
    const content = (e.payload.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const parent = e.payload.parent_tool_use_id;
    for (const block of content as Block[]) {
      if (e.type === 'claude.user' && block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, { text: resultText(block.content), isError: Boolean(block.is_error) });
      else if (e.type === 'claude.assistant' && block.type === 'tool_use' && typeof parent === 'string') subCalls.set(parent, (subCalls.get(parent) ?? 0) + 1);
    }
  }

  let speaker: 'human' | 'agent' | null = null;
  const agentHeading = () => {
    if (speaker !== 'agent') push('### 🤖 Agent');
    speaker = 'agent';
  };

  if (session.prompt?.trim() && !events.some((e) => e.type === 'instruction')) {
    push(`## 👤 Instruction · ${date(session.createdAt)}`, quote(session.prompt));
    speaker = 'human';
  }

  for (const e of events) {
    const p = e.payload;
    if (p.parent_tool_use_id && (e.type === 'claude.assistant' || e.type === 'claude.user')) continue;
    switch (e.type) {
      case 'instruction': {
        const text = String(p.text ?? '').trim();
        if (!text) break;
        // Auteur (`InstructionAuthor`) journalisé depuis le 03/11/2026 : les instructions plus anciennes restent « Instruction ».
        const author = (p.author ?? null) as { type?: string; name?: string } | null;
        const who = typeof author?.name === 'string' && author.name ? author.name : 'Instruction';
        push(`## ${author?.type === 'session' ? '🤖' : author?.type === 'system' ? '⚙️' : '👤'} ${who} · ${date(e.createdAt)}`, quote(text));
        const files = Array.isArray(p.attachments) ? (p.attachments as Array<{ name?: string }>) : [];
        if (files.length) push(`📎 Fichiers joints : ${files.map((f) => f.name ?? 'fichier').join(', ')}`);
        speaker = 'human';
        break;
      }
      case 'claude.assistant': {
        const content = ((p.message as { content?: unknown } | undefined)?.content ?? []) as Block[];
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            agentHeading();
            push(block.text.trim());
          } else if (block.type === 'tool_use') {
            agentHeading();
            const name = block.name ?? 'outil';
            const input = block.input ?? {};
            const result = block.id ? results.get(block.id) : undefined;
            const calls = block.id ? subCalls.get(block.id) : undefined;
            const flags = [result?.isError ? '⚠ erreur' : '', calls ? `${calls} appel${calls > 1 ? 's' : ''} d'outils` : ''].filter(Boolean).join(', ');
            const body = [toolInput(name, input)];
            if (result?.text.trim()) body.push(`Résultat${result.isError ? ' (erreur)' : ''} :`, '', fence(clip(result.text)));
            push(`<details>\n<summary>🔧 ${inline(toolLabel(name, input))}${flags ? ` · ${flags}` : ''}</summary>\n`, body.filter(Boolean).join('\n\n'), '</details>');
          }
        }
        break;
      }
      case 'claude.user': {
        const content = (p.message as { content?: unknown } | undefined)?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Block[]).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('') : '';
        if (text.startsWith('[Request interrupted by user')) push('_⏹ Interrompu par un humain._');
        break;
      }
      case 'claude.result': {
        if ((p.origin as { kind?: unknown } | undefined)?.kind === 'task-notification' && p.num_turns === 0) break;
        const interrupted = p.terminal_reason === 'aborted_streaming' || p.terminal_reason === 'aborted_tools';
        const seconds = typeof p.duration_ms === 'number' ? Math.round(p.duration_ms / 1000) : null;
        const duration = seconds === null ? '' : seconds >= 60 ? ` · ${Math.floor(seconds / 60)} min ${seconds % 60} s` : ` · ${seconds} s`;
        const label = interrupted ? '⏹ Interrompu' : p.is_error ? `✗ Arrêt sur une erreur${Array.isArray(p.errors) && p.errors.length ? ` : ${p.errors.join(' ; ')}` : ''}` : '✻ Fin du tour';
        push(`_${label}${duration} · ${date(e.createdAt)}_`);
        speaker = null;
        break;
      }
      case 'request': {
        const type = String(p.type ?? '');
        const payload = (p.payload ?? {}) as { toolName?: string; input?: Record<string, unknown>; body?: unknown; message?: unknown };
        if (type === 'permission') {
          push(`### ⏸ Autorisation demandée · ${date(e.createdAt)}`, `L'agent demande à utiliser **${inline(toolLabel(payload.toolName ?? String(p.title ?? 'outil'), payload.input ?? {}))}**.`);
        } else {
          const detail = typeof p.message === 'string' ? p.message : typeof payload.body === 'string' ? payload.body : typeof payload.message === 'string' ? payload.message : '';
          push(`### ⏸ ${type === 'question' ? 'Question' : 'Demande'} de l'agent · ${date(e.createdAt)}`, `**${String(p.title ?? '')}**`, ...(detail.trim() ? [quote(detail)] : []));
        }
        speaker = null;
        break;
      }
      case 'request.answered': {
        const response = (p.response ?? {}) as Record<string, unknown>;
        push(`**👤 Réponse** · ${date(e.createdAt)}`, quote(describeAnswer(String(p.type ?? ''), response)));
        speaker = null;
        break;
      }
      case 'claude.system':
        if (p.subtype === 'compact_boundary') push('_🧹 Conversation compactée._');
        else if (p.subtype === 'task_notification' && p.summary) push(`_⏺ ${String(p.summary)}_`);
        break;
      case 'system':
        if (p.selfTurn) push(`_⏰ ${String(p.message ?? '')}_`);
        else if (p.notice) push(`_⚠ ${String(p.message ?? '')}_`);
        break;
      case 'stdout':
        push(fence(String(p.text ?? '')));
        break;
      case 'status': {
        const labels: Record<string, string> = { completed: 'Session terminée', failed: 'Session terminée avec une erreur', stopped: 'Session arrêtée', interrupted: 'Session interrompue' };
        push(`_■ ${labels[String(p.status)] ?? `Session ${String(p.status)}`}${p.error ? ` — ${String(p.error)}` : ''} · ${date(e.createdAt)}_`);
        speaker = null;
        break;
      }
      default:
        break;
    }
  }
  return `${out.join('\n').trim()}\n`;
}
