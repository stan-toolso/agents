import { agentConversationFeedTargets } from '../agents/triggers.js';
import { log } from '../log.js';
import { deliverFeed } from '../tasks/sessionFeed.js';
import { channelRef, conversationService, describeMessage, threadTitle } from './service.js';
import type { ConversationChange } from './types.js';

/** Message à transmettre à une session reliée à un fil pour ce que quelqu'un d'autre y a fait. */
export interface ConversationFeed {
  sessionId: string;
  text: string;
  /** Le message relance une session terminée (il lui est adressé) ; sinon il n'est transmis qu'à une session en cours. */
  restart: boolean;
  /** Note discrète (sans tour de l'agent), voir tasks/sessionFeed.ts. */
  quiet: boolean;
}

const QUIET_HINT = "Pour information : poursuis sans en parler, sauf si cela change ton travail (l'outil `conversations.read` montre le fil complet).";

/**
 * Sessions reliées au fil (convoquées, mentionnées, autrices) auxquelles transmettre un message posté par
 * quelqu'un d'autre. Un message est adressé à une session s'il la mentionne (`@session:`) ou si son agent le suit
 * (`alsoAddressed`, agents/triggers.ts) : il arrive comme instruction et relance la session. Les autres sessions
 * reliées ne le reçoivent que si elles tournent, en note discrète. Une réaction n'est signalée qu'à l'autrice du
 * message visé.
 */
export function feedsFor(change: ConversationChange, linked: string[] = [], alsoAddressed: Set<string> = new Set()): ConversationFeed[] {
  const ref = channelRef(change.conversation);
  if (change.kind === 'posted') {
    const m = change.message;
    const mentioned = new Set(m.mentions.filter((x) => x.kind === 'session').map((x) => x.id));
    const recipients = new Set<string>([...linked, ...mentioned, ...alsoAddressed]);
    return [...recipients]
      .filter((sessionId) => sessionId !== m.authorSessionId)
      .map((sessionId) => {
        const addressed = mentioned.has(sessionId) || alsoAddressed.has(sessionId);
        return {
          sessionId,
          restart: addressed,
          quiet: !addressed,
          text: [
            `[Message dans un canal] Nouveau message dans le fil « ${threadTitle(change.root)} » du canal ${ref} (fil ${change.root.id}) que cette session suit${mentioned.has(sessionId) ? ', et qui mentionne cette session' : ''} :`,
            ...describeMessage(m, { replyTo: change.parent }),
            '',
            addressed
              ? `Réponds-y avec l'outil \`conversations.post\` (channel « ${change.conversation.slug} », reply_to ${change.root.id} pour rester dans son fil) quand il appelle une réponse ; \`conversations.react\` pour un simple accusé.`
              : QUIET_HINT,
          ].join('\n'),
        };
      });
  }
  const target = change.message;
  if (!target.authorSessionId || target.authorSessionId === change.reaction.sessionId) return [];
  const r = change.reaction;
  return [
    {
      sessionId: target.authorSessionId,
      restart: false,
      quiet: true,
      text: `[Réaction dans un canal] ${r.actorName}${r.actorType === 'agent' ? ' (agent)' : ''} ${change.added ? 'a réagi' : 'a retiré sa réaction'} ${r.emoji} ${change.added ? 'à' : 'de'} ton message ${target.id} dans ${ref}${change.added ? ` : « ${target.body.slice(0, 120)}${target.body.length > 120 ? '…' : ''} »` : ''}. Rien à faire, sauf si cela appelle une suite.`,
    },
  ];
}

/** Transmet le changement à toutes les sessions reliées au fil qui peuvent le recevoir. */
export async function deliverConversationChange(change: ConversationChange): Promise<void> {
  const rootId = change.kind === 'posted' ? change.root.id : (change.message.parentId ?? change.message.id);
  const linked = await conversationService.sessionIdsOnThread(rootId).catch(() => [] as string[]);
  const addressed = await agentConversationFeedTargets(change, linked).catch(() => new Set<string>());
  await Promise.all(feedsFor(change, linked, addressed).map((f) => deliverFeed({ ...f, attachments: [] }).catch((err) => log.warn(`[conversations] message non transmis à ${f.sessionId} : ${(err as Error).message}`))));
}

/** Branche l'écouteur sur le service des conversations (au démarrage du serveur). */
export function registerConversationSessionFeed(): void {
  conversationService.onChanged('session-feed', deliverConversationChange);
}
