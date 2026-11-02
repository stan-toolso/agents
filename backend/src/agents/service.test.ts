import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from './types.js';

// Le service touche la base par le dépôt des agents et les services voisins : tout est simulé.
const { repo, users, userSvc, sessions, sessionRepo, tasks, launch, schedules, projects, context } = vi.hoisted(() => ({
  repo: {} as Record<string, unknown>,
  users: {} as Record<string, unknown>,
  userSvc: {} as Record<string, unknown>,
  sessions: {} as Record<string, unknown>,
  sessionRepo: {} as Record<string, unknown>,
  tasks: {} as Record<string, unknown>,
  launch: {} as Record<string, unknown>,
  schedules: {} as Record<string, unknown>,
  projects: {} as Record<string, unknown>,
  context: {} as Record<string, unknown>,
}));
vi.mock('./repository.js', () => ({ agentRepository: repo }));
vi.mock('../users/repository.js', () => ({ userRepository: users }));
vi.mock('../users/service.js', () => ({ userService: userSvc }));
vi.mock('../sessions/service.js', () => ({ sessionService: sessions }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: sessionRepo }));
vi.mock('../tasks/service.js', () => ({ taskService: tasks }));
vi.mock('../tasks/launch.js', () => launch);
vi.mock('../schedules/service.js', () => ({ scheduleService: schedules }));
vi.mock('../projects/service.js', () => ({ projectService: projects }));
vi.mock('../context/service.js', () => ({ contextService: context }));
vi.mock('../log.js', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));

const { agentService, agentEmail } = await import('./service.js');

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    userId: 'a1',
    name: 'Léa',
    email: agentEmail('a1'),
    projectId: 'p1',
    kind: 'product_manager',
    avatar: { emoji: null, color: null },
    description: '',
    instructions: '',
    taskFolder: false,
    defaults: { permissionMode: 'acceptEdits', provider: 'claude', allowedTools: 'Read' },
    inheritContext: true,
    claudeDelegateId: null,
    githubDelegateId: null,
    githubDelegateReadOnly: true,
    githubDelegatePullRequests: false,
    gitlabDelegateId: null,
    gitlabDelegateReadOnly: true,
    gitlabDelegatePullRequests: false,
    allowedModels: [],
    triggers: { taskCreated: true, taskCreatedTag: null, threadFollowed: true, prMerged: false, taskReady: false, taskReadyTag: null },
    actions: [],
    enabled: true,
    archivedAt: null,
    ...over,
  }) as Agent;

beforeEach(() => {
  repo.findById = vi.fn(async (id: string) => (id === 'a1' ? agent() : null));
  repo.listByProject = vi.fn(async () => [agent(), agent({ id: 'a2', name: 'Max', kind: 'developer', taskFolder: true })]);
  repo.sessionIdsOnTask = vi.fn(async () => []);
  repo.update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...agent(), ...patch }));
  repo.isManager = vi.fn(async () => false);
  repo.setManagers = vi.fn(async () => []);
  repo.create = vi.fn(async (input: Record<string, unknown>) => agent({ ...(input as Partial<Agent>), id: input.userId as string }));
  users.create = vi.fn(async (input: Record<string, unknown>) => ({ id: input.id, name: input.name, email: input.email, kind: 'agent' }));
  users.upsertMembership = vi.fn(async () => ({}));
  users.findById = vi.fn(async (id: string) => ({ id, name: id === 'u1' ? 'Alice' : 'Quelqu’un', kind: 'person' }));
  users.rename = vi.fn(async () => ({}));
  userSvc.roleFor = vi.fn(async () => 'member');
  userSvc.members = vi.fn(async () => [{ userId: 'u1' }]);
  projects.get = vi.fn(async () => ({ id: 'p1', name: 'Skipper', personalOwnerId: null, taskInstructions: '' }));
  context.ensureFolderPath = vi.fn(async () => null);
  sessions.create = vi.fn(async (input: Record<string, unknown>) => ({ id: 'created', ...input }));
  sessions.sendMessage = vi.fn(async (id: string) => ({ id, sent: true }));
  sessions.start = vi.fn(async (id: string) => ({ id }));
  sessionRepo.findById = vi.fn(async () => null);
  tasks.get = vi.fn(async () => ({ id: 't1', projectId: 'p1', title: 'Export CSV', description: 'Exporter', tags: [], customFields: [], sessionIds: [], status: 'todo' }));
  tasks.comments = vi.fn(async () => []);
  tasks.linkSession = vi.fn(async () => undefined);
  launch.startTaskSession = vi.fn(async (_id: string, opts: Record<string, unknown>) => ({ id: 'task-session', ...opts }));
  launch.taskFiles = vi.fn(async () => ({ kept: [], leftOut: [] }));
  launch.composeTaskPrompt = vi.fn(() => 'prompt composé');
  schedules.createWithSession = vi.fn(async () => ({ id: 'sched-1' }));
  schedules.set = vi.fn(async () => ({}));
  schedules.remove = vi.fn(async () => ({}));
  sessions.archive = vi.fn(async () => ({}));
});

