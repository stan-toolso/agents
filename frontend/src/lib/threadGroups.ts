import { dayLabel } from './humanize';

/** Ce qu'il faut d'un message pour le ranger dans le fil (commentaire de tâche ou message de canal). */
export interface GroupableMessage {
  id: string;
  createdAt: string;
  authorName: string;
  author?: { id: string } | null;
  authorSession?: { id: string } | null;
  agent?: { id: string } | null;
}

/** Deux messages du même auteur à moins de cinq minutes se suivent sans répéter l'en-tête (avatar, nom, heure). */
export const GROUP_WINDOW_MS = 5 * 60_000;

/** Clé d'auteur : l'agent du projet, sinon la personne, sinon la session, sinon le nom affiché. */
export function authorKey(m: GroupableMessage): string {
  if (m.agent) return `agent:${m.agent.id}`;
  if (m.author) return `user:${m.author.id}`;
  if (m.authorSession) return `session:${m.authorSession.id}`;
  return `name:${m.authorName}`;
}

/**
 * Le message continue-t-il le précédent (même auteur, moins de cinq minutes, précédent sans fil de réponses) ? Il
 * s'affiche alors sans en-tête, collé au précédent, comme dans Slack.
 */
export function continuesPrevious(prev: GroupableMessage | null | undefined, cur: GroupableMessage, prevReplyCount = 0): boolean {
  if (!prev || prevReplyCount > 0) return false;
  if (authorKey(prev) !== authorKey(cur)) return false;
  const dt = new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return dt >= 0 && dt < GROUP_WINDOW_MS;
}

export type ThreadLayoutItem<T> = { kind: 'day'; key: string; label: string } | { kind: 'new'; key: string } | { kind: 'message'; key: string; message: T; continued: boolean };

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * Disposition d'un fil : les messages racines dans l'ordre, avec un séparateur de jour quand la date change, le
 * repère « Nouveaux messages » devant le premier message de quelqu'un d'autre postée après la dernière lecture
 * (`lastReadAt` ; null ou absent : canal jamais ouvert, pas de repère), et les messages qui continuent le précédent
 * repérés (`continued`) pour s'afficher sans en-tête. Un séparateur interrompt toujours un groupe.
 */
export function layoutThread<T extends GroupableMessage>(roots: T[], replyCount: (root: T) => number, opts: { lastReadAt?: string | null; viewerId?: string | null; now?: Date } = {}): ThreadLayoutItem<T>[] {
  const out: ThreadLayoutItem<T>[] = [];
  const now = opts.now ?? new Date();
  const since = opts.lastReadAt ? new Date(opts.lastReadAt).getTime() : null;
  let prev: T | null = null;
  let lastDay: string | null = null;
  let newShown = false;
  for (const m of roots) {
    let broke = false;
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      out.push({ kind: 'day', key: `day-${day}`, label: dayLabel(m.createdAt, now) });
      lastDay = day;
      broke = true;
    }
    if (since !== null && !newShown && new Date(m.createdAt).getTime() > since && (!opts.viewerId || m.author?.id !== opts.viewerId)) {
      out.push({ kind: 'new', key: 'new' });
      newShown = true;
      broke = true;
    }
    out.push({ kind: 'message', key: m.id, message: m, continued: !broke && continuesPrevious(prev, m, prev ? replyCount(prev) : 0) });
    prev = m;
  }
  return out;
}
