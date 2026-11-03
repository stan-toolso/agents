import type { Actor } from '../context/types.js';
import { describeMessageAttachments, messageAttachmentsAsInstruction } from '../conversations/attachments.js';
import { channelRef, conversationService, threadTitle } from '../conversations/service.js';
import type { ConversationChange } from '../conversations/types.js';
import { log } from '../log.js';
import { trackedPullRequestService } from '../pullRequests/service.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { fitInInstruction } from '../tasks/attachments.js';
import { fold } from '../tasks/mentions.js';
import { taskService } from '../tasks/service.js';
import type { Task, TaskActor, TaskChange } from '../tasks/types.js';
import { userRepository } from '../users/repository.js';
import { agentRepository } from './repository.js';
import { agentService, type SummonOptions } from './service.js';
import type { Agent } from './types.js';

/**
 * Déclencheurs des agents : ce qui les convoque sans qu'une personne les mentionne. Branchés sur les écouteurs du
 * service des tâches (création, changements) et sur les fusions de pull requests. Chaque convocation est une
 * session de l'agent (voir `agentService.summon`) ; les erreurs sont journalisées, jamais propagées à l'action
 * d'origine. Garde anti-boucle : ce qu'une session d'agent fait ne déclenche pas les agents (une tâche créée par un
 * agent, un message d'un agent) ; seules les actions des personnes (et de l'API) comptent.
 */

const taskLink = (task: Pick<Task, 'id' | 'title'>) => `la tâche ${task.id} (« ${task.title} »)`;

async function actorName(actor: TaskActor | Actor | null | undefined): Promise<string> {
  const a = actor as TaskActor | null | undefined;
  if (a?.name) return a.name;
  if (a?.userId) return (await userRepository.findById(a.userId))?.name ?? 'quelqu’un';
  return 'quelqu’un';
}

const tagMatches = (task: Task, tag: string | null): boolean => !tag || task.tags.some((t) => fold(t) === fold(tag));

/** Convoque sans jamais lever (l'action d'origine ne doit pas en dépendre). */
async function summonQuietly(agent: Agent, opts: Omit<SummonOptions, 'actor'>, why: string): Promise<void> {
  try {
    // Personne ne pilote une session ouverte par un déclencheur : elle se range seule à la fin de son tour.
    const session = await agentService.summon(agent.id, { ...opts, actor: { type: 'human' }, autoArchive: true });
    log.info(`[agents] ${agent.name} convoqué (${why}) : session ${session.id}`);
  } catch (err) {
    log.warn(`[agents] ${agent.name} non convoqué (${why}) : ${(err as Error).message}`);
  }
}

/** Une tâche créée par une personne : les agents dont l'interrupteur « tâche créée » accepte la tâche interviennent. */
export async function onTaskCreated(task: Task, actor: Actor): Promise<void> {
  if (actor.type === 'agent') return;
  const agents = (await agentRepository.listActive([task.projectId])).filter((a) => a.triggers.taskCreated && tagMatches(task, a.triggers.taskCreatedTag));
  if (!agents.length) return;
  const by = await actorName(actor);
  const requestedById = (actor as TaskActor).userId ?? null;
  for (const agent of agents) {
    await summonQuietly(
      agent,
      {
        taskId: task.id,
        requestedById,
        text: `[Tâche créée] ${by} vient de créer ${taskLink(task)}. Interviens selon tes instructions : relis-la (\`tasks.get\`), pose dans son fil les questions nécessaires en mentionnant ${by} (\`tasks.comment\`), complète sa description quand le besoin est clair, et tiens son étiquette d'état.`,
      },
      'tâche créée',
    );
  }
}

/** Sessions de `linked` jouées par un agent, avec l'agent (une requête par lot). */
async function agentSessions(linked: string[]): Promise<{ sessionId: string; agent: Agent }[]> {
  if (!linked.length) return [];
  const sessions = await sessionRepository.findByIds(linked);
  const ownerIds = [...new Set(sessions.map((s) => s.ownerId).filter((id): id is string => Boolean(id)))];
  const agents = ownerIds.length ? await agentRepository.findByIds(ownerIds) : [];
  const byOwner = new Map(agents.map((a) => [a.id, a]));
  return sessions.flatMap((s) => {
    const agent = s.ownerId ? byOwner.get(s.ownerId) : undefined;
    return agent ? [{ sessionId: s.id, agent }] : [];
  });
}

/**
 * Sessions reliées à la tâche auxquelles un changement s'adresse parce qu'un agent les joue : un message d'une
 * personne revient comme instruction à la session d'un agent qui suit les fils où il est intervenu
 * (`threadFollowed`), ou d'un agent que le message mentionne. Utilisé par `tasks/sessionFeed.ts`.
 */
