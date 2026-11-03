import type { HumanRequest, Session } from '../graphql/operations';
import type { TrackedPullRequest } from '../graphql/pullRequests';

/**
 * File « À traiter » : fusion des demandes, sessions et pull requests en une liste unique, triée par
 * urgence puis par ancienneté, et filtrable par projet et par nature. Fonctions pures (testées).
 */

export type InboxKind = 'request' | 'session' | 'pullRequest';
/** Une session qui attend simplement des instructions n'est pas « à traiter » : seules l'erreur et l'interruption y mènent. */
export type SessionReason = 'failed' | 'interrupted';

export type InboxItem =
  | { key: string; kind: 'request'; urgency: number; at: string; projectId: string; projectName: string; request: HumanRequest }
  | { key: string; kind: 'session'; urgency: number; at: string; projectId: string; projectName: string; session: Session; reason: SessionReason }
  | { key: string; kind: 'pullRequest'; urgency: number; at: string; projectId: string; projectName: string; pr: TrackedPullRequest };

/** Plus le chiffre est petit, plus c'est urgent : un agent bloqué d'abord, un brouillon en dernier. */
export const URGENCY = { request: 0, failed: 1, interrupted: 1, toMerge: 3, draft: 4 } as const;

export function sessionReason(s: Pick<Session, 'status'>): SessionReason {
  return s.status === 'FAILED' ? 'failed' : 'interrupted';
}

export interface InboxData {
  requests: HumanRequest[];
  sessions: Session[];
  pullRequests: TrackedPullRequest[];
}

export function buildInboxItems(data: InboxData): InboxItem[] {
  const items: InboxItem[] = [];
  for (const request of data.requests) {
    items.push({ key: `request:${request.id}`, kind: 'request', urgency: URGENCY.request, at: request.createdAt, projectId: request.session.project.id, projectName: request.session.project.name, request });
  }
  for (const session of data.sessions) {
    const reason = sessionReason(session);
    items.push({ key: `session:${session.id}`, kind: 'session', urgency: URGENCY[reason], at: session.endedAt ?? session.updatedAt, projectId: session.project.id, projectName: session.project.name, session, reason });
  }
  for (const pr of data.pullRequests) {
    items.push({ key: `pr:${pr.id}`, kind: 'pullRequest', urgency: pr.isDraft ? URGENCY.draft : URGENCY.toMerge, at: pr.openedAt, projectId: pr.project.id, projectName: pr.project.name, pr });
  }
  return items.sort((a, b) => a.urgency - b.urgency || new Date(a.at).getTime() - new Date(b.at).getTime() || a.key.localeCompare(b.key));
}

export function filterInboxItems(items: InboxItem[], filter: { projectId?: string; kind?: InboxKind | '' }): InboxItem[] {
  return items.filter((i) => (!filter.projectId || i.projectId === filter.projectId) && (!filter.kind || i.kind === filter.kind));
}

/** Projets présents dans la file, avec le nombre d'éléments, pour le filtre (le plus chargé d'abord). */
export function inboxProjects(items: InboxItem[]): { id: string; name: string; count: number }[] {
  const byId = new Map<string, { id: string; name: string; count: number }>();
  for (const i of items) {
    const p = byId.get(i.projectId) ?? { id: i.projectId, name: i.projectName, count: 0 };
    p.count += 1;
    byId.set(i.projectId, p);
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
