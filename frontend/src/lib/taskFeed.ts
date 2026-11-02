/**
 * Textes que Skipper transmet à une session reliée à une tâche (backend `tasks/sessionFeed.ts`) : modification,
 * message du fil, réaction. Le transcript les résume en une ligne repliée, le texte complet (celui que lit l'agent)
 * restant visible au clic.
 */
export interface TaskFeedSummary {
  kind: 'update' | 'comment' | 'reaction';
  taskId: string | null;
  title: string | null;
  /** Une ligne : qui a fait quoi. */
  summary: string;
}

const PREFIXES: Array<[string, TaskFeedSummary['kind']]> = [
  ['[Mise à jour de la tâche]', 'update'],
  ['[Commentaire sur la tâche]', 'comment'],
  ['[Réaction sur la tâche]', 'reaction'],
  // Canaux de conversation (backend conversations/feed.ts) : même rendu, sans tâche.
  ['[Message dans un canal]', 'comment'],
  ['[Réaction dans un canal]', 'reaction'],
];

const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Résumé d'un texte du fil des tâches, null si le texte n'en est pas un. */
export function describeTaskFeed(text: string): TaskFeedSummary | null {
  const prefix = PREFIXES.find(([p]) => text.startsWith(p));
  if (!prefix) return null;
  const kind = prefix[1];
  const lines = text.split('\n');
  const head = lines[0].slice(prefix[0].length).trim();
  if (prefix[0].endsWith('canal]')) return describeChannelFeed(kind, head, lines);
  // Le titre peut contenir lui-même des guillemets : on prend jusqu'au dernier « ») » de la ligne.
  const task = /tâche (\S+) \(« (.*) »\)/.exec(head);
  const taskId = task?.[1] ?? null;
  const title = task?.[2] ?? null;
  const named = title ? `« ${title} »` : 'reliée';
  if (kind === 'update') {
    const by = / a été modifiée par (.*) :$/.exec(head)?.[1]?.replace(/ \([0-9a-f-]{36}\)$/, '');
    const changes = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    return { kind, taskId, title, summary: clip(`Tâche ${named}${by ? ` modifiée par ${by}` : ' modifiée'}${changes.length ? ` · ${changes.join(' · ')}` : ''}`) };
  }
  if (kind === 'comment') {
    // `- Alice, 2026-10-10 09:30 UTC (message c1) :` puis le corps indenté.
    const at = lines.findIndex((l) => l.startsWith('- '));
    const author = at >= 0 ? /^- (.*?), \d{4}-\d{2}-\d{2}/.exec(lines[at])?.[1] : undefined;
    const first = at >= 0 ? lines.slice(at + 1).find((l) => l.startsWith('  ') && l.trim()) : undefined;
    return { kind, taskId, title, summary: clip(`${author ?? 'Nouveau message'} dans la tâche ${named}${first ? ` : ${first.trim()}` : ''}`) };
  }
  const reaction = head.replace(/ de la tâche .*$/, '');
  return { kind, taskId, title, summary: clip(`${reaction} · tâche ${named}`) };
}

/** Résumé d'un texte des canaux : « Alice dans #general (fil « … ») : première ligne », ou la réaction reçue. */
function describeChannelFeed(kind: TaskFeedSummary['kind'], head: string, lines: string[]): TaskFeedSummary {
  const thread = /fil « (.*) » du canal (#\S+)/.exec(head);
  const title = thread?.[1] ?? null;
  const channel = thread?.[2] ?? /dans (#\S+)/.exec(head)?.[1] ?? 'un canal';
  if (kind === 'comment') {
    const at = lines.findIndex((l) => l.startsWith('- '));
    const author = at >= 0 ? /^- (.*?), \d{4}-\d{2}-\d{2}/.exec(lines[at])?.[1] : undefined;
    const first = at >= 0 ? lines.slice(at + 1).find((l) => l.startsWith('  ') && l.trim()) : undefined;
    return { kind, taskId: null, title, summary: clip(`${author ?? 'Nouveau message'} dans ${channel}${title ? ` (fil « ${title} »)` : ''}${first ? ` : ${first.trim()}` : ''}`) };
  }
  return { kind, taskId: null, title, summary: clip(head.replace(/\. Rien à faire.*$/, '')) };
}