export async function agentFeedTargets(change: TaskChange, linked: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (change.kind !== 'commented' || change.comment.authorType !== 'human') return out;
  const mentioned = new Set(change.comment.mentions.filter((m) => m.kind === 'user').map((m) => m.id));
  for (const { sessionId, agent } of await agentSessions(linked)) {
    if (!agent.enabled || agent.archivedAt) continue;
    if (agent.triggers.threadFollowed || mentioned.has(agent.id)) out.add(sessionId);
  }
  return out;
}

/**
 * Un message d'une personne pour un agent sans session active reliée à la tâche : l'agent mentionné est convoqué, et
 * celui qui suit le fil (`threadFollowed`) aussi quand ses sessions sur la tâche ont été archivées (il les range
 * lui-même une fois son travail rendu : le fil doit pouvoir le rappeler).
 */
async function onCommented(change: Extract<TaskChange, { kind: 'commented' }>): Promise<void> {
  const c = change.comment;
  if (c.authorType !== 'human') return;
  const mentionedIds = new Set(c.mentions.filter((m) => m.kind === 'user').map((m) => m.id));
  const followers = (await agentSessions(await taskService.sessionIds(change.task.id).catch(() => [] as string[]))).map((x) => x.agent).filter((a) => a.triggers.threadFollowed);
  const mentioned = mentionedIds.size ? await agentRepository.findByIds([...mentionedIds]) : [];
  const agents = [...new Map([...mentioned, ...followers].map((a) => [a.id, a])).values()].filter((a) => a.enabled && !a.archivedAt && a.projectId === change.task.projectId);
  const excerpt = c.body.length > 2000 ? `${c.body.slice(0, 2000)}…` : c.body;
  for (const agent of agents) {
    if (await agentService.sessionOnTask(agent, change.task.id)) continue; // sa session reliée reçoit le message par le fil
    const text = mentionedIds.has(agent.id)
      ? `[Mention] ${c.authorName} te mentionne dans le fil de ${taskLink(change.task)} :\n\n${excerpt}\n\nRéponds dans le fil (\`tasks.comment\`, \`reply_to\` ${c.id} pour rester dans son fil) et agis selon tes instructions.`
      : `[Fil suivi] ${c.authorName} a écrit dans le fil de ${taskLink(change.task)}, que tu suis (ta session précédente sur cette tâche est archivée) :\n\n${excerpt}\n\nRelis la tâche et son fil (\`tasks.get\`). Si le message t'est adressé ou relève de ton rôle, réponds dans le fil (\`tasks.comment\`, \`reply_to\` ${c.id}) et agis selon tes instructions ; sinon ne réponds pas et archive cette session (\`sessions.archive\`).`;
    await summonQuietly(agent, { taskId: change.task.id, requestedById: c.authorUserId, text }, mentionedIds.has(agent.id) ? 'mention' : 'fil suivi');
  }
}

/** Une tâche passée par une personne à l'étiquette d'état attendue par un agent (« prête ») : il démarre dessus. */
async function onUpdated(change: Extract<TaskChange, { kind: 'updated' }>): Promise<void> {
  if (change.actor?.type === 'agent') return;
  const tag = change.task.statusTag?.trim();
  if (!tag || fold(change.before.statusTag ?? '') === fold(tag)) return;
  const agents = (await agentRepository.listActive([change.task.projectId])).filter((a) => a.triggers.taskReady && a.triggers.taskReadyTag && fold(a.triggers.taskReadyTag) === fold(tag));
  if (!agents.length) return;
  const by = await actorName(change.actor);
  for (const agent of agents) {
    if ((await agentRepository.sessionIdsOnTask(agent.id, change.task.id)).some((id) => change.task.sessionIds.includes(id))) continue;
    await summonQuietly(
      agent,
      { taskId: change.task.id, requestedById: change.actor?.userId ?? null, text: `[Tâche prête] ${by} a passé ${taskLink(change.task)} à l'état « ${tag} » : démarre dessus selon tes instructions.` },
      'tâche prête',
    );
  }
}

export async function onTaskChanged(change: TaskChange): Promise<void> {
  if (change.kind === 'commented') await onCommented(change);
  else if (change.kind === 'updated') await onUpdated(change);
}

/**
 * Sessions reliées à un fil de canal auxquelles un message s'adresse parce qu'un agent les joue : un message d'une
 * personne revient comme instruction à la session d'un agent qui suit les fils où il est intervenu (`threadFollowed`),
 * ou d'un agent que le message mentionne. Utilisé par `conversations/feed.ts`.
 */
export async function agentConversationFeedTargets(change: ConversationChange, linked: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (change.kind !== 'posted' || change.message.authorType !== 'human') return out;
  const mentioned = new Set(change.message.mentions.filter((m) => m.kind === 'user').map((m) => m.id));
  for (const { sessionId, agent } of await agentSessions(linked)) {
    if (!agent.enabled || agent.archivedAt) continue;
    if (agent.triggers.threadFollowed || mentioned.has(agent.id)) out.add(sessionId);
  }
  return out;
}

