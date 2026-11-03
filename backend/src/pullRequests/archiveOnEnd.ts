import { agentService } from '../agents/service.js';
import { log } from '../log.js';
import { reviewOf } from '../reviews/types.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import type { TrackedPullRequest } from './types.js';

/**
 * Sessions d'agent rangées par Skipper à la fin de leur PR : tant que la PR de leur dossier est ouverte, elles ne
 * s'archivent pas (`sessionService.archiveWhenDone` refuse) ; elles le sont quand elle est fusionnée ou fermée. Seules
 * les sessions d'un agent de projet, non prises en main par une personne, ni sous-sessions, ni revues : une session
 * pilotée par une personne reste à sa main.
 */
export function archivedOnPullRequestEnd(session: Session, isAgent: boolean): boolean {
  if (!isAgent || session.archivedAt || session.takenOverById || session.parentSessionId) return false;
  return session.kind !== 'chat' && !reviewOf(session);
}

export async function archiveAgentSessionsOfPullRequest(pr: TrackedPullRequest): Promise<number> {
  const worksessions = (await worksessionRepository.listByProject(pr.projectId)).filter((w) => w.id === pr.worksessionId || w.branch === pr.headBranch);
  const reason = `PR #${pr.number} ${pr.status === 'merged' ? 'fusionnée' : 'fermée'}`;
  let archived = 0;
  for (const wt of worksessions) {
    for (const session of await sessionService.list({ worksessionId: wt.id, archived: 'exclude', limit: 50 })) {
      const isAgent = Boolean(await agentService.forUser(session.ownerId).catch(() => null));
      if (!archivedOnPullRequestEnd(session, isAgent)) continue;
      try {
        await sessionService.archiveWhenDone(session.id, reason, { force: true });
        archived++;
      } catch (err) {
        log.warn(`[pull-requests] session ${session.id} non archivée après ${reason}`, err);
      }
    }
  }
  if (archived) log.info(`[pull-requests] ${archived} session(s) d'agent archivée(s) : ${reason}`);
  return archived;
}
