import { randomUUID } from 'node:crypto';
import type { Actor } from '../context/types.js';
import { AppError, NotFoundError } from '../errors.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import { slugify } from '../projects/slug.js';
import { isPersonalProject } from '../projects/types.js';
import { scheduleService } from '../schedules/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { AttachmentInput, Session } from '../sessions/types.js';
import { composeTaskPrompt, startTaskSession, taskFiles } from '../tasks/launch.js';
import { fold } from '../tasks/mentions.js';
import { taskService } from '../tasks/service.js';
import type { Task } from '../tasks/types.js';
import { userRepository } from '../users/repository.js';
import { userService } from '../users/service.js';
import { ROLE_RANK, type User } from '../users/types.js';
import { agentRepository } from './repository.js';
import { AGENT_TEMPLATES, templateFor } from './templates.js';
import { AGENT_KINDS, type Agent, type AgentAccountKind, type AgentAction, type AgentActionInput, type AgentInput, type AgentManagerRole, type AgentStats, type AgentTemplate, type OwnerAccounts, normalizeAvatar, normalizeTriggers } from './types.js';

const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;
const INSTRUCTIONS_MAX = 20_000;
const ACTION_MAX = 20;

/** Adresse technique d'un agent : jamais invitable, jamais rapprochée d'un compte Google. */
export const agentEmail = (id: string) => `agent-${id}@agents.skipper`;

/** Ce qu'une convocation transmet à l'agent. */
export interface SummonOptions {
  /** Tâche concernée : la session reliée de l'agent reçoit le message, sinon une session est ouverte sur la tâche. */
  taskId?: string | null;
  text: string;
  attachments?: AttachmentInput[] | null;
  /** Personne qui convoque (null : un déclencheur ou une planification). */
  requestedById?: string | null;
  /** Qui agit (pour les sessions créées). */
  actor?: Actor;
}