describe('resolve', () => {
  it('trouve un agent par identifiant ou par nom, sans casse ni accents', async () => {
    expect((await agentService.resolve('p1', 'a2')).name).toBe('Max');
    expect((await agentService.resolve('p1', 'lea')).id).toBe('a1');
    await expect(agentService.resolve('p1', 'Zoé')).rejects.toThrow('Aucun agent « Zoé »');
  });
});

describe('sessionConfig et providerOf', () => {
  it('applique les réglages par défaut de l’agent sous ceux demandés, sans le provider', () => {
    expect(agentService.sessionConfig(agent(), { model: 'x' })).toEqual({ permissionMode: 'acceptEdits', allowedTools: 'Read', model: 'x' });
    expect(agentService.sessionConfig(agent(), { permissionMode: 'default' }).permissionMode).toBe('default');
    expect(agentService.providerOf(agent())).toBe('claude');
    expect(agentService.providerOf(agent({ defaults: {} }))).toBe('claude');
  });
});

describe('prepareActions', () => {
  it('dérive des clés uniques, garde la session planifiée d’une action de même clé, et valide', () => {
    const actions = agentService.prepareActions(
      [
        { label: 'Préparer une release', instruction: 'Prépare…', cron: '0 9 * * 5' },
        { label: 'Préparer une release', instruction: 'Encore' },
      ],
      [{ key: 'preparer-une-release', label: 'x', instruction: 'y', cron: '0 9 * * 5', timezone: null, scheduleSessionId: 'sched-old' }],
    );
    expect(actions.map((a) => a.key)).toEqual(['preparer-une-release', 'preparer-une-release-2']);
    expect(actions[0].scheduleSessionId).toBe('sched-old');
    expect(actions[1].scheduleSessionId).toBeNull();
    expect(() => agentService.prepareActions([{ label: '', instruction: 'x' }], [])).toThrow('libellé');
    expect(() => agentService.prepareActions([{ label: 'A', instruction: ' ' }], [])).toThrow("n'a pas d'instruction");
  });
});

describe('create', () => {
  it('crée l’utilisateur agent, l’appartenance, le profil d’après le modèle et le propriétaire', async () => {
    repo.findById = vi.fn(async (id: string) => agent({ id, userId: id, name: 'Max' }));
    const created = await agentService.create('p1', { kind: 'developer', name: 'Max' }, { id: 'u1', name: 'Alice' } as never);
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Max', kind: 'agent', email: expect.stringMatching(/^agent-.*@agents\.skipper$/) }));
    expect(users.upsertMembership).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', role: 'member', invitedById: 'u1' }));
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'developer', taskFolder: true, inheritContext: true, createdById: 'u1', triggers: expect.objectContaining({ taskReadyTag: 'prête' }) }));
    expect(repo.setManagers).toHaveBeenCalledWith(created.id, [{ userId: 'u1', role: 'owner' }]);
  });

  it('refuse un nom déjà porté par un membre, un nom vide ou avec @, et un espace personnel', async () => {
    await expect(agentService.create('p1', { name: 'alice' }, { id: 'u1' } as never)).rejects.toThrow('s\'appelle déjà');
    await expect(agentService.create('p1', { name: ' ' }, { id: 'u1' } as never)).rejects.toThrow('Donnez un nom');
    await expect(agentService.create('p1', { name: 'a@b' }, { id: 'u1' } as never)).rejects.toThrow('@');
    projects.get = vi.fn(async () => ({ id: 'p1', personalOwnerId: 'u1' }));
    await expect(agentService.create('p1', { name: 'Zoé' }, { id: 'u1' } as never)).rejects.toThrow('espace personnel');
  });
});

