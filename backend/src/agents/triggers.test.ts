import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationChange } from '../conversations/types.js';
import type { Task, TaskChange, TaskComment } from '../tasks/types.js';
import type { Agent } from './types.js';

// Les déclencheurs ne touchent ni la base ni les services voisins : tout est simulé, on vérifie qui est convoqué et pourquoi.
const { repo, service, sessions, prs, tasks, users, conversations } = vi.hoisted(() => ({
  conversations: {} as Record<string, unknown>,
  repo: {} as Record<string, unknown>,
  service: {} as Record<string, unknown>,
  sessions: {} as Record<string, unknown>,
  prs: {} as Record<string, unknown>,
  tasks: {} as Record<string, unknown>,
  users: {} as Record<string, unknown>,
}));
vi.mock('./repository.js', () => ({ agentRepository: repo }));
vi.mock('./service.js', () => ({ agentService: service }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: sessions }));
vi.mock('../pullRequests/service.js', () => ({ trackedPullRequestService: prs }));
vi.mock('../tasks/service.js', () => ({ taskService: tasks }));
vi.mock('../users/repository.js', () => ({ userRepository: users }));
vi.mock('../conversations/service.js', () => ({ conversationService: conversations, channelRef: () => '#general', threadTitle: () => 'Quoi de neuf ?' }));
vi.mock('../deliveries/service.js', () => ({ deliveryService: { onDeployed: () => undefined } }));
vi.mock('../log.js', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));

const { agentFeedTargets, onConversationChanged, onDeployed, onTaskCreated, onTaskChanged, onPullRequestMerged } = await import('./triggers.js');

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    name: 'Léa',
    projectId: 'p1',
    kind: 'product_manager',
    enabled: true,
    archivedAt: null,
    triggers: { taskCreated: true, taskCreatedTag: null, threadFollowed: true, prMerged: true, deployed: true, taskReady: false, taskReadyTag: null },
    ...over,
  }) as unknown as Agent;

const task = (over: Partial<Task> = {}): Task => ({ id: 't1', projectId: 'p1', title: 'Export CSV', tags: [], sessionIds: [], statusTag: null, ...over }) as unknown as Task;

const comment = (over: Partial<TaskComment> = {}): TaskComment => ({ id: 'c1', taskId: 't1', parentId: null, authorType: 'human', authorUserId: 'u1', authorSessionId: null, authorName: 'Alice', body: 'Bonjour', mentions: [], ...over }) as TaskComment;

beforeEach(() => {
  service.summon = vi.fn(async () => ({ id: 'new' }));
  service.sessionOnTask = vi.fn(async () => null);
  repo.listActive = vi.fn(async () => [agent()]);
  repo.findByIds = vi.fn(async (ids: string[]) => (ids.includes('a1') ? [agent()] : []));
  repo.sessionIdsOnTask = vi.fn(async () => []);
  sessions.findByIds = vi.fn(async () => []);
  tasks.get = vi.fn(async () => task());
  tasks.sessionIds = vi.fn(async () => []);
  users.findById = vi.fn(async () => ({ name: 'Alice' }));
  service.sessionOnThread = vi.fn(async () => null);
  conversations.sessionIdsOnThread = vi.fn(async () => []);
});

describe('onTaskCreated', () => {
  it('convoque les agents dont l’interrupteur accepte la tâche créée par une personne', async () => {
    await onTaskCreated(task(), { type: 'human', userId: 'u1' } as never);
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ taskId: 't1', requestedById: 'u1', text: expect.stringContaining('Alice vient de créer la tâche t1') }));
  });

  it('ignore les tâches créées par un agent (anti-boucle) et les interrupteurs éteints ou filtrés par étiquette', async () => {
    await onTaskCreated(task(), { type: 'agent', sessionId: 's9' });
    expect(service.summon).not.toHaveBeenCalled();
    repo.listActive = vi.fn(async () => [agent({ triggers: { ...agent().triggers, taskCreated: false } }), agent({ id: 'a2', triggers: { ...agent().triggers, taskCreatedTag: 'produit' } })]);
    await onTaskCreated(task({ tags: ['infra'] }), { type: 'human' });
    expect(service.summon).not.toHaveBeenCalled();
    await onTaskCreated(task({ tags: ['Produit'] }), { type: 'human' });
    expect(service.summon).toHaveBeenCalledTimes(1);
    expect(service.summon).toHaveBeenCalledWith('a2', expect.anything());
  });
});