function actionKey(input: AgentActionInput, taken: Set<string>): string {
  const base = (input.key?.trim() || slugify(input.label) || 'action').slice(0, 40);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

export const agentService = {
  templates: (): AgentTemplate[] => AGENT_TEMPLATES,

  async get(id: string): Promise<Agent> {
    const agent = await agentRepository.findById(id);
    if (!agent) throw new NotFoundError('Agent introuvable');
    return agent;
  },

  /** Profil d'un utilisateur s'il est un agent, null pour une personne (ou un identifiant inconnu). */
  forUser: (userId: string | null | undefined): Promise<Agent | null> => (userId ? agentRepository.findById(userId) : Promise.resolve(null)),

  listByProject: (projectId: string, opts?: { includeArchived?: boolean }) => agentRepository.listByProject(projectId, opts),
  listActive: (projectIds: string[]) => agentRepository.listActive(projectIds),
  managers: (agentId: string) => agentRepository.listManagers(agentId),
  stats: (agentId: string): Promise<AgentStats> => agentRepository.stats(agentId),

  /** Agent d'un projet désigné par son identifiant ou son nom (sans casse ni accents). */
  async resolve(projectId: string, ref: string): Promise<Agent> {
    const agents = await agentRepository.listByProject(projectId);
    const wanted = fold(ref);
    const found = agents.find((a) => a.id === ref.trim().toLowerCase()) ?? agents.find((a) => fold(a.name) === wanted);
    if (!found) throw new NotFoundError(`Aucun agent « ${ref} » dans ce projet${agents.length ? ` (agents : ${agents.map((a) => a.name).join(', ')})` : ''}`);
    return found;
  },

  /** Peut gérer l'agent : propriétaire ou gestionnaire de l'agent, ou administrateur du projet. */
  async canManage(userId: string, agent: Pick<Agent, 'id' | 'projectId'>): Promise<boolean> {
    if (await agentRepository.isManager(agent.id, userId)) return true;
    return (await userService.roleFor(userId, agent.projectId)) === 'admin';
  },

  async assertCanManage(userId: string, agent: Pick<Agent, 'id' | 'projectId'>): Promise<void> {
    if (!(await this.canManage(userId, agent))) throw new AppError("Seuls les gestionnaires de l'agent et les administrateurs du projet peuvent le modifier", 'FORBIDDEN');
  },

  /** L'utilisateur agent pour le compte duquel une personne règle des comptes (`?actAs=`), si elle le gère. */
  async actAsFor(user: User, agentId: string): Promise<User> {
    const agent = await this.get(agentId);
    await this.assertCanManage(user.id, agent);
    const actAs = await userRepository.findById(agent.id);
    if (!actAs) throw new NotFoundError('Agent introuvable');
    return actAs;
  },

  /** Le nom doit être unique parmi les membres du projet (c'est l'alias de mention). */
  async assertNameFree(projectId: string, name: string, exceptUserId: string | null = null): Promise<void> {
    const wanted = fold(name);
    for (const m of await userService.members(projectId)) {
      if (m.userId === exceptUserId) continue;
      const u = await userRepository.findById(m.userId);
      if (u && fold(u.name) === wanted) throw new AppError(`Un membre du projet s'appelle déjà « ${u.name} » : choisissez un autre nom pour l'agent`);
    }
  },

  /**
   * Crée un agent : utilisateur de genre « agent », membre du projet (rôle membre), profil d'après le modèle de son
   * rôle puis l'entrée, dossier de contexte `agents/<slug>`, créateur propriétaire. Un espace personnel n'a pas d'agent.
   */
  async create(projectId: string, input: AgentInput, creator: User): Promise<Agent> {
    const project = await projectService.get(projectId);
    if (isPersonalProject(project)) throw new AppError("Un espace personnel n'a pas d'agents");
    const kind = input.kind && AGENT_KINDS.includes(input.kind) ? input.kind : 'custom';
    const template = templateFor(kind);
    const name = (input.name ?? template.suggestedName).trim();
    if (!name) throw new AppError("Donnez un nom à l'agent");
    if (name.length > NAME_MAX) throw new AppError(`Le nom dépasse ${NAME_MAX} caractères`);
    if (name.includes('@')) throw new AppError("Le nom d'un agent ne contient pas de « @ »");
    await this.assertNameFree(projectId, name);
    const id = randomUUID();
    const user = await userRepository.create({ id, email: agentEmail(id), name, kind: 'agent' });
    await userRepository.upsertMembership({ projectId, userId: user.id, role: 'member', invitedById: creator.id });
    const actions = this.prepareActions(input.actions ?? template.actions, []);
    const agent = await agentRepository.create({
      userId: user.id,
      projectId,
      kind,
      avatar: normalizeAvatar({ ...template.avatar, ...(input.avatar ?? {}) }),
      description: (input.description ?? template.description).trim().slice(0, DESCRIPTION_MAX),
      instructions: this.validInstructions(input.instructions ?? template.instructions),
      taskFolder: input.taskFolder ?? template.taskFolder,
      defaults: input.defaults ?? template.defaults,
      inheritContext: input.inheritContext ?? true,
      triggers: normalizeTriggers(input.triggers ?? template.triggers),
      actions,
      createdById: creator.id,
    });
    await agentRepository.setManagers(agent.id, [{ userId: creator.id, role: 'owner' }]);
    await this.syncActionSchedules(agent).catch((err) => log.warn(`[agents] planification des actions de ${agent.name}`, err));
    return this.get(agent.id);
  },

  validInstructions(text: string): string {
    const t = text.replace(/\u0000/g, '').trim();
    if (t.length > INSTRUCTIONS_MAX) throw new AppError(`Les instructions dépassent ${INSTRUCTIONS_MAX} caractères`);
    return t;
  },

  /** Actions validées, clés uniques, identifiants des sessions planifiées repris des actions existantes de même clé. */
  prepareActions(inputs: AgentActionInput[], existing: AgentAction[]): AgentAction[] {
    if (inputs.length > ACTION_MAX) throw new AppError(`Au plus ${ACTION_MAX} actions par agent`);
    const taken = new Set<string>();
    return inputs.map((a) => {
      const label = a.label.trim();
      const instruction = a.instruction.replace(/\u0000/g, '').trim();
      if (!label) throw new AppError('Chaque action a un libellé');
      if (!instruction) throw new AppError(`L'action « ${label} » n'a pas d'instruction`);
      const key = actionKey(a, taken);
      return { key, label: label.slice(0, 80), instruction, cron: a.cron?.trim() || null, timezone: a.timezone?.trim() || null, scheduleSessionId: existing.find((e) => e.key === key)?.scheduleSessionId ?? null };
    });
  },

  async update(id: string, input: AgentInput): Promise<Agent> {
    const agent = await this.get(id);
    if (input.name !== undefined && input.name !== null) {
      const name = input.name.trim();
      if (!name) throw new AppError("Donnez un nom à l'agent");
      if (name.length > NAME_MAX) throw new AppError(`Le nom dépasse ${NAME_MAX} caractères`);
      if (name.includes('@')) throw new AppError("Le nom d'un agent ne contient pas de « @ »");
      if (name !== agent.name) {
        await this.assertNameFree(agent.projectId, name, agent.id);
        await userRepository.rename(agent.id, name);
      }
    }
    const updated = await agentRepository.update(id, {
      ...(input.kind && AGENT_KINDS.includes(input.kind) ? { kind: input.kind } : {}),
      ...(input.avatar !== undefined ? { avatar: normalizeAvatar(input.avatar) } : {}),
      ...(input.description !== undefined && input.description !== null ? { description: input.description.trim().slice(0, DESCRIPTION_MAX) } : {}),
      ...(input.instructions !== undefined && input.instructions !== null ? { instructions: this.validInstructions(input.instructions) } : {}),
      ...(input.taskFolder !== undefined && input.taskFolder !== null ? { taskFolder: input.taskFolder } : {}),
      ...(input.defaults !== undefined && input.defaults !== null ? { defaults: input.defaults } : {}),
      ...(input.inheritContext !== undefined && input.inheritContext !== null ? { inheritContext: input.inheritContext } : {}),
      ...(input.triggers !== undefined && input.triggers !== null ? { triggers: normalizeTriggers({ ...agent.triggers, ...input.triggers }) } : {}),
      ...(input.actions !== undefined && input.actions !== null ? { actions: this.prepareActions(input.actions, agent.actions) } : {}),
    });
    if (!updated) throw new NotFoundError('Agent introuvable');
    if (input.actions !== undefined || (input.name && input.name.trim() !== agent.name)) {
      await this.syncActionSchedules(updated, agent.actions).catch((err) => log.warn(`[agents] planification des actions de ${updated.name}`, err));
    }
    return this.get(id);
  },

  async setEnabled(id: string, enabled: boolean): Promise<Agent> {
    const agent = await this.get(id);
    const updated = await agentRepository.update(id, { enabled });
    for (const a of agent.actions) {
      if (a.scheduleSessionId) await scheduleService.setEnabled(a.scheduleSessionId, enabled && Boolean(a.cron)).catch(() => undefined);
    }
    return updated ?? agent;
  },

  /**
   * Retire l'agent du projet : profil archivé, appartenance retirée, sessions planifiées de ses actions supprimées.
   * L'utilisateur et ses sessions restent (historique, coûts) ; il ne réagit plus à rien et ne se mentionne plus.
   */
  async remove(id: string): Promise<boolean> {
    const agent = await this.get(id);
    for (const a of agent.actions) if (a.scheduleSessionId) await this.dropActionSchedule(a.scheduleSessionId);
    await agentRepository.update(id, { archivedAt: new Date(), enabled: false, actions: agent.actions.map((a) => ({ ...a, scheduleSessionId: null })) });
    await userRepository.removeMembership(agent.projectId, agent.id);
    return true;
  },

  async setManagers(id: string, managers: { userId: string; role: AgentManagerRole }[]): Promise<Agent> {
    const agent = await this.get(id);
    const owners = managers.filter((m) => m.role === 'owner');
    if (owners.length !== 1) throw new AppError("Un agent a exactement un propriétaire");
    const seen = new Set<string>();
    for (const m of managers) {
      if (seen.has(m.userId)) throw new AppError('Une personne ne figure qu’une fois parmi les gestionnaires');
      seen.add(m.userId);
      const user = await userRepository.findById(m.userId);
      if (!user || user.kind !== 'person') throw new AppError('Les gestionnaires sont des personnes');
      const role = await userService.roleFor(m.userId, agent.projectId);
      if (!role || ROLE_RANK[role] < ROLE_RANK.member) throw new AppError(`${user.name} doit être membre du projet pour gérer l'agent`);
    }
    await agentRepository.setManagers(id, managers);
    return agent;
  },

  // ---- Comptes et délégation ---------------------------------------------------------------------

  /** Les comptes qui font tourner les sessions d'un agent : les siens, ou ceux qu'une personne lui a prêtés. */
  accounts(agent: Agent): OwnerAccounts {
    return {
      claudeUserId: agent.claudeDelegateId ?? agent.id,
      gitUserId: agent.gitDelegateId ?? agent.id,
      gitReadOnly: Boolean(agent.gitDelegateId && agent.gitDelegateReadOnly),
    };
  },

  /** Comptes d'un propriétaire de session quel qu'il soit : une personne (les siens), ou un agent (délégation éventuelle). */
  async accountsForOwner(ownerId: string | null | undefined): Promise<OwnerAccounts | null> {
    if (!ownerId) return null;
    const agent = await agentRepository.findById(ownerId);
    return agent ? this.accounts(agent) : { claudeUserId: ownerId, gitUserId: ownerId, gitReadOnly: false };
  },

  /**
   * Prête (ou reprend) un compte à l'agent : `delegateId` est la personne qui prête — elle ne peut prêter que son propre
   * compte, et doit être membre du projet ; null retire la délégation. Les comptes git se prêtent en lecture seule par défaut.
   */
  async setDelegation(agentId: string, account: AgentAccountKind, delegateId: string | null, opts: { readOnly?: boolean | null } = {}): Promise<Agent> {
    const agent = await this.get(agentId);
    if (delegateId) {
      const user = await userRepository.findById(delegateId);
      if (!user || user.kind !== 'person') throw new AppError('Seule une personne peut prêter son compte');
      const role = await userService.roleFor(delegateId, agent.projectId);
      if (!role || ROLE_RANK[role] < ROLE_RANK.member) throw new AppError(`${user.name} doit être membre du projet pour prêter son compte à l'agent`);
    }
    const updated = await agentRepository.update(agentId, account === 'claude' ? { claudeDelegateId: delegateId } : { gitDelegateId: delegateId, gitDelegateReadOnly: delegateId ? (opts.readOnly ?? true) : true });
    if (!updated) throw new NotFoundError('Agent introuvable');
    return updated;
  },

  /** Bibliothèques propres des agents actifs d'un projet (outils `context`, paramètre `library`). */
  async libraries(projectId: string): Promise<{ id: string; name: string }[]> {
    return (await agentRepository.listByProject(projectId)).map((a) => ({ id: a.id, name: a.name }));
  },

  // ---- Convocation ------------------------------------------------------------------------------

  /** Session non archivée de l'agent reliée à la tâche, la plus récente, pourvu que son dossier existe encore. */
  async sessionOnTask(agent: Agent, taskId: string): Promise<Session | null> {
    for (const id of await agentRepository.sessionIdsOnTask(agent.id, taskId)) {
      const s = await sessionRepository.findById(id);
      if (!s || s.archivedAt) continue;
      if (!s.worksessionId) continue;
      return s;
    }
    return null;
  },

  /** Configuration d'une session de l'agent : ses réglages par défaut, puis ceux demandés. */
  sessionConfig(agent: Agent, config: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const { provider: _provider, ...defaults } = agent.defaults as Record<string, unknown> & { provider?: string };
    return { ...defaults, ...(config ?? {}) };
  },

  providerOf(agent: Agent): string {
    const p = agent.defaults.provider;
    return typeof p === 'string' && p.trim() ? p.trim() : 'claude';
  },

  /**
   * Convoque l'agent : avec une tâche, sa session reliée à la tâche reçoit le message (relancée si elle était
   * terminée), sinon une session est ouverte sur la tâche — dans le dossier de la tâche pour un agent qui y travaille
   * (comme « Confier à un agent »), dans un dossier à part sinon (session seulement reliée à la tâche, dont elle
   * suit le fil). Sans tâche, une nouvelle session dans son propre dossier, nommée d'après le message.
   */
  async summon(agentId: string, opts: SummonOptions): Promise<Session> {
    const agent = await this.get(agentId);
    if (agent.archivedAt) throw new AppError(`L'agent ${agent.name} a été retiré du projet`);
    if (!agent.enabled) throw new AppError(`L'agent ${agent.name} est en pause`);
    const text = opts.text.replace(/\u0000/g, '').trim();
    if (!text && !opts.attachments?.length) throw new AppError('Le message est vide');
    const project = await projectService.get(agent.projectId);
    const actor = opts.actor ?? { type: 'human' };
    if (opts.taskId) {
      const task = await taskService.get(opts.taskId);
      if (task.projectId !== agent.projectId) throw new AppError(`La tâche n'appartient pas au projet de ${agent.name}`);
      const existing = await this.sessionOnTask(agent, task.id);
      if (existing && existing.status !== 'queued') {
        return sessionService.sendMessage(existing.id, text, opts.attachments ?? null);
      }
      if (agent.taskFolder) {
        return startTaskSession(task.id, {
          ownerId: agent.id,
          requestedById: opts.requestedById ?? null,
          provider: this.providerOf(agent),
          config: this.sessionConfig(agent, null),
          instructions: text,
        });
      }
      return this.sessionBesideTask(agent, task, text, opts, actor, project.taskInstructions);
    }
    return sessionService.create(
      {
        projectId: agent.projectId,
        newWorksession: {},
        name: `${agent.name} · ${(text.split('\n').find((l) => l.trim()) ?? 'Conversation').trim()}`.slice(0, 80),
        provider: this.providerOf(agent),
        prompt: text,
        attachments: opts.attachments ?? null,
        config: this.sessionConfig(agent, null),
        ownerId: agent.id,
        requestedById: opts.requestedById ?? null,
      },
      actor,
    );
  },

  /** Session de l'agent sur une tâche sans en prendre le dossier : nouveau dossier à elle, reliée à la tâche (fil suivi). */
  async sessionBesideTask(agent: Agent, task: Task, text: string, opts: SummonOptions, actor: Actor, taskInstructions: string): Promise<Session> {
    const files = await taskFiles(task.id);
    const prompt = composeTaskPrompt(task, await taskService.comments(task.id), files, taskInstructions, text);
    const session = await sessionService.create(
      {
        projectId: agent.projectId,
        newWorksession: { label: `${agent.name} · ${task.title}`.slice(0, 100) },
        name: `${agent.name} · ${task.title}`.slice(0, 80),
        provider: this.providerOf(agent),
        prompt,
        attachments: opts.attachments ?? null,
        config: this.sessionConfig(agent, null),
        ownerId: agent.id,
        requestedById: opts.requestedById ?? null,
        autoStart: false,
      },
      actor,
    );
    await taskService.linkSession(task.id, session.id).catch((err) => log.warn('[agents] session non reliée à la tâche', err));
    return sessionService.start(session.id);
  },

  /** Joue une action nommée de l'agent (à la demande). */
  async runAction(agentId: string, key: string, opts: { taskId?: string | null; requestedById?: string | null; actor?: Actor } = {}): Promise<Session> {
    const agent = await this.get(agentId);
    const action = agent.actions.find((a) => a.key === key);
    if (!action) throw new NotFoundError(`Action « ${key} » inconnue pour ${agent.name}`);
    return this.summon(agentId, { taskId: opts.taskId ?? null, text: action.instruction, requestedById: opts.requestedById ?? null, actor: opts.actor });
  },

  // ---- Actions planifiées ----------------------------------------------------------------------

  /** Une session planifiée par action à `cron` (créée, mise à jour, supprimée) ; l'agent en est le propriétaire. */
  async syncActionSchedules(agent: Agent, previous: AgentAction[] = agent.actions): Promise<void> {
    const actions = [...agent.actions];
    let changed = false;
    for (const prev of previous) {
      if (prev.scheduleSessionId && !actions.some((a) => a.key === prev.key)) await this.dropActionSchedule(prev.scheduleSessionId);
    }
    for (const action of actions) {
      const name = `${agent.name} · ${action.label}`.slice(0, 120);
      if (action.cron) {
        try {
          if (action.scheduleSessionId && (await sessionRepository.findById(action.scheduleSessionId))) {
            await scheduleService.set(action.scheduleSessionId, { name, cron: action.cron, timezone: action.timezone, prompt: action.instruction, enabled: agent.enabled });
            continue;
          }
          const session = await scheduleService.createWithSession(
            { projectId: agent.projectId, name, cron: action.cron, timezone: action.timezone, prompt: action.instruction, enabled: agent.enabled, provider: this.providerOf(agent), config: this.sessionConfig(agent, null) },
            agent.id,
          );
          action.scheduleSessionId = session.id;
          changed = true;
        } catch (err) {
          throw new AppError(`Action « ${action.label} » : ${(err as Error).message}`);
        }
      } else if (action.scheduleSessionId) {
        await this.dropActionSchedule(action.scheduleSessionId);
        action.scheduleSessionId = null;
        changed = true;
      }
    }
    if (changed) await agentRepository.update(agent.id, { actions });
  },

  async dropActionSchedule(sessionId: string): Promise<void> {
    await scheduleService.remove(sessionId).catch(() => undefined);
    await sessionService.archive(sessionId).catch(() => undefined);
  },

  // ---- Activité ---------------------------------------------------------------------------------

  sessions: (agentId: string, limit = 50) => sessionService.list({ ownerId: agentId, archived: 'all', kind: 'all', limit }),
  async tasks(agentId: string, limit = 50): Promise<Task[]> {
    const ids = await agentRepository.taskIdsTouched(agentId, limit);
    if (!ids.length) return [];
    const tasks = await Promise.all(ids.map((id) => taskService.get(id).catch(() => null)));
    return tasks.filter((t): t is Task => Boolean(t));
  },
};