describe('summon', () => {
  it('sans tâche : une nouvelle session de l’agent, dans son propre dossier, avec le demandeur', async () => {
    const s = await agentService.summon('a1', { text: 'Bonjour Léa\nJ’ai un besoin', requestedById: 'u1' });
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', ownerId: 'a1', requestedById: 'u1', newWorksession: {}, name: 'Léa · Bonjour Léa', prompt: 'Bonjour Léa\nJ’ai un besoin', config: { permissionMode: 'acceptEdits', allowedTools: 'Read' } }), { type: 'human' });
    expect(s.id).toBe('created');
  });

  it('avec une tâche : la session reliée de l’agent reçoit le message', async () => {
    repo.sessionIdsOnTask = vi.fn(async () => ['s1']);
    sessionRepo.findById = vi.fn(async () => ({ id: 's1', archivedAt: null, worksessionId: 'w1', status: 'completed' }));
    const s = await agentService.summon('a1', { taskId: 't1', text: 'Du nouveau', requestedById: 'u1' });
    expect(sessions.sendMessage).toHaveBeenCalledWith('s1', 'Du nouveau', null);
    expect(s.id).toBe('s1');
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('avec une tâche et sans session : dans le dossier de la tâche pour un agent qui y travaille, à côté sinon', async () => {
    repo.findById = vi.fn(async (id: string) => (id === 'a2' ? agent({ id: 'a2', name: 'Max', taskFolder: true, defaults: {} }) : agent()));
    await agentService.summon('a2', { taskId: 't1', text: 'Développe', requestedById: 'u1' });
    expect(launch.startTaskSession).toHaveBeenCalledWith('t1', expect.objectContaining({ ownerId: 'a2', requestedById: 'u1', instructions: 'Développe', provider: 'claude' }));
    await agentService.summon('a1', { taskId: 't1', text: 'Cadre', requestedById: 'u1' });
    expect(launch.composeTaskPrompt).toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'a1', prompt: 'prompt composé', newWorksession: { label: 'Léa · Export CSV' }, autoStart: false }), { type: 'human' });
    expect(tasks.linkSession).toHaveBeenCalledWith('t1', 'created');
    expect(sessions.start).toHaveBeenCalledWith('created');
  });

  it('refuse un agent en pause ou retiré, un message vide, une tâche d’un autre projet', async () => {
    repo.findById = vi.fn(async () => agent({ enabled: false }));
    await expect(agentService.summon('a1', { text: 'x' })).rejects.toThrow('en pause');
    repo.findById = vi.fn(async () => agent({ archivedAt: new Date() }));
    await expect(agentService.summon('a1', { text: 'x' })).rejects.toThrow('retiré');
    repo.findById = vi.fn(async () => agent());
    await expect(agentService.summon('a1', { text: '  ' })).rejects.toThrow('vide');
    tasks.get = vi.fn(async () => ({ id: 't2', projectId: 'p2' }));
    await expect(agentService.summon('a1', { taskId: 't2', text: 'x' })).rejects.toThrow("n'appartient pas");
  });
});

