import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { inScope, targetProject, withProjectParam, type ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import type { TaskActor } from '../tasks/types.js';
import type { McpContent } from '../tasks/attachments.js';
import { messageImageBlocks, pickShownImages } from './attachments.js';
import { channelRef, conversationService, describeMessages } from './service.js';
import type { Conversation } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Tous les outils du serveur `conversations` sont autorisés d'office : lire et écrire dans les canaux du projet. */
export const CONVERSATIONS_FREE_TOOLS = ['list', 'read', 'post', 'react'].map((t) => `mcp__conversations__${t}`);

const line = (c: Conversation, count?: number) => `- ${channelRef(c)} (${c.name})${c.topic ? ` — ${c.topic}` : ''}${c.archivedAt ? ' · archivé' : ''}${count != null ? ` · ${count} message${count > 1 ? 's' : ''}` : ''}${c.lastMessageAt ? ` · dernier message ${c.lastMessageAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' · vide'}`;

/** Paragraphe du prompt système : les canaux du projet et comment y écrire. Vide pour un espace personnel. */
export const conversationsMcpPrompt = (channels: Conversation[], opts: { scoped?: boolean } = {}): string => {
  if (opts.scoped) return "Serveur MCP `conversations` : les canaux de conversation d'équipe de tes projets (`list` avec `project`, `read`, `post`, `react`) ; un message qui mentionne un agent (« @Nom ») le convoque, il répond dans le fil.";
  const list = channels.filter((c) => !c.archivedAt).map((c) => `${channelRef(c)}${c.topic ? ` (${c.topic})` : ''}`).join(', ');
  return [
    `Le projet a des canaux de conversation d'équipe (serveur MCP \`conversations\` : \`list\`, \`read\`, \`post\`, \`react\`)${list ? ` : ${list}` : ''}. Les personnes et les agents du projet y discutent comme sur Slack : un message ouvre un fil (\`reply_to\` pour y répondre), une mention (« @Nom », « @e-mail » ; « @session:<id> » pour une session) prévient la personne ou convoque l'agent, qui répond dans le fil.`,
    "Quand quelqu'un écrit dans un fil que tu suis (parce qu'on t'y a mentionné ou que tu y as écrit), tu reçois un texte commençant par « [Message dans un canal] » : s'il t'est adressé, il arrive comme une instruction — réponds dans le fil avec `conversations.post` (`reply_to` : l'identifiant du fil) quand il appelle une réponse, `conversations.react` pour un simple accusé ; sinon c'est une note discrète. Poste dans un canal pour rendre compte à l'équipe de ce qui la concerne (un point d'étape, une décision à prendre), pas pour le détail de ton travail.",
  ].join(' ');
};

/**
 * Serveur MCP in-process : les canaux de conversation du projet pour une session d'agent. Avec une portée (session
 * d'un espace personnel), `list` et `post` acceptent un paramètre `project`.
 */
export function createConversationsMcpServer(project: Project, sessionId: string, sessionName?: string, scope?: ProjectScope): McpSdkServerConfigWithInstance {
  const actor: TaskActor = { type: 'agent', sessionId, name: sessionName ?? null };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  /** Canal atteignable : dans le projet de la session, ou dans l'un des projets de la portée. */
  const channel = async (ref: string, projectRef: string | undefined, opts: { write?: boolean } = {}) => {
    const p = await targetProject(project, scope, projectRef, opts);
    return conversationService.resolve(p.id, ref);
  };
  const where = scope ? ' (par défaut ton espace personnel ; project : un de tes projets)' : '';

  return createSdkMcpServer({
    name: 'conversations',
    version: '1.0.0',
    instructions: `Canaux de conversation d'équipe ${scope ? 'de tes projets (paramètre project)' : `du projet "${project.name}"`} : list les énumère, read montre les derniers messages d'un canal (ou un fil complet avec thread), post y écrit (reply_to pour répondre dans le fil d'un message ; une mention « @Nom » prévient une personne ou convoque un agent du projet, « @session:<id> » transmet le message à une session), react pose ou retire un emoji sur un message.`,
    tools: [
      tool('list', `Liste les canaux du projet${where}, avec leur sujet et leur dernier message.`, withProjectParam({}, scope), async ({ project: ref }) =>
        run(async () => {
          const p = await targetProject(project, scope, ref);
          const channels = await conversationService.list(p.id, { includeArchived: true });
          const counts = await Promise.all(channels.map((c) => conversationService.countMessages(c.id)));
          return channels.map((c, i) => line(c, counts[i])).join('\n');
        }),
      ),
      tool(
        'read',
        "Les derniers messages d'un canal (racines avec leurs réponses, du plus ancien au plus récent), ou un fil complet (thread : identifiant de son message racine). Chaque message porte son identifiant, pour y répondre ou y réagir ; les images jointes sont montrées (les plus récentes, dans la limite d'une réponse).",
        withProjectParam(
          {
            channel: z.string().describe('Canal : « général », « #general », son nom ou son identifiant'),
            thread: z.string().optional().describe("Identifiant d'un message racine : montre tout son fil"),
            limit: z.number().int().min(1).max(200).optional().describe('Nombre de messages racines (défaut 30)'),
          },
          scope,
        ),
        async ({ channel: ref, thread, limit, project: projectRef }) => {
          try {
            const c = await channel(ref, projectRef);
            const messages = thread ? await conversationService.thread(thread) : await conversationService.messages(c.id, { limit: limit ?? 30 });
            if (thread && messages[0] && messages[0].conversationId !== c.id) throw new Error("Ce fil n'appartient pas à ce canal");
            if (!messages.length) return text(`${channelRef(c)} : aucun message.`);
            const ids = messages.map((m) => m.id);
            const [reactions, attachments] = await Promise.all([conversationService.reactions(ids), conversationService.attachments(ids)]);
            // Les images les plus récentes d'abord dans la limite, montrées ensuite dans l'ordre du fil.
            const shown = pickShownImages([...attachments].reverse()).reverse();
            const body = [`${line(c)}`, '', ...describeMessages(messages, reactions, { attachments, delivery: { kind: 'tool', shown: new Set(shown.map((a) => a.id)) } })].join('\n');
            const content: McpContent[] = [{ type: 'text', text: body }, ...(await messageImageBlocks(shown))];
            return { content };
          } catch (err) {
            return failure(`Erreur : ${(err as Error).message}`);
          }
        },
      ),
      tool(
        'post',
        "Poste un message dans un canal (Markdown). reply_to : identifiant du message auquel répondre, pour rester dans son fil. Mentionne une personne avec « @Nom » ou « @e-mail », un agent du projet avec « @Nom » (il est convoqué et répond dans le fil), une session avec « @session:<id> » (tasks.people liste qui l'on peut mentionner).",
        withProjectParam(
          {
            channel: z.string().describe('Canal : « général », « #general », son nom ou son identifiant'),
            body: z.string(),
            reply_to: z.string().optional().describe("Message auquel répondre (donné par read) ; absent : nouveau message de premier niveau"),
          },
          scope,
        ),
        async ({ channel: ref, body, reply_to, project: projectRef }) =>
          run(async () => {
            const c = await channel(ref, projectRef, { write: true });
            const m = await conversationService.post(c.id, body, actor, { parentId: reply_to });
            return `Message posté dans ${channelRef(c)} (${m.id})${m.parentId ? ` dans le fil ${m.parentId}` : ''}${m.mentions.length ? ` ; mentionne ${m.mentions.map((x) => x.label).join(', ')}` : ''}.`;
          }),
      ),
      tool(
        'react',
        "Pose un emoji sur un message d'un canal ; le retire si tu l'avais déjà posé. Accusé de lecture, accord (👍), fait (✅)…",
        { message_id: z.string(), emoji: z.string().describe('Un seul emoji, ex. 👍 ✅ 👀 🎉') },
        async ({ message_id, emoji }) =>
          run(async () => {
            const m = await conversationService.getMessage(message_id);
            const c = await conversationService.get(m.conversationId);
            if (!(await inScope(project, scope, c.projectId, { write: true }))) throw new Error('Message introuvable dans tes projets');
            const { added, reaction } = await conversationService.toggleReaction(message_id, emoji, actor);
            return `Réaction ${reaction.emoji} ${added ? 'posée' : 'retirée'} sur le message ${message_id}.`;
          }),
      ),
    ],
  });
}
