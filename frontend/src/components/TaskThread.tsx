import { useMutation } from '@apollo/client';
import { useCallback, useMemo, type ReactNode } from 'react';
import { ADD_TASK_COMMENT, DELETE_TASK_COMMENT, TASK_THREAD, TOGGLE_TASK_REACTION, UPDATE_TASK_COMMENT } from '../graphql/tasks';
import type { TaskComment, TaskMentionable, TaskReaction } from '../graphql/operations';
import type { AttachmentRef } from '../lib/attachments';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';
import TaskAttachments from './TaskAttachments';
import { Avatar, Composer, Reactions, RootMessage, SessionLink, ThreadProvider, fmtFull, groupThread, useThreadAnchor, type ThreadApi, type ThreadMessage } from './Thread';

const REFETCH = ['TaskThread', 'Tasks', 'TaskDetail', 'TaskPage'];

interface ThreadData {
  task: { id: string; commentCount: number; reactions: TaskReaction[]; mentionables: TaskMentionable[]; comments: TaskComment[] } | null;
}

/** Le message d'ouverture du fil (la description de la tâche), rendu par la page de la tâche avec les mêmes codes qu'un message. */
export interface ThreadOpening {
  authorName: string;
  byAgent: boolean;
  /** Session qui a ouvert la tâche (lien discret à côté de l'auteur). */
  session: { id: string; name: string } | null;
  createdAt: string;
  body: ReactNode;
  attachments: AttachmentRef[];
}

/**
 * Le fil de discussion d'une tâche, à la manière d'un canal Slack : le message d'ouverture (`opening`, la description
 * de la tâche, rendu par la page), puis les messages dans l'ordre, chacun avec ses réponses en fil, ses réactions et
 * ses mentions ; en bas, la zone de saisie. `canWrite` : les lecteurs du projet lisent sans écrire. `compact` :
 * dans le panneau de droite ou une modale. Le rendu vient du moteur commun (components/Thread.tsx).
 */
export default function TaskThread({ taskId, opening, canWrite = true, compact = false }: { taskId: string; opening?: ThreadOpening; canWrite?: boolean; compact?: boolean }) {
  const { data } = usePollingQuery<ThreadData>(TASK_THREAD, { variables: { id: taskId }, pollInterval: 10_000 });
  const { showError } = useDialogs();
  const [toggleReaction] = useMutation(TOGGLE_TASK_REACTION, { refetchQueries: ['TaskThread'], onError: (e) => void showError(e) });
  const [add] = useMutation(ADD_TASK_COMMENT, { refetchQueries: REFETCH });
  const [update] = useMutation(UPDATE_TASK_COMMENT, { refetchQueries: REFETCH });
  const [remove] = useMutation(DELETE_TASK_COMMENT, { refetchQueries: REFETCH });
  const toggle = useCallback((commentId: string | null, emoji: string) => void toggleReaction({ variables: { taskId, commentId, emoji } }), [taskId, toggleReaction]);
  const api = useMemo<ThreadApi>(
    () => ({
      anchor: 'comment',
      files: true,
      send: ({ body, parentId, attachments }) => add({ variables: { taskId, body, attachments, parentId } }),
      update: ({ id, body, removeAttachmentIds }) => update({ variables: { id, body, removeAttachmentIds } }),
      remove: (id) => remove({ variables: { id } }),
      toggleReaction: toggle,
      renderAttachments: (m: ThreadMessage, edit) => <TaskAttachments taskId={taskId} attachments={m.attachments ?? []} removed={edit?.removed} onToggleRemove={edit?.onToggleRemove} />,
    }),
    [add, update, remove, toggle, taskId],
  );
  const comments = data?.task?.comments ?? [];
  const mentionables = data?.task?.mentionables ?? [];
  const { roots, byParent } = useMemo(() => groupThread(comments), [comments]);
  useThreadAnchor('comment', Boolean(data));

  return (
    <ThreadProvider api={api} mentionables={mentionables} canWrite={canWrite} compact={compact}>
      <div className={`tt${compact ? ' tt-compact' : ''}`}>
        {opening && (
          <div className="tt-msg tt-opening">
            <Avatar name={opening.authorName} agent={opening.byAgent} />
            <div className="tt-msg-main">
              <div className="tt-msg-head">
                <span className="tt-author">{opening.authorName}</span>
                {opening.byAgent && <span className="tt-badge-agent">agent</span>}
                {opening.session && <SessionLink session={opening.session} />}
                <span className="tt-time" title={fmtFull(opening.createdAt)}>
                  a ouvert la tâche {timeAgo(opening.createdAt)}
                </span>
              </div>
              <div className="tt-body tt-opening-body">{opening.body}</div>
              <TaskAttachments taskId={taskId} attachments={opening.attachments} />
              <Reactions reactions={data?.task?.reactions ?? []} onToggle={(e) => toggle(null, e)} />
            </div>
          </div>
        )}
        {data && comments.length === 0 && <div className="tt-empty">Pas encore de message. {canWrite && 'Écrivez le premier : les sessions reliées à la tâche le recevront.'}</div>}
        {roots.map((root) => (
          <RootMessage key={root.id} root={root} replies={byParent.get(root.id) ?? []} />
        ))}
        {canWrite && <Composer placeholder="Écrire dans le fil… (@ pour mentionner une personne ou une session)" compact={compact} />}
      </div>
    </ThreadProvider>
  );
}
