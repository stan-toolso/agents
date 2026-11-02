import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskChange } from './types.js';

// Dépendances entre tâches : graphe (cycles), validation par le service, garde « bloquée », enchaînement automatique.
// Dépôt, projets, agents, lancement et notifications simulés, sans base.
const m = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  edges: [] as { taskId: string; dependsOnId: string }[],
  armed: new Set<string>(),
  started: [] as Array<[string, Record<string, unknown>]>,
  notified: [] as Record<string, unknown>[],
  agents: new Map<string, Record<string, unknown>>(),
  startError: null as string | null,
}));
vi.mock('./repository.js', () => ({
  taskRepository: {
    findByIds: async (ids: string[]) => ids.map((id) => m.tasks.get(id)).filter(Boolean),
    dependencyEdges: async () => m.edges,
    consumeAutoStart: async (id: string) => {
      if (!m.armed.has(id)) return { armed: false, byId: null };
      m.armed.delete(id);
      return { armed: true, byId: (m.tasks.get(id)?.autoStartById as string) ?? null };
    },
  },
}));
vi.mock('../projects/service.js', () => ({ projectService: { get: async () => ({ id: 'p', name: 'Projet' }) } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: Record<string, unknown>) => void m.notified.push(n) } }));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async () => null } }));
vi.mock('./launch.js', () => ({
  startTaskSession: async (id: string, opts: Record<string, unknown>) => {
    if (m.startError) throw new Error(m.startError);
    m.started.push([id, opts]);
    return { id: `s-${id}` };
  },
}));
vi.mock('../agents/service.js', () => ({
  agentService: {
    forUser: async (id: string | null) => (id ? (m.agents.get(id) ?? null) : null),
    providerOf: () => 'claude',
    sessionConfig: (a: { defaults: Record<string, unknown> }) => ({ ...a.defaults }),
  },
}));

const { dependencyCycle, normalizeDependencyIds } = await import('./dependencyGraph.js');
const { assertUnblocked, dependencyText, taskService } = await import('./service.js');
const { startUnblockedDependents } = await import('./autoStart.js');

const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const task = (n: number, over: Partial<Task> = {}): Task =>
  ({ id: id(n), projectId: 'p', title: `Tâche ${n}`, status: 'todo', dependsOnIds: [], blockedByIds: [], dependentIds: [], autoStartWhenUnblocked: false, autoStartById: null, ...over }) as Task;
const put = (...ts: Task[]) => ts.forEach((t) => m.tasks.set(t.id, t as unknown as Record<string, unknown>));
const updated = (before: Task, after: Task): TaskChange => ({ kind: 'updated', before, task: after, actor: null, addedAttachments: [] });

beforeEach(() => {
  m.tasks.clear();
  m.edges = [];
  m.armed.clear();
  m.started = [];
  m.notified = [];
  m.agents.clear();
  m.startError = null;
});

describe('dependencyCycle', () => {
  const edges = [
    { taskId: 'b', dependsOnId: 'c' },
    { taskId: 'c', dependsOnId: 'd' },
  ];
  it('null sans cycle, y compris pour une tâche qui dépend de deux branches qui se rejoignent', () => {
    expect(dependencyCycle('a', ['b', 'c'], edges)).toBeNull();
    expect(dependencyCycle('a', [], edges)).toBeNull();
  });
  it('trouve un cycle direct ou indirect, avec son chemin', () => {
    expect(dependencyCycle('d', ['b'], edges)).toEqual(['d', 'b', 'c', 'd']);
    expect(dependencyCycle('c', ['b'], edges)).toEqual(['c', 'b', 'c']);
  });
  it('les dépendances actuelles de la tâche sont remplacées, pas ajoutées', () => {
    expect(dependencyCycle('b', ['x'], [...edges, { taskId: 'd', dependsOnId: 'b' }])).toBeNull();
  });
  it('normalise les identifiants', () => {
    expect(normalizeDependencyIds([' a ', '', 'b', 'a'])).toEqual(['a', 'b']);
  });
});

