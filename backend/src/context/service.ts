import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { slugify } from '../projects/service.js';
import { contextRepository, type FolderRecord, type InstructionRecord } from './repository.js';
import { materializeSkills } from './skills.js';
import type { Actor, ContextChange, ContextFolder, ContextInstruction, ContextInstructionVersion, ContextTree, Library } from './types.js';
import { log } from '../log.js';

export const HUMAN: Actor = { type: 'human' };

/** Bibliothèque du projet (agentId null) ou propre d'un agent. */
export const libraryOf = (projectId: string, agentId: string | null | undefined = null): Library => ({ projectId, agentId: agentId ?? null });

function toSlug(name: string): string {
  const slug = slugify(name);
  if (!slug) throw new AppError(`Nom invalide : "${name}"`);
  return slug;
}

/** Normalise un chemin de slugs : "API/Auth/Règles JWT" -> "api/auth/regles-jwt". */
export function normalizePath(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toSlug);
}

function computePaths(folders: FolderRecord[], instructions: InstructionRecord[]): ContextTree {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string>();
  const folderPath = (id: string | null): string => {
    if (!id) return '';
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f) return '';
    const parent = folderPath(f.parentId);
    const p = parent ? `${parent}/${f.slug}` : f.slug;
    cache.set(id, p);
    return p;
  };
  const join = (folderId: string | null, slug: string) => {
    const parent = folderPath(folderId);
    return parent ? `${parent}/${slug}` : slug;
  };
  return {
    folders: folders.map((f) => ({ ...f, path: folderPath(f.id) })).sort((a, b) => a.path.localeCompare(b.path)),
    instructions: instructions.map((i) => ({ ...i, path: join(i.folderId, i.slug) })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Après chaque modification, les skills de la bibliothèque sont régénérés (tâche de fond, sans bloquer). */
function refreshSkills(library: Library): void {
  void projectService
    .get(library.projectId)
    .then((project) => materializeSkills(project, library.agentId))
    .catch((err) => log.error('[context] génération des skills', err));
}

const sameLibrary = (a: Library, b: Library) => a.projectId === b.projectId && (a.agentId ?? null) === (b.agentId ?? null);
const libraryOfRecord = (r: { projectId: string; agentId: string | null }): Library => ({ projectId: r.projectId, agentId: r.agentId ?? null });

export type ResolvedPath = { kind: 'folder'; folder: ContextFolder } | { kind: 'instruction'; instruction: ContextInstruction } | { kind: 'root' } | null;

export const contextService = {
  /** Arborescence d'une bibliothèque : celle du projet par défaut, celle d'un agent avec `agentId`. */
  async tree(projectId: string, agentId: string | null = null): Promise<ContextTree> {
    const [folders, instructions] = await Promise.all([contextRepository.listFolders(projectId, agentId), contextRepository.listInstructions(projectId, agentId)]);
    return computePaths(folders, instructions);
  },

  async getFolder(id: string): Promise<ContextFolder> {
    const record = await contextRepository.findFolder(id);
    if (!record) throw new NotFoundError('Dossier introuvable');
    const tree = await this.tree(record.projectId, record.agentId);
    return tree.folders.find((f) => f.id === id)!;
  },

  async getInstruction(id: string): Promise<ContextInstruction> {
    const record = await contextRepository.findInstruction(id);
    if (!record) throw new NotFoundError('Instruction introuvable');
    const tree = await this.tree(record.projectId, record.agentId);
    return tree.instructions.find((i) => i.id === id)!;
  },

  /** Résout un chemin de slugs vers un dossier ou une instruction d'une bibliothèque. */
  async resolve(projectId: string, path: string, agentId: string | null = null): Promise<ResolvedPath> {
    const parts = normalizePath(path);
    if (parts.length === 0) return { kind: 'root' };
    const tree = await this.tree(projectId, agentId);
    const p = parts.join('/');
    const instruction = tree.instructions.find((i) => i.path === p);
    if (instruction) return { kind: 'instruction', instruction };
    const folder = tree.folders.find((f) => f.path === p);
    if (folder) return { kind: 'folder', folder };
    return null;
  },

  // --- Dossiers ---

  async createFolder(projectId: string, input: { parentId?: string | null; name: string; agentId?: string | null }, actor: Actor): Promise<ContextFolder> {
    await projectService.get(projectId);
    const library = libraryOf(projectId, input.agentId);
    const slug = toSlug(input.name);
    if (input.parentId) {
      const parent = await contextRepository.findFolder(input.parentId);
      if (!parent || !sameLibrary(libraryOfRecord(parent), library)) throw new NotFoundError('Dossier parent introuvable');
    }
    let record: FolderRecord;
    try {
      record = await contextRepository.createFolder(projectId, library.agentId, input.parentId ?? null, input.name.trim(), slug);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un dossier "${slug}" existe déjà à cet emplacement`);
      throw err;
    }
    const folder = await this.getFolder(record.id);
    await contextRepository.addChange(library, 'folder.create', folder.path, {}, actor);
    refreshSkills(library);
    return folder;
  },

  /** Crée les dossiers manquants le long d'un chemin et renvoie le dossier final (null = racine). */
  async ensureFolderPath(projectId: string, path: string, actor: Actor, agentId: string | null = null): Promise<ContextFolder | null> {
    const parts = normalizePath(path);
    let parent: ContextFolder | null = null;
    for (const part of parts) {
      const tree: ContextTree = await this.tree(projectId, agentId);
      const targetPath: string = parent ? `${parent.path}/${part}` : part;
      const existing: ContextFolder | undefined = tree.folders.find((f) => f.path === targetPath);
      const parentId: string | null = parent ? parent.id : null;
      parent = existing ?? (await this.createFolder(projectId, { parentId, name: part, agentId }, actor));
    }
    return parent;
  },

  async renameFolder(id: string, name: string, actor: Actor): Promise<ContextFolder> {
    const before = await this.getFolder(id);
    const slug = toSlug(name);
    try {
      await contextRepository.updateFolder(id, { name: name.trim(), slug });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un dossier "${slug}" existe déjà à cet emplacement`);
      throw err;
    }
    const after = await this.getFolder(id);
    await contextRepository.addChange(libraryOfRecord(before), 'folder.rename', after.path, { from: before.path }, actor);
    refreshSkills(libraryOfRecord(before));
    return after;
  },

  async moveFolder(id: string, parentId: string | null, actor: Actor): Promise<ContextFolder> {
    const before = await this.getFolder(id);
    if (parentId) {
      const target = await this.getFolder(parentId);
      if (!sameLibrary(libraryOfRecord(target), libraryOfRecord(before))) throw new AppError('Le dossier cible appartient à une autre bibliothèque');
      if (target.id === id || target.path.startsWith(`${before.path}/`)) throw new AppError('Impossible de déplacer un dossier dans lui-même');
    }
    try {
      await contextRepository.updateFolder(id, { parentId });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un dossier "${before.slug}" existe déjà dans la destination`);
      throw err;
    }
    const after = await this.getFolder(id);
    await contextRepository.addChange(libraryOfRecord(before), 'folder.move', after.path, { from: before.path }, actor);
    refreshSkills(libraryOfRecord(before));
    return after;
  },

  async deleteFolder(id: string, actor: Actor): Promise<boolean> {
    const folder = await this.getFolder(id);
    const tree = await this.tree(folder.projectId, folder.agentId);
    const removed = tree.instructions.filter((i) => i.path.startsWith(`${folder.path}/`)).map((i) => i.path);
    const ok = await contextRepository.deleteFolder(id);
    await contextRepository.addChange(libraryOfRecord(folder), 'folder.delete', folder.path, { instructions: removed }, actor);
    refreshSkills(libraryOfRecord(folder));
    return ok;
  },

  // --- Instructions ---

  async createInstruction(
    projectId: string,
    input: { folderId?: string | null; name: string; description?: string | null; content?: string | null; changeNote?: string | null; agentId?: string | null },
    actor: Actor,
  ): Promise<ContextInstruction> {
    await projectService.get(projectId);
    const library = libraryOf(projectId, input.agentId);
    const slug = toSlug(input.name);
    if (input.folderId) {
      const folder = await contextRepository.findFolder(input.folderId);
      if (!folder || !sameLibrary(libraryOfRecord(folder), library)) throw new NotFoundError('Dossier introuvable');
    }
    const client = await pool.connect();
    let record: InstructionRecord;
    try {
      await client.query('BEGIN');
      record = await contextRepository.createInstruction(
        { projectId, agentId: library.agentId, folderId: input.folderId ?? null, name: input.name.trim(), slug, description: (input.description ?? '').trim(), content: input.content ?? '' },
        client,
      );
      await contextRepository.addVersion(record, input.changeNote ?? 'Création', actor, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') throw new AppError(`Une instruction "${slug}" existe déjà à cet emplacement`);
      throw err;
    } finally {
      client.release();
    }
    const instruction = await this.getInstruction(record.id);
    await contextRepository.addChange(library, 'instruction.create', instruction.path, { version: 1 }, actor);
    refreshSkills(library);
    if (actor.type === 'agent' && !library.agentId) {
      void notificationService.notify({
        type: 'context.created',
        title: 'Un agent a ajouté une instruction au contexte',
        message: instruction.path,
        link: `/projects/${projectId}/context?instruction=${instruction.id}`,
        projectId,
        sessionId: actor.sessionId ?? null,
      });
    }
    return instruction;
  },

  /** Crée ou met à jour l'instruction désignée par un chemin (les dossiers manquants sont créés). */
  async writeInstructionAtPath(
    projectId: string,
    path: string,
    input: { content: string; description?: string | null; changeNote?: string | null },
    actor: Actor,
    agentId: string | null = null,
  ): Promise<{ instruction: ContextInstruction; created: boolean }> {
    const parts = normalizePath(path);
    if (parts.length === 0) throw new AppError('Chemin vide');
    const resolved = await this.resolve(projectId, path, agentId);
    if (resolved?.kind === 'folder') throw new AppError(`"${resolved.folder.path}" est un dossier`);
    if (resolved?.kind === 'instruction') {
      const instruction = await this.updateInstruction(resolved.instruction.id, { content: input.content, description: input.description ?? undefined, changeNote: input.changeNote }, actor);
      return { instruction, created: false };
    }
    const name = path.split('/').map((s) => s.trim()).filter(Boolean).pop()!;
    const folder = await this.ensureFolderPath(projectId, parts.slice(0, -1).join('/'), actor, agentId);
    const instruction = await this.createInstruction(projectId, { folderId: folder?.id ?? null, name, description: input.description, content: input.content, changeNote: input.changeNote, agentId }, actor);
    return { instruction, created: true };
  },

  async updateInstruction(
    id: string,
    input: { name?: string | null; description?: string | null; content?: string | null; folderId?: string | null; changeNote?: string | null },
    actor: Actor,
  ): Promise<ContextInstruction> {
    const before = await this.getInstruction(id);
    const library = libraryOfRecord(before);
    const patch: { name?: string; slug?: string; description?: string; content?: string; folderId?: string | null; version?: number } = {};
    if (input.name != null && input.name.trim() !== before.name) {
      patch.name = input.name.trim();
      patch.slug = toSlug(input.name);
    }
    if (input.description != null && input.description.trim() !== before.description) patch.description = input.description.trim();
    if (input.content != null && input.content !== before.content) patch.content = input.content;
    const moved = input.folderId !== undefined && input.folderId !== before.folderId;
    if (moved) {
      if (input.folderId) {
        const folder = await contextRepository.findFolder(input.folderId);
        if (!folder || !sameLibrary(libraryOfRecord(folder), library)) throw new NotFoundError('Dossier cible introuvable');
      }
      patch.folderId = input.folderId ?? null;
    }
    const contentChanged = patch.name !== undefined || patch.description !== undefined || patch.content !== undefined;
    if (!contentChanged && !moved) return before;
    if (contentChanged) patch.version = before.version + 1;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const record = await contextRepository.updateInstruction(id, patch, client);
      if (!record) throw new NotFoundError('Instruction introuvable');
      if (contentChanged) await contextRepository.addVersion(record, input.changeNote ?? null, actor, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') throw new AppError('Une instruction du même nom existe déjà à cet emplacement');
      throw err;
    } finally {
      client.release();
    }
    const after = await this.getInstruction(id);
    if (moved) await contextRepository.addChange(library, 'instruction.move', after.path, { from: before.path }, actor);
    if (contentChanged) {
      await contextRepository.addChange(library, 'instruction.update', after.path, { version: after.version, changeNote: input.changeNote ?? null, renamedFrom: patch.name ? before.path : undefined }, actor);
    }
    refreshSkills(library);
    return after;
  },

  async deleteInstruction(id: string, actor: Actor): Promise<boolean> {
    const instruction = await this.getInstruction(id);
    const ok = await contextRepository.deleteInstruction(id);
    await contextRepository.addChange(libraryOfRecord(instruction), 'instruction.delete', instruction.path, { version: instruction.version }, actor);
    refreshSkills(libraryOfRecord(instruction));
    return ok;
  },

  versions: (instructionId: string): Promise<ContextInstructionVersion[]> => contextRepository.listVersions(instructionId),

  /** Restaure le contenu d'une ancienne version : crée une nouvelle version (l'historique reste intact). */
  async restoreVersion(id: string, version: number, actor: Actor): Promise<ContextInstruction> {
    const target = await contextRepository.findVersion(id, version);
    if (!target) throw new NotFoundError(`Version ${version} introuvable`);
    const restored = await this.updateInstruction(
      id,
      { name: target.name, description: target.description, content: target.content, changeNote: `Restauration de la version ${version}` },
      actor,
    );
    await contextRepository.addChange(libraryOfRecord(restored), 'instruction.restore', restored.path, { restoredVersion: version, version: restored.version }, actor);
    return restored;
  },

  async search(projectId: string, query: string, agentId: string | null = null): Promise<ContextInstruction[]> {
    const q = query.trim();
    if (!q) return [];
    const [records, tree] = await Promise.all([contextRepository.searchInstructions(projectId, q, agentId), this.tree(projectId, agentId)]);
    const ids = new Set(records.map((r) => r.id));
    return tree.instructions.filter((i) => ids.has(i.id));
  },

  changes: (projectId: string, limit?: number, agentId: string | null = null): Promise<ContextChange[]> => contextRepository.listChanges(projectId, agentId, limit),

  /**
   * Résumé textuel d'une bibliothèque, injecté dans le prompt système des agents. `own` : la bibliothèque propre de
   * l'agent qui joue la session (skills `memoire:`), sinon celle du projet (skills `context:`).
   */
  async promptSummary(projectId: string, agentId: string | null = null, opts: { own?: boolean; libraryName?: string | null } = {}): Promise<string> {
    const tree = await this.tree(projectId, agentId);
    const skill = opts.own ? 'memoire' : 'context';
    const param = agentId ? ` (paramètre \`library: "${opts.libraryName ?? agentId}"\` des outils \`context\`)` : '';
    const intro = opts.own
      ? `Tu as ta propre bibliothèque de contexte, distincte de celle du projet : ta mémoire durable (décisions, conventions, glossaire, ce que tu apprends), que tu consultes en début de travail et où tu ranges ce qui doit durer. Les outils du serveur MCP \`context\` y agissent par défaut pour toi (tree, read, search, write, create_folder, move, delete, history) ; chaque instruction est aussi un skill \`memoire:<chemin>\`. Les personnes et les autres sessions du projet peuvent la lire et la modifier.`
      : agentId
        ? `Bibliothèque de contexte propre à l'agent${opts.libraryName ? ` ${opts.libraryName}` : ''}${param}.`
        : "Ce projet dispose d'une bibliothèque de contexte : des instructions rangées en dossiers, consultables et modifiables avec les outils du serveur MCP `context` (tree, read, search, write, create_folder, move, delete, history). Chaque instruction est aussi disponible comme skill `context:<chemin>`. Consulte les instructions pertinentes avant d'agir, et enregistre-y les décisions et conventions durables.";
    if (tree.folders.length === 0 && tree.instructions.length === 0) {
      return opts.own ? `${intro}\nElle est vide pour l'instant.` : agentId ? `${intro} Vide pour l'instant.` : "Ce projet dispose d'une bibliothèque de contexte (vide pour l'instant). Utilise les outils du serveur MCP `context` pour y ranger des instructions durables (conventions, décisions, procédures) dans des dossiers.";
    }
    const lines = tree.instructions.map((i) => `- ${i.path}${i.description ? ` — ${i.description}` : ''} (v${i.version})`);
    return [intro, `Instructions disponibles${agentId && !opts.own ? ` (skills \`${skill}:\` non disponibles : lire par l'outil \`read\`)` : ''} :`, ...lines].join('\n');
  },
};
