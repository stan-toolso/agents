import { useMutation } from '@apollo/client';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Button } from 'react-bootstrap';
import { CONVERSATION_MESSAGES, DELETE_MESSAGE, MARK_CONVERSATION_READ, POST_MESSAGE, TOGGLE_MESSAGE_REACTION, UPDATE_MESSAGE, type ChannelMessage, type Conversation } from '../graphql/conversations';
import type { TaskMentionable } from '../graphql/operations';
import { messageAttachmentUrl } from '../lib/attachments';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';
import TaskAttachments from './TaskAttachments';
import { Composer, RootMessage, ThreadProvider, groupThread, useThreadAnchor, type ThreadApi, type ThreadMessage } from './Thread';

/** Requêtes à rafraîchir après une écriture : le canal lui-même, la liste des canaux (non-lus) et l'onglet. */
const REFETCH = ['ConversationMessages', 'ProjectConversations', 'ProjectUnreadMessages', 'ProjectDashboard'];
/** Sondage du canal affiché : assez serré pour voir arriver une réponse d'agent sans abonnement. */
const POLL_MS = 4000;

interface Data {
  conversation: (Conversation & { messageCount: number; mentionables: TaskMentionable[]; messages: ChannelMessage[] }) | null;
}

/**
 * Un canal de conversation : ses derniers messages racines avec leurs réponses en fil (moteur commun
 * components/Thread.tsx), les agents qui répondent, et la zone de saisie en bas. Marque le canal lu à l'affichage et
 * à chaque nouveau message vu. `limit` : nombre de messages racines (le tableau de bord en montre moins).
 */
export default function ChannelThread({ conversationId, canWrite, compact = false, limit = 50, placeholder }: { conversationId: string; canWrite: boolean; compact?: boolean; limit?: number; placeholder?: string }) {
  const { data, refetch } = usePollingQuery<Data>(CONVERSATION_MESSAGES, { variables: { id: conversationId, limit }, pollInterval: POLL_MS, fetchPolicy: 'cache-and-network' });
  const { showError } = useDialogs();
  const [toggleReaction] = useMutation(TOGGLE_MESSAGE_REACTION, { refetchQueries: ['ConversationMessages'], onError: (e) => void showError(e) });
  const [post] = useMutation(POST_MESSAGE, { refetchQueries: REFETCH });
  const [update] = useMutation(UPDATE_MESSAGE, { refetchQueries: ['ConversationMessages'] });
  const [remove] = useMutation(DELETE_MESSAGE, { refetchQueries: REFETCH });
  const [markRead] = useMutation(MARK_CONVERSATION_READ, { refetchQueries: ['ProjectConversations', 'ProjectUnreadMessages', 'ProjectDashboard'] });
  const toggle = useCallback((messageId: string | null, emoji: string) => messageId && void toggleReaction({ variables: { messageId, emoji } }), [toggleReaction]);
  const api = useMemo<ThreadApi>(
    () => ({
      anchor: 'm',
      files: true,
      send: ({ body, parentId, attachments }) => post({ variables: { conversationId, body, parentId, attachments } }),
      update: ({ id, body, removeAttachmentIds }) => update({ variables: { id, body, removeAttachmentIds } }),
      remove: (id) => remove({ variables: { id } }),
      toggleReaction: toggle,
      renderAttachments: (m: ThreadMessage, edit) => (
        <TaskAttachments urlFor={(id) => messageAttachmentUrl(conversationId, id)} attachments={m.attachments ?? []} removed={edit?.removed} onToggleRemove={edit?.onToggleRemove} />
      ),
    }),
    [post, update, remove, toggle, conversationId],
  );
  const conversation = data?.conversation ?? null;
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const { roots, byParent } = useMemo(() => groupThread(messages), [messages]);
  useThreadAnchor('m', Boolean(data));

  // Lu : à l'affichage, puis dès qu'un message des autres arrive pendant que le canal est affiché.
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!conversation) return;
    const newest = messages.length ? messages[messages.length - 1].id : 'none';
    if (lastSeen.current === newest) return;
    lastSeen.current = newest;
    if (conversation.unreadCount > 0 || lastSeen.current === 'none') void markRead({ variables: { id: conversation.id } });
  }, [conversation, messages, markRead]);

  const shown = roots.length;
  const total = conversation?.messageCount ?? 0;
  const hasMore = Boolean(conversation && total > messages.length);
  // Le fil se lit de haut en bas : le plus récent en bas, comme un chat ; on le fait défiler au premier affichage.
  const bottom = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !data || window.location.hash.startsWith('#m-')) return;
    scrolled.current = true;
    // Seul le conteneur du canal défile (pas la page) : le dernier message en bas.
    const box = bottom.current?.closest<HTMLElement>('.ch-scroll');
    if (box) box.scrollTop = box.scrollHeight;
  }, [data]);

  return (
    <ThreadProvider api={api} mentionables={conversation?.mentionables ?? []} canWrite={canWrite} compact={compact}>
      <div className={`tt ch-thread${compact ? ' tt-compact' : ''}`}>
        {hasMore && (
          <div className="ch-more">
            <Button size="sm" variant="link" onClick={() => refetch({ id: conversationId, limit: Math.min(200, shown + 50) })}>
              Messages plus anciens
            </Button>
          </div>
        )}
        {data && messages.length === 0 && (
          <div className="tt-empty">
            Pas encore de message dans ce canal.{' '}
            {canWrite && 'Écrivez le premier : mentionnez une personne (@Nom) pour la prévenir, un agent du projet pour qu’il réponde.'}
          </div>
        )}
        {roots.map((root) => (
          <RootMessage key={root.id} root={root} replies={byParent.get(root.id) ?? []} />
        ))}
        <div ref={bottom} />
        {canWrite && conversation && !conversation.archivedAt && <Composer placeholder={placeholder ?? `Écrire dans #${conversation.slug}… (@ pour mentionner une personne, un agent ou une session)`} compact={compact} />}
        {conversation?.archivedAt && <div className="tt-empty">Canal archivé : lecture seule.</div>}
      </div>
    </ThreadProvider>
  );
}
