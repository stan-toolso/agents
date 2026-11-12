import { useMutation } from '@apollo/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CONVERSATION_MESSAGES, DELETE_MESSAGE, MARK_CONVERSATION_READ, POST_MESSAGE, TOGGLE_MESSAGE_REACTION, UPDATE_MESSAGE, type ChannelMessage, type Conversation } from '../graphql/conversations';
import type { TaskMentionable } from '../graphql/operations';
import { messageAttachmentUrl } from '../lib/attachments';
import { layoutThread } from '../lib/threadGroups';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';
import TaskAttachments from './TaskAttachments';
import { Composer, DaySeparator, NewMessagesSeparator, RootMessage, ThreadProvider, groupThread, useThreadAnchor, type ThreadApi, type ThreadMessage } from './Thread';

/** Requêtes à rafraîchir après une écriture : le canal lui-même, la liste des canaux (non-lus) et l'onglet. */
const REFETCH = ['ConversationMessages', 'ProjectConversations', 'ProjectUnreadMessages', 'UnreadMessagesByProject', 'ProjectDashboard'];
/** Sondage du canal affiché : assez serré pour voir arriver une réponse d'agent sans abonnement. */
const POLL_MS = 3000;
/** En dessous de cette distance du bas (px), le fil est considéré « au bas » : il suit les nouveaux messages. */
const NEAR_BOTTOM_PX = 48;

interface Data {
  conversation: (Conversation & { messageCount: number; mentionables: TaskMentionable[]; messages: ChannelMessage[] }) | null;
}

/**
 * Un canal de conversation : ses derniers messages racines avec leurs réponses en fil (moteur commun
 * components/Thread.tsx), séparés par jour, groupés par auteur, avec le repère « Nouveaux messages » à la dernière
 * lecture ; les agents qui répondent ; la zone de saisie en bas. Le fil suit les nouveaux messages quand on est en
 * bas, sinon une pastille « nouveaux messages » propose d'y descendre. Marque le canal lu à l'affichage et à chaque
 * nouveau message vu. `limit` : nombre de messages racines (le tableau de bord en montre moins). `guest` : la
 * personne n'est qu'invitée sur le projet (pas de lien vers les sessions).
 */
export default function ChannelThread({ conversationId, canWrite, guest = false, compact = false, limit = 50, placeholder }: { conversationId: string; canWrite: boolean; guest?: boolean; compact?: boolean; limit?: number; placeholder?: string }) {
  const { data, refetch } = usePollingQuery<Data>(CONVERSATION_MESSAGES, { variables: { id: conversationId, limit }, pollInterval: POLL_MS, fetchPolicy: 'cache-and-network' });
  const { user } = useAuth();
  const { showError } = useDialogs();
  const [toggleReaction] = useMutation(TOGGLE_MESSAGE_REACTION, { refetchQueries: ['ConversationMessages'], onError: (e) => void showError(e) });
  const [post] = useMutation(POST_MESSAGE, { refetchQueries: REFETCH });
  const [update] = useMutation(UPDATE_MESSAGE, { refetchQueries: ['ConversationMessages'] });
  const [remove] = useMutation(DELETE_MESSAGE, { refetchQueries: REFETCH });
  const [markRead] = useMutation(MARK_CONVERSATION_READ, { refetchQueries: ['ProjectConversations', 'ProjectUnreadMessages', 'UnreadMessagesByProject', 'ProjectDashboard'] });
  const toggle = useCallback((messageId: string | null, emoji: string) => messageId && void toggleReaction({ variables: { messageId, emoji } }), [toggleReaction]);
  // Après l'envoi d'un message, le fil descend sur lui.
  const wantBottom = useRef(false);
  const api = useMemo<ThreadApi>(
    () => ({
      anchor: 'm',
      files: true,
      send: async ({ body, parentId, attachments }) => {
        const res = await post({ variables: { conversationId, body, parentId, attachments } });
        if (!parentId) wantBottom.current = true;
        return res;
      },
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

  // La dernière lecture d'avant l'ouverture du canal, figée : le repère « Nouveaux messages » reste en place tant que
  // le canal est affiché, même après qu'on l'a marqué lu.
  const openedAt = useRef<{ lastReadAt: string | null } | null>(null);
  if (conversation && !openedAt.current) openedAt.current = { lastReadAt: conversation.lastReadAt };
  const items = useMemo(() => layoutThread(roots, (r) => byParent.get(r.id)?.length ?? 0, { lastReadAt: openedAt.current?.lastReadAt ?? null, viewerId: user?.id ?? null }), [roots, byParent, user?.id]);

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

  // Le fil se lit de haut en bas, le plus récent en bas, comme un chat. Seul le conteneur du canal défile (pas la
  // page) : au premier affichage il est mis en bas ; ensuite il suit les nouveaux messages tant qu'on y est, sinon
  // une pastille propose d'y descendre. Au bas, c'est aussi ce qui garde la saisie visible.
  const bottom = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [pending, setPending] = useState(0);
  const lastCount = useRef(0);
  const boxOf = () => bottom.current?.closest<HTMLElement>('.ch-scroll') ?? null;
  const scrollToBottom = useCallback((smooth = false) => {
    const box = boxOf();
    if (!box) return;
    if (smooth && 'scrollTo' in box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    else box.scrollTop = box.scrollHeight;
    setPending(0);
  }, []);
  useEffect(() => {
    const box = boxOf();
    if (!box) return;
    const onScroll = () => {
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
      setAtBottom(near);
      if (near) setPending(0);
    };
    onScroll();
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, [data]);
  useEffect(() => {
    if (!data) return;
    if (!scrolled.current) {
      scrolled.current = true;
      lastCount.current = messages.length;
      if (!window.location.hash.startsWith('#m-')) scrollToBottom();
      return;
    }
    const added = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (added <= 0) return;
    if (wantBottom.current || atBottom) {
      wantBottom.current = false;
      scrollToBottom();
    } else {
      // Compte les messages des autres arrivés hors de vue.
      const mine = messages.slice(-added).filter((m) => m.author?.id === user?.id).length;
      setPending((n) => n + added - mine);
    }
  }, [data, messages, atBottom, scrollToBottom, user?.id]);

  return (
    <ThreadProvider api={api} mentionables={conversation?.mentionables ?? []} canWrite={canWrite} compact={compact} linkSessions={!guest}>
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
        {items.map((item) =>
          item.kind === 'day' ? <DaySeparator key={item.key} label={item.label} /> : item.kind === 'new' ? <NewMessagesSeparator key={item.key} /> : <RootMessage key={item.key} root={item.message} replies={byParent.get(item.message.id) ?? []} continued={item.continued} />,
        )}
        <div ref={bottom} />
        {pending > 0 && !atBottom && (
          <button type="button" className="ch-new-pill" onClick={() => scrollToBottom(true)}>
            <i className="bi bi-arrow-down" /> {pending} nouveau{pending > 1 ? 'x' : ''} message{pending > 1 ? 's' : ''}
          </button>
        )}
        {canWrite && conversation && !conversation.archivedAt && <Composer placeholder={placeholder ?? `Écrire dans #${conversation.slug}… (@ pour mentionner une personne, un agent ou une session)`} compact={compact} />}
        {conversation?.archivedAt && <div className="tt-empty">Canal archivé : lecture seule.</div>}
      </div>
    </ThreadProvider>
  );
}