describe('agentFeedTargets', () => {
  it('adresse le message d’une personne aux sessions reliées des agents qui suivent le fil ou qui sont mentionnés', async () => {
    sessions.findByIds = vi.fn(async () => [
      { id: 's1', ownerId: 'a1' },
      { id: 's2', ownerId: 'a2' },
      { id: 's3', ownerId: 'u1' },
    ]);
    repo.findByIds = vi.fn(async () => [agent(), agent({ id: 'a2', triggers: { ...agent().triggers, threadFollowed: false } })]);
    const change: TaskChange = { kind: 'commented', task: task(), comment: comment(), attachments: [], parent: null };
    expect([...(await agentFeedTargets(change, ['s1', 's2', 's3']))]).toEqual(['s1']);
    const mentioning: TaskChange = { kind: 'commented', task: task(), comment: comment({ mentions: [{ kind: 'user', id: 'a2', label: 'Max', text: '@Max' }] }), attachments: [], parent: null };
    expect([...(await agentFeedTargets(mentioning, ['s1', 's2', 's3']))].sort()).toEqual(['s1', 's2']);
  });

  it('rien pour un message d’agent ni pour une modification', async () => {
    sessions.findByIds = vi.fn(async () => [{ id: 's1', ownerId: 'a1' }]);
    const byAgent: TaskChange = { kind: 'commented', task: task(), comment: comment({ authorType: 'agent', authorSessionId: 's9' }), attachments: [], parent: null };
    expect((await agentFeedTargets(byAgent, ['s1'])).size).toBe(0);
    const updated: TaskChange = { kind: 'updated', before: task(), task: task({ statusTag: 'prête' }), actor: { type: 'human' }, addedAttachments: [] };
    expect((await agentFeedTargets(updated, ['s1'])).size).toBe(0);
  });
});

describe('onTaskChanged', () => {
  it('un agent mentionné sans session reliée à la tâche est convoqué avec le message', async () => {
    const change: TaskChange = { kind: 'commented', task: task(), comment: comment({ body: 'Peux-tu cadrer ?', mentions: [{ kind: 'user', id: 'a1', label: 'Léa', text: '@Léa' }] }), attachments: [], parent: null };
    await onTaskChanged(change);
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ taskId: 't1', requestedById: 'u1', text: expect.stringContaining('Alice te mentionne') }));
  });

  it('un agent mentionné qui a déjà une session reliée n’est pas convoqué (le fil la relance)', async () => {
    service.sessionOnTask = vi.fn(async () => ({ id: 's1' }));
    const change: TaskChange = { kind: 'commented', task: task(), comment: comment({ mentions: [{ kind: 'user', id: 'a1', label: 'Léa', text: '@Léa' }] }), attachments: [], parent: null };
    await onTaskChanged(change);
    expect(service.summon).not.toHaveBeenCalled();
  });

  it('un agent qui suit le fil et dont la session sur la tâche est archivée est convoqué à nouveau', async () => {
    tasks.sessionIds = vi.fn(async () => ['s1', 's2']);
    sessions.findByIds = vi.fn(async () => [
      { id: 's1', ownerId: 'a1' },
      { id: 's2', ownerId: 'a2' },
    ]);
    repo.findByIds = vi.fn(async () => [agent(), agent({ id: 'a2', name: 'Max', triggers: { ...agent().triggers, threadFollowed: false } })]);
    const change: TaskChange = { kind: 'commented', task: task(), comment: comment({ body: 'Où en est-on ?' }), attachments: [], parent: null };
    await onTaskChanged(change);
    expect(service.summon).toHaveBeenCalledTimes(1);
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ taskId: 't1', text: expect.stringContaining('[Fil suivi]') }));
    (service.summon as ReturnType<typeof vi.fn>).mockClear();
    service.sessionOnTask = vi.fn(async () => ({ id: 's1' }));
    await onTaskChanged(change);
    expect(service.summon).not.toHaveBeenCalled();
  });

  it('une tâche passée « prête » par une personne convoque l’agent qui l’attend, pas s’il est déjà en charge', async () => {
    repo.listActive = vi.fn(async () => [agent({ id: 'a2', name: 'Max', triggers: { ...agent().triggers, taskReady: true, taskReadyTag: 'Prête' } })]);
    const change: TaskChange = { kind: 'updated', before: task(), task: task({ statusTag: 'prête' }), actor: { type: 'human', userId: 'u1' } as never, addedAttachments: [] };
    await onTaskChanged(change);
    expect(service.summon).toHaveBeenCalledWith('a2', expect.objectContaining({ taskId: 't1', text: expect.stringContaining('« prête »') }));
    (service.summon as ReturnType<typeof vi.fn>).mockClear();
    repo.sessionIdsOnTask = vi.fn(async () => ['s5']);
    await onTaskChanged({ ...change, task: task({ statusTag: 'prête', sessionIds: ['s5'] }) });
    expect(service.summon).not.toHaveBeenCalled();
    await onTaskChanged({ ...change, actor: { type: 'agent', sessionId: 's9' } });
    expect(service.summon).not.toHaveBeenCalled();
  });
});