describe('syncActionSchedules', () => {
  it('crée une session planifiée par action à cron, la met à jour, et supprime celle d’une action retirée', async () => {
    const a = agent({ actions: [{ key: 'release', label: 'Release', instruction: 'Prépare', cron: '0 9 * * 5', timezone: 'Europe/Paris', scheduleSessionId: null }] });
    await agentService.syncActionSchedules(a, []);
    expect(schedules.createWithSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', name: 'Léa · Release', cron: '0 9 * * 5', prompt: 'Prépare', provider: 'claude' }), 'a1');
    expect(repo.update).toHaveBeenCalledWith('a1', { actions: [expect.objectContaining({ key: 'release', scheduleSessionId: 'sched-1' })] });

    sessionRepo.findById = vi.fn(async () => ({ id: 'sched-1' }));
    const b = agent({ actions: [{ key: 'release', label: 'Release', instruction: 'Prépare v2', cron: '0 9 * * 5', timezone: null, scheduleSessionId: 'sched-1' }] });
    await agentService.syncActionSchedules(b, b.actions);
    expect(schedules.set).toHaveBeenCalledWith('sched-1', expect.objectContaining({ prompt: 'Prépare v2', enabled: true }));

    await agentService.syncActionSchedules(agent({ actions: [] }), b.actions);
    expect(schedules.remove).toHaveBeenCalledWith('sched-1');
    expect(sessions.archive).toHaveBeenCalledWith('sched-1');
  });
});

describe('comptes et délégation', () => {
  it('accounts : les comptes propres de l’agent, ou ceux prêtés (GitHub et GitLab séparément, lecture seule par défaut)', async () => {
    const own = { claudeUserId: 'a1', githubUserId: 'a1', githubReadOnly: false, githubPullRequests: true, gitlabUserId: 'a1', gitlabReadOnly: false, gitlabPullRequests: true, forgeUserId: 'a1' };
    expect(agentService.accounts(agent())).toEqual(own);
    expect(agentService.accounts(agent({ claudeDelegateId: 'u1', githubDelegateId: 'u2', githubDelegateReadOnly: true }))).toEqual({ ...own, claudeUserId: 'u1', githubUserId: 'u2', githubReadOnly: true, githubPullRequests: false });
    // Lecture seule avec pull requests permises : toujours pas de push, mais pr_open passe.
    expect(agentService.accounts(agent({ githubDelegateId: 'u2', githubDelegateReadOnly: true, githubDelegatePullRequests: true }))).toEqual({ ...own, githubUserId: 'u2', githubReadOnly: true, githubPullRequests: true });
    expect(agentService.accounts(agent({ gitlabDelegateId: 'u3', gitlabDelegateReadOnly: false }))).toEqual({ ...own, gitlabUserId: 'u3' });
    // La forge de Skipper sert toujours avec le compte de l’agent lui-même.
    expect(agentService.accounts(agent({ githubDelegateId: 'u2', gitlabDelegateId: 'u3' })).forgeUserId).toBe('a1');
    expect(await agentService.accountsForOwner('u1')).toEqual({ claudeUserId: 'u1', githubUserId: 'u1', githubReadOnly: false, githubPullRequests: true, gitlabUserId: 'u1', gitlabReadOnly: false, gitlabPullRequests: true, forgeUserId: 'u1' });
    expect(await agentService.accountsForOwner(null)).toBeNull();
  });

  it('setDelegation : seule une personne membre du projet prête son compte ; null retire la délégation', async () => {
    await agentService.setDelegation('a1', 'github', 'u1', { readOnly: false });
    expect(repo.update).toHaveBeenLastCalledWith('a1', { githubDelegateId: 'u1', githubDelegateReadOnly: false, githubDelegatePullRequests: false });
    await agentService.setDelegation('a1', 'gitlab', 'u1');
    expect(repo.update).toHaveBeenLastCalledWith('a1', { gitlabDelegateId: 'u1', gitlabDelegateReadOnly: true, gitlabDelegatePullRequests: false });
    await agentService.setDelegation('a1', 'gitlab', 'u1', { pullRequests: true });
    expect(repo.update).toHaveBeenLastCalledWith('a1', { gitlabDelegateId: 'u1', gitlabDelegateReadOnly: true, gitlabDelegatePullRequests: true });
    await agentService.setDelegation('a1', 'claude', 'u1');
    expect(repo.update).toHaveBeenLastCalledWith('a1', { claudeDelegateId: 'u1' });
    await agentService.setDelegation('a1', 'github', null);
    expect(repo.update).toHaveBeenLastCalledWith('a1', { githubDelegateId: null, githubDelegateReadOnly: true, githubDelegatePullRequests: false });
    users.findById = vi.fn(async (id: string) => ({ id, name: 'Léa', kind: 'agent' }));
    await expect(agentService.setDelegation('a1', 'gitlab', 'a2')).rejects.toThrow('Seule une personne');
    users.findById = vi.fn(async (id: string) => ({ id, name: 'Alice', kind: 'person' }));
    userSvc.roleFor = vi.fn(async () => 'viewer');
    await expect(agentService.setDelegation('a1', 'claude', 'u1')).rejects.toThrow('membre du projet');
  });
});

describe('type de session et modèles', () => {
  it('validModels : type de session connu, modèle par défaut parmi les modèles autorisés, liste nettoyée', () => {
    expect(agentService.validModels({ provider: 'opencode', model: ' opus ' }, ['opus', ' sonnet', 'opus', ''])).toEqual({ defaults: { provider: 'opencode', model: 'opus' }, allowedModels: ['opus', 'sonnet'] });
    expect(agentService.validModels({ provider: '', model: '', permissionMode: 'plan' }, [])).toEqual({ defaults: { permissionMode: 'plan' }, allowedModels: [] });
    expect(() => agentService.validModels({ provider: 'shell' }, [])).toThrow('Type de session inconnu');
    expect(() => agentService.validModels({ model: 'haiku' }, ['opus'])).toThrow('modèles autorisés');
  });

  it('sessionConfig : refuse un modèle non autorisé, applique sinon le modèle de l’agent ou le premier autorisé', () => {
    const a = agent({ defaults: { provider: 'claude', model: 'sonnet' }, allowedModels: ['opus', 'sonnet'] });
    expect(agentService.sessionConfig(a, null)).toEqual({ model: 'sonnet' });
    expect(agentService.sessionConfig(a, { model: 'opus' })).toEqual({ model: 'opus' });
    expect(agentService.sessionConfig(a, { model: '' })).toEqual({ model: 'sonnet' });
    expect(() => agentService.sessionConfig(a, { model: 'haiku' })).toThrow('modèles autorisés');
    expect(agentService.constrainModel(agent({ defaults: {}, allowedModels: ['opus'] }), { model: 'haiku' })).toEqual({ model: 'opus' });
    expect(agentService.constrainModel(agent({ defaults: {}, allowedModels: [] }), { model: 'haiku' })).toBeNull();
    expect(agentService.providerOf(agent({ defaults: { provider: 'opencode' } }))).toBe('opencode');
  });
});

describe('setManagers', () => {
  it('exige exactement un propriétaire, des personnes membres du projet, sans doublon', async () => {
    await expect(agentService.setManagers('a1', [{ userId: 'u1', role: 'manager' }])).rejects.toThrow('exactement un propriétaire');
    await expect(agentService.setManagers('a1', [{ userId: 'u1', role: 'owner' }, { userId: 'u1', role: 'manager' }])).rejects.toThrow('qu’une fois');
    userSvc.roleFor = vi.fn(async () => 'viewer');
    await expect(agentService.setManagers('a1', [{ userId: 'u1', role: 'owner' }])).rejects.toThrow('membre du projet');
    userSvc.roleFor = vi.fn(async () => 'admin');
    await agentService.setManagers('a1', [{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'manager' }]);
    expect(repo.setManagers).toHaveBeenCalledWith('a1', [{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'manager' }]);
  });
});

describe('prise en main d’une session d’agent', () => {
  const session = (over: Record<string, unknown> = {}) => ({ id: 's1', projectId: 'p1', ownerId: 'a1', requestedById: 'u1', takenOverById: null, status: 'completed', archivedAt: null, ...over });

  it('le demandeur, un gestionnaire ou un administrateur peut prendre la main ; pas un lecteur, pas une session de personne', async () => {
    expect(await agentService.canTakeOver('u1', session())).toBe(true);
    expect(await agentService.canTakeOver('u2', session())).toBe(false);
    repo.isManager = vi.fn(async () => true);
    expect(await agentService.canTakeOver('u2', session())).toBe(true);
    userSvc.roleFor = vi.fn(async () => 'viewer');
    expect(await agentService.canTakeOver('u1', session())).toBe(false);
    userSvc.roleFor = vi.fn(async () => 'member');
    expect(await agentService.canTakeOver('u1', session({ ownerId: 'u9' }))).toBe(false);
  });

  it('takeOver passe les comptes de la session à la personne, handBack les rend à l’agent', async () => {
    sessionRepo.findById = vi.fn(async () => session());
    sessions.setTakenOver = vi.fn(async (id: string, userId: string | null) => ({ id, takenOverById: userId }));
    await agentService.takeOver('s1', { id: 'u1', name: 'Alice' });
    expect(sessions.setTakenOver).toHaveBeenCalledWith('s1', 'u1', expect.stringContaining('Alice a pris la main'));
    await expect(agentService.takeOver('s1', { id: 'u2', name: 'Bob' })).rejects.toThrow('prendre la main');
    expect(await agentService.accountsForSession({ ownerId: 'a1', takenOverById: 'u1' })).toMatchObject({ githubUserId: 'u1', githubReadOnly: false, claudeUserId: 'u1' });
    expect(await agentService.accountsForSession({ ownerId: 'a1', takenOverById: null })).toMatchObject({ githubUserId: 'a1' });
    sessionRepo.findById = vi.fn(async () => session({ takenOverById: 'u1' }));
    await agentService.handBack('s1', { id: 'u1', name: 'Alice' });
    expect(sessions.setTakenOver).toHaveBeenLastCalledWith('s1', null, expect.stringContaining('rendu la main à Léa'));
  });
});
