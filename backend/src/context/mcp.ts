import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project } from '../projects/types.js';
import { fold } from '../tasks/mentions.js';
import { contextService } from './service.js';
import type { Actor, ContextTree } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

function renderTree(tree: ContextTree): string {
  if (tree.folders.length === 0 && tree.instructions.length === 0) return '(bibliothèque vide)';
  const lines: string[] = [];
  const render = (folderId: string | null, indent: string) => {
    for (const i of tree.instructions.filter((x) => x.folderId === folderId)) {
      lines.push(`${indent}📄 ${i.path}${i.description ? ` — ${i.description}` : ''} (v${i.version})`);
    }
    for (const f of tree.folders.filter((x) => x.parentId === folderId)) {
      lines.push(`${indent}📁 ${f.path}/`);
      render(f.id, `${indent}  `);
    }
  };
  render(null, '');
  return lines.join('\n');
}

/** Une bibliothèque propre d'un agent du projet, désignable par son nom ou son identifiant. */
export interface AgentLibrary {
  id: string;
  name: string;
}

export interface ContextMcpOptions {
  /** Bibliothèques propres des agents du projet (toutes les sessions peuvent les lire et les modifier). */
  agentLibraries?: AgentLibrary[];
  /** Session jouée par un agent : sa bibliothèque propre est la cible par défaut des outils. */
  defaultAgentId?: string | null;
}

/**
 * Serveur MCP in-process exposant les bibliothèques de contexte d'un projet à une session d'agent : celle du projet
 * (« projet ») et celles, propres, de ses agents (par leur nom). Toutes les modifications sont attribuées à la
 * session (author agent) et versionnées.
 */