describe('validation des dépendances', () => {
  it('refuse une tâche elle-même, une tâche inconnue, d’un autre projet, ou un identifiant invalide', async () => {
    put(task(1), task(2, { projectId: 'autre' }));
    await expect(taskService.prepareDependencies('p', id(1), [id(1)])).rejects.toThrow(/elle-même/);
    await expect(taskService.prepareDependencies('p', null, [id(3)])).rejects.toThrow(/introuvable/);
    await expect(taskService.prepareDependencies('p', null, [id(2)])).rejects.toThrow(/autre projet/);
    await expect(taskService.prepareDependencies('p', null, ['pas-un-uuid'])).rejects.toThrow(/invalide/);
  });
  it('refuse un cycle en le nommant', async () => {
    put(task(1), task(2), task(3));
    m.edges = [
      { taskId: id(2), dependsOnId: id(3) },
      { taskId: id(3), dependsOnId: id(1) },
    ];
    await expect(taskService.prepareDependencies('p', id(1), [id(2)])).rejects.toThrow('Dépendance circulaire : « Tâche 1 » → « Tâche 2 » → « Tâche 3 » → « Tâche 1 »');
  });
  it('compte les dépendances qui bloquent (pas terminées ; une annulée bloque encore)', async () => {
    put(task(1, { status: 'done' }), task(2, { status: 'cancelled' }), task(3, { status: 'in_progress' }));
    expect(await taskService.prepareDependencies('p', null, [id(1), id(2), id(3), id(1)])).toEqual({ ids: [id(1), id(2), id(3)], blocking: 2 });
  });
  it('n’arme le lancement automatique que s’il y a quelque chose à attendre, au nom de l’acteur', async () => {
    put(task(1, { status: 'done' }), task(2));
    const human = { type: 'human' as const, userId: 'u1' };
    expect(await taskService.withDependencies('p', null, { title: 'x', dependsOn: [id(2)], autoStartWhenUnblocked: true }, human)).toMatchObject({ autoStartWhenUnblocked: true, autoStartById: 'u1' });
    expect(await taskService.withDependencies('p', null, { title: 'x', dependsOn: [id(1)], autoStartWhenUnblocked: true }, human)).toMatchObject({ autoStartWhenUnblocked: false });
    // Option déjà armée par u1, dépendances modifiées par u2 : réévaluée, toujours au nom de u1.
    const current = task(5, { dependsOnIds: [id(2)], blockedByIds: [id(2)], autoStartWhenUnblocked: true, autoStartById: 'u1' });
    expect(await taskService.withDependencies('p', current, { dependsOn: [id(2)] }, { type: 'human', userId: 'u2' })).toMatchObject({ autoStartWhenUnblocked: true, autoStartById: 'u1' });
    expect(await taskService.withDependencies('p', current, { dependsOn: [id(1)] }, { type: 'human', userId: 'u2' })).toMatchObject({ autoStartWhenUnblocked: false });
    // Un agent sans personne derrière ne peut pas l'armer.
    await expect(taskService.withDependencies('p', null, { title: 'x', dependsOn: [id(2)], autoStartWhenUnblocked: true }, { type: 'agent', sessionId: 's' })).rejects.toThrow(/armé par une personne/);
  });
});

describe('tâche bloquée', () => {
  it('assertUnblocked nomme les dépendances qui bloquent', async () => {
    put(task(1, { status: 'in_progress' }));
    await expect(assertUnblocked(task(2, { dependsOnIds: [id(1)], blockedByIds: [id(1)] }))).rejects.toThrow(/bloquée par « Tâche 1 » \(.*\), en cours/);
    await expect(assertUnblocked(task(2, { dependsOnIds: [id(1)] }))).resolves.toBeUndefined();
  });
  it('dependencyText pour les prompts des agents', () => {
    expect(dependencyText(task(1))).toBe('');
    expect(dependencyText(task(1, { dependsOnIds: ['a', 'b'], blockedByIds: ['b'], autoStartWhenUnblocked: true }))).toBe(' · bloquée par b (lancée automatiquement une fois débloquée)');
    expect(dependencyText(task(1, { dependsOnIds: ['a'] }))).toBe(' · dépendances terminées : a');
  });
});

describe('enchaînement automatique', () => {
  it('lance la tâche dont la dernière dépendance se termine, une seule fois, et le notifie à qui l’a armée', async () => {
    const dep = task(1, { status: 'in_progress', dependentIds: [id(2), id(3), id(4)] });
    put(
      task(2, { autoStartWhenUnblocked: true, autoStartById: 'u1', dependsOnIds: [id(1)] }),
      task(3, { autoStartWhenUnblocked: true, autoStartById: 'u1', dependsOnIds: [id(1), id(9)], blockedByIds: [id(9)] }), // encore bloquée
      task(4, { dependsOnIds: [id(1)] }), // option non armée
    );
    m.armed.add(id(2)).add(id(3));
    await startUnblockedDependents(updated(dep, { ...dep, status: 'done' }));
    expect(m.started).toEqual([[id(2), { ownerId: 'u1' }]]);
    expect(m.notified).toEqual([expect.objectContaining({ type: 'task.unblocked', userId: 'u1', sessionId: `s-${id(2)}`, link: `/sessions/s-${id(2)}` })]);
    // Option consommée : un second passage (autre dépendance terminée en même temps) ne relance rien.
    await startUnblockedDependents(updated(dep, { ...dep, status: 'done' }));
    expect(m.started).toHaveLength(1);
  });
  it('rien quand la tâche ne passe pas à terminée (annulée, déjà terminée)', async () => {
    const dep = task(1, { status: 'in_progress', dependentIds: [id(2)] });
    put(task(2, { autoStartWhenUnblocked: true, autoStartById: 'u1' }));
    m.armed.add(id(2));
    await startUnblockedDependents(updated(dep, { ...dep, status: 'cancelled' }));
    await startUnblockedDependents(updated({ ...dep, status: 'done' }, { ...dep, status: 'done', title: 'renommée' }));
    expect(m.started).toEqual([]);
  });
  it('au nom d’un agent : sa configuration ; un échec est notifié', async () => {
    m.agents.set('a1', { id: 'a1', name: 'Dev', enabled: true, archivedAt: null, defaults: { permissionMode: 'acceptEdits' } });
    const dep = task(1, { status: 'in_progress', dependentIds: [id(2), id(3)] });
    put(task(2, { autoStartWhenUnblocked: true, autoStartById: 'a1' }), task(3, { autoStartWhenUnblocked: true, autoStartById: 'u1' }));
    m.armed.add(id(2));
    await startUnblockedDependents(updated(dep, { ...dep, status: 'done' }));
    expect(m.started).toEqual([[id(2), { ownerId: 'a1', provider: 'claude', config: { permissionMode: 'acceptEdits' } }]]);
    m.armed.add(id(3));
    m.startError = 'dossier indisponible';
    await startUnblockedDependents(updated(dep, { ...dep, status: 'done' }));
    expect(m.notified.at(-1)).toMatchObject({ type: 'task.autostart_failed', userId: 'u1', message: expect.stringContaining('dossier indisponible') });
  });
});