/**
 * Un message d'une personne dans un canal pour un agent sans session active reliée au fil : l'agent mentionné est
 * convoqué sur le fil, et celui qui suit le fil (`threadFollowed`) aussi quand ses sessions sur le fil ont été
 * archivées (par lui-même sitôt sa réponse postée, ou par une personne qui range ses sessions) : une réponse dans le
 * fil sans « @Nom » doit pouvoir le rappeler. `agentService.summon` restaure alors sa dernière session sur le fil.
 */
async function onMessagePosted(change: Extract<ConversationChange, { kind: 'posted' }>): Promise<void> {
  const m = change.message;
  if (m.authorType !== 'human') return;
  const mentionedIds = new Set(m.mentions.filter((x) => x.kind === 'user').map((x) => x.id));
  const followers = (await agentSessions(await conversationService.sessionIdsOnThread(change.root.id).catch(() => [] as string[]))).map((x) => x.agent).filter((a) => a.triggers.threadFollowed);
  const mentioned = mentionedIds.size ? await agentRepository.findByIds([...mentionedIds]) : [];
  const agents = [...new Map([...mentioned, ...followers].map((a) => [a.id, a])).values()].filter((a) => a.enabled && !a.archivedAt && a.projectId === change.conversation.projectId);
  const files = change.attachments.length ? await messageAttachmentsAsInstruction(change.attachments).catch(() => []) : [];
  const joined = new Set(fitInInstruction(change.attachments).kept.map((a) => a.id));
  const fileLines = describeMessageAttachments(change.attachments, { kind: 'instruction', ids: joined });
  const excerpt = [m.body.length > 2000 ? `${m.body.slice(0, 2000)}…` : m.body || '(pas de texte)', ...fileLines].join('\n');
  const where = `le canal ${channelRef(change.conversation)}, fil « ${threadTitle(change.root)} »`;
  const reply = `\`conversations.post\`, channel « ${change.conversation.slug} », reply_to ${change.root.id}`;
  for (const agent of agents) {
    if (await agentService.sessionOnThread(agent, change.root.id)) continue; // sa session reliée reçoit le message par le fil
    const isMention = mentionedIds.has(agent.id);
    const text = isMention
      ? `[Mention] ${m.authorName} te mentionne dans ${where} :\n\n${excerpt}\n\nRéponds dans le fil (${reply}) et agis selon tes instructions.`
      : `[Fil suivi] ${m.authorName} a écrit dans ${where}, que tu suis (ta session sur ce fil était archivée) :\n\n${excerpt}\n\nRelis le fil s'il le faut (\`conversations.read\`, thread ${change.root.id}). Si le message t'est adressé ou relève de ton rôle, réponds dans le fil (${reply}) et agis selon tes instructions ; sinon ne réponds pas. Puis archive cette session (\`sessions.archive\`) si tu n'as plus rien à y faire : le prochain message du fil la restaurera.`;
    await summonQuietly(agent, { thread: { conversationId: change.conversation.id, rootMessageId: change.root.id }, requestedById: m.authorUserId, text, attachments: files.length ? files : null }, isMention ? 'mention dans un canal' : 'fil suivi dans un canal');
  }
}

export async function onConversationChanged(change: ConversationChange): Promise<void> {
  if (change.kind === 'posted') await onMessagePosted(change);
}

/** La pull request d'une tâche est fusionnée : les agents qui suivent les fusions sont prévenus. */
export async function onPullRequestMerged(pr: TrackedPullRequest): Promise<void> {
  if (!pr.taskId) return;
  const task = await taskService.get(pr.taskId).catch(() => null);
  if (!task) return;
  const agents = (await agentRepository.listActive([task.projectId])).filter((a) => a.triggers.prMerged);
  for (const agent of agents) {
    await summonQuietly(
      agent,
      { taskId: task.id, text: `[PR fusionnée] La pull request #${pr.number} (« ${pr.title} »${pr.url ? `, ${pr.url}` : ''}) de ${taskLink(task)} vient d'être fusionnée. Agis selon tes instructions (étiquette d'état, rapporteur prévenu dans le fil, suite à donner).` },
      'PR fusionnée',
    );
  }
}

/** Branche les déclencheurs (au démarrage du serveur). */
export function registerAgentTriggers(): void {
  taskService.onTaskCreated('agents', onTaskCreated);
  taskService.onTaskChanged('agents', onTaskChanged);
  trackedPullRequestService.onMerged('agents', onPullRequestMerged);
  conversationService.onChanged('agents', onConversationChanged);
}