export function createContextMcpServer(project: Project, sessionId: string, opts: ContextMcpOptions = {}): McpSdkServerConfigWithInstance {
  const actor: Actor = { type: 'agent', sessionId };
  const libraries = opts.agentLibraries ?? [];
  const defaultAgentId = opts.defaultAgentId ?? null;
  const defaultName = defaultAgentId ? (libraries.find((l) => l.id === defaultAgentId)?.name ?? 'ta bibliothèque') : 'projet';
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  /** Identifiant d'agent visé par `library` (null : bibliothèque du projet) ; absent : la bibliothèque par défaut de la session. */
  const libraryId = (ref: string | undefined): string | null => {
    if (ref === undefined) return defaultAgentId;
    const wanted = fold(ref);
    if (!wanted || wanted === 'projet' || wanted === 'project') return null;
    const found = libraries.find((l) => l.id === ref.trim().toLowerCase() || fold(l.name) === wanted);
    if (!found) throw new Error(`Bibliothèque « ${ref} » inconnue : « projet »${libraries.length ? ` ou un agent (${libraries.map((l) => l.name).join(', ')})` : ''}`);
    return found.id;
  };
  const libraryParam = { library: z.string().optional().describe(`Bibliothèque visée : « projet » ou le nom d'un agent du projet (${libraries.map((l) => l.name).join(', ') || 'aucun agent'}) ; défaut : ${defaultName}`) };
  const where = ` (paramètre library ; défaut : ${defaultName})`;

  return createSdkMcpServer({
    name: 'context',
    version: '1.0.0',
    instructions: `Bibliothèques de contexte du projet "${project.name}" : instructions durables (conventions, décisions, procédures, connaissances) rangées en dossiers. Les chemins sont de la forme "dossier/sous-dossier/nom". Celle du projet (library "projet") est commune ; chaque agent du projet a la sienne (library "<nom de l'agent>"), lisible et modifiable par toutes les sessions${defaultAgentId ? ` ; par défaut, les outils agissent sur ta propre bibliothèque (${defaultName})` : ''}. Consulte-les avant d'agir et enregistre ce qui mérite d'être retenu pour les prochaines sessions.`,
    tools: [
      tool('libraries', "Les bibliothèques accessibles : celle du projet et celles des agents (nom et identifiant), avec celle visée par défaut.", {}, async () =>
        run(async () => [`- projet (bibliothèque commune du projet)${defaultAgentId ? '' : ' · par défaut'}`, ...libraries.map((l) => `- ${l.name} (agent, identifiant ${l.id})${l.id === defaultAgentId ? ' · par défaut (la tienne)' : ''}`)].join('\n')),
      ),
      tool('tree', `Liste l'arborescence complète d'une bibliothèque de contexte${where} (dossiers et instructions avec leur description).`, { ...libraryParam }, async ({ library }) =>
        run(async () => renderTree(await contextService.tree(project.id, libraryId(library)))),
      ),
      tool('read', `Lit le contenu d'une instruction du contexte${where}.`, { path: z.string().describe('Chemin de l\'instruction, ex. "api/auth/regles-jwt"'), ...libraryParam }, async ({ path, library }) =>
        run(async () => {
          const agentId = libraryId(library);
          const r = await contextService.resolve(project.id, path, agentId);
          if (!r || r.kind === 'root') throw new Error(`Introuvable : ${path}`);
          if (r.kind === 'folder') return `📁 ${r.folder.path}/ est un dossier :\n${renderTree(await contextService.tree(project.id, agentId))}`;
          const i = r.instruction;
          return `# ${i.name} (${i.path}, version ${i.version})\n${i.description ? `${i.description}\n` : ''}\n${i.content}`;
        }),
      ),
      tool('search', `Recherche des instructions par mot-clé (nom, description ou contenu)${where}.`, { query: z.string(), ...libraryParam }, async ({ query, library }) =>
        run(async () => {
          const found = await contextService.search(project.id, query, libraryId(library));
          return found.length ? found.map((i) => `📄 ${i.path}${i.description ? ` — ${i.description}` : ''} (v${i.version})`).join('\n') : 'Aucun résultat.';
        }),
      ),
      tool(
        'write',
        `Crée ou met à jour une instruction (contenu Markdown)${where}. Les dossiers manquants du chemin sont créés. Chaque mise à jour crée une nouvelle version.`,
        {
          path: z.string().describe('Chemin de l\'instruction, ex. "conventions/tests"'),
          content: z.string().describe('Contenu complet de l\'instruction (remplace l\'existant)'),
          description: z.string().optional().describe('Résumé en une phrase (affiché dans les listes et comme description de skill)'),
          change_note: z.string().optional().describe('Note de version : ce qui change et pourquoi'),
          ...libraryParam,
        },
        async ({ path, content, description, change_note, library }) =>
          run(async () => {
            const { instruction, created } = await contextService.writeInstructionAtPath(project.id, path, { content, description, changeNote: change_note }, actor, libraryId(library));
            return `${created ? 'Créée' : 'Mise à jour'} : ${instruction.path} (version ${instruction.version})`;
          }),
      ),
      tool('create_folder', `Crée un dossier (et ses parents manquants)${where}.`, { path: z.string(), ...libraryParam }, async ({ path, library }) =>
        run(async () => {
          const folder = await contextService.ensureFolderPath(project.id, path, actor, libraryId(library));
          return folder ? `Dossier prêt : ${folder.path}/` : 'Racine';
        }),
      ),
      tool(
        'move',
        `Déplace ou renomme un dossier ou une instruction${where} (dans la même bibliothèque).`,
        { path: z.string().describe('Chemin actuel'), new_path: z.string().describe('Nouveau chemin complet (le dernier segment devient le nouveau nom)'), ...libraryParam },
        async ({ path, new_path, library }) =>
          run(async () => {
            const agentId = libraryId(library);
            const r = await contextService.resolve(project.id, path, agentId);
            if (!r || r.kind === 'root') throw new Error(`Introuvable : ${path}`);
            const segments = new_path.split('/').map((s) => s.trim()).filter(Boolean);
            if (segments.length === 0) throw new Error('Nouveau chemin vide');
            const newName = segments[segments.length - 1];
            const parent = await contextService.ensureFolderPath(project.id, segments.slice(0, -1).join('/'), actor, agentId);
            if (r.kind === 'folder') {
              if ((parent?.id ?? null) !== r.folder.parentId) await contextService.moveFolder(r.folder.id, parent?.id ?? null, actor);
              const folder = await contextService.renameFolder(r.folder.id, newName, actor);
              return `Dossier déplacé : ${folder.path}/`;
            }
            const instruction = await contextService.updateInstruction(r.instruction.id, { name: newName, folderId: parent?.id ?? null }, actor);
            return `Instruction déplacée : ${instruction.path}`;
          }),
      ),
      tool('delete', `Supprime une instruction ou un dossier (avec son contenu)${where}.`, { path: z.string(), ...libraryParam }, async ({ path, library }) =>
        run(async () => {
          const r = await contextService.resolve(project.id, path, libraryId(library));
          if (!r || r.kind === 'root') throw new Error(`Introuvable : ${path}`);
          if (r.kind === 'folder') {
            await contextService.deleteFolder(r.folder.id, actor);
            return `Dossier supprimé : ${r.folder.path}/`;
          }
          await contextService.deleteInstruction(r.instruction.id, actor);
          return `Instruction supprimée : ${r.instruction.path}`;
        }),
      ),
      tool('history', `Liste les versions d'une instruction (numéro, auteur, note, date)${where}.`, { path: z.string(), ...libraryParam }, async ({ path, library }) =>
        run(async () => {
          const r = await contextService.resolve(project.id, path, libraryId(library));
          if (!r || r.kind !== 'instruction') throw new Error(`Instruction introuvable : ${path}`);
          const versions = await contextService.versions(r.instruction.id);
          return versions.map((v) => `v${v.version} · ${v.createdAt.toISOString()} · ${v.authorType}${v.changeNote ? ` · ${v.changeNote}` : ''}`).join('\n');
        }),
      ),
    ],
  });
}