describe('onConversationChanged', () => {
  const posted = (over: Record<string, unknown> = {}): ConversationChange =>
    ({
      kind: 'posted',
      conversation: { id: 'cv1', projectId: 'p1', slug: 'general' },
      root: { id: 'm0' },
      parent: null,
      attachments: [],
      message: { id: 'm2', parentId: 'm0', authorType: 'human', authorUserId: 'u1', authorSessionId: null, authorName: 'Alice', body: 'Oui, prépare la release', mentions: [], ...over },
    }) as unknown as ConversationChange;

  it('un agent mentionné sans session reliée au fil est convoqué sur le fil', async () => {
    await onConversationChanged(posted({ mentions: [{ kind: 'user', id: 'a1', label: 'Léa', text: '@Léa' }] }));
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ thread: { conversationId: 'cv1', rootMessageId: 'm0' }, text: expect.stringContaining('[Mention]') }));
  });

  it('une réponse sans mention rappelle l’agent qui suit le fil quand sa session sur le fil est archivée', async () => {
    conversations.sessionIdsOnThread = vi.fn(async () => ['s1', 's2']);
    sessions.findByIds = vi.fn(async () => [
      { id: 's1', ownerId: 'a1' },
      { id: 's2', ownerId: 'a2' },
    ]);
    repo.findByIds = vi.fn(async () => [agent(), agent({ id: 'a2', name: 'Max', triggers: { ...agent().triggers, threadFollowed: false } })]);
    await onConversationChanged(posted());
    expect(service.summon).toHaveBeenCalledTimes(1);
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ thread: { conversationId: 'cv1', rootMessageId: 'm0' }, requestedById: 'u1', text: expect.stringContaining('[Fil suivi]') }));
    (service.summon as ReturnType<typeof vi.fn>).mockClear();
    service.sessionOnThread = vi.fn(async () => ({ id: 's1' }));
    await onConversationChanged(posted());
    expect(service.summon).not.toHaveBeenCalled();
    await onConversationChanged(posted({ authorType: 'agent', authorSessionId: 's9' }));
    expect(service.summon).not.toHaveBeenCalled();
  });
});

describe('onPullRequestMerged', () => {
  it('prévient les agents qui suivent les fusions, avec la tâche de la PR', async () => {
    await onPullRequestMerged({ id: 'pr1', taskId: 't1', number: 12, title: 'Export CSV', url: 'https://github.com/x/y/pull/12' } as never);
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ taskId: 't1', text: expect.stringContaining('#12') }));
    (service.summon as ReturnType<typeof vi.fn>).mockClear();
    await onPullRequestMerged({ id: 'pr2', taskId: null } as never);
    expect(service.summon).not.toHaveBeenCalled();
  });
});

describe('onDeployed', () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({
      delivery: { id: 'd1', projectId: 'p1', sha: 'abcdef1234567', branch: 'main', requestedById: 'u1', sessionId: null },
      pullRequests: [{ id: 'pr1', number: 237, title: 'Design', taskId: 't1' }],
      tasks: [task({ statusTag: 'à livrer', status: 'done' } as Partial<Task>)],
      ...over,
    }) as never;

  it('convoque une fois, sans tâche, les agents qui suivent les déploiements, avec les PR et tâches mises en production', async () => {
    await onDeployed(event());
    expect(service.summon).toHaveBeenCalledTimes(1);
    const [id, opts] = (service.summon as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe('a1');
    expect(opts.taskId).toBeUndefined();
    expect(opts.requestedById).toBe('u1');
    expect(opts.text).toContain('[Déploiement] Le commit abcdef1 (main)');
    expect(opts.text).toContain('#237 « Design » → la tâche t1 (« Export CSV »), done · « à livrer »');
  });

  it("ne convoque ni sans tâche emportée, ni l'agent éteint, ni celui dont la session a déclaré le déploiement", async () => {
    await onDeployed(event({ tasks: [], pullRequests: [] }));
    repo.listActive = vi.fn(async () => [agent({ triggers: { ...agent().triggers, deployed: false } })]);
    await onDeployed(event());
    expect(service.summon).not.toHaveBeenCalled();
    repo.listActive = vi.fn(async () => [agent()]);
    sessions.findByIds = vi.fn(async () => [{ id: 's1', ownerId: 'a1' }]);
    await onDeployed(event({ delivery: { id: 'd1', projectId: 'p1', sha: 'abc1234', branch: 'main', requestedById: null, sessionId: 's1' } }));
    expect(service.summon).not.toHaveBeenCalled();
  });
});
