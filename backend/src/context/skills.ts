import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import { contextRepository } from './repository.js';

/**
 * Dossier du plugin Claude Code généré pour une bibliothèque (hors workspace, pour ne pas polluer le dépôt) : celle du
 * projet (`.context-plugins/<slug>`), ou la bibliothèque propre d'un agent (`.context-plugins/<slug>/agents/<id>`).
 */
export function contextPluginDir(project: Pick<Project, 'slug'>, agentId: string | null = null): string {
  const base = path.join(config.workspacesRoot, '.context-plugins', project.slug);
  return agentId ? path.join(base, 'agents', agentId) : base;
}

/**
 * Matérialise une bibliothèque de contexte sous forme de plugin Claude Code : une skill par instruction
 * (`skills/<chemin-avec-tirets>/SKILL.md`). Le plugin est passé aux sessions Claude via l'option `plugins` du SDK ;
 * les skills apparaissent comme `context:<nom>` (bibliothèque du projet) ou `memoire:<nom>` (bibliothèque propre de
 * l'agent qui joue la session).
 */
export async function materializeSkills(project: Project, agentId: string | null = null): Promise<string> {
  const dir = contextPluginDir(project, agentId);
  const skillsDir = path.join(dir, 'skills');
  await rm(skillsDir, { recursive: true, force: true });
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: agentId ? 'memoire' : 'context', version: '1.0.0', description: agentId ? `Bibliothèque de contexte propre de l'agent (projet ${project.name})` : `Bibliothèque de contexte du projet ${project.name}` }, null, 2),
  );

  const [folders, instructions] = await Promise.all([contextRepository.listFolders(project.id, agentId), contextRepository.listInstructions(project.id, agentId)]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (id: string | null): string[] => {
    const f = id ? byId.get(id) : undefined;
    return f ? [...folderPath(f.parentId), f.slug] : [];
  };

  for (const instruction of instructions) {
    const parts = [...folderPath(instruction.folderId), instruction.slug];
    const skillName = parts.join('--').slice(0, 64).replace(/-+$/, '');
    const skillDir = path.join(skillsDir, skillName);
    await mkdir(skillDir, { recursive: true });
    const description = (instruction.description || instruction.content.split('\n').find((l) => l.trim()) || instruction.name).slice(0, 200);
    const frontmatter = [
      '---',
      `name: ${skillName}`,
      `description: ${JSON.stringify(`${description} (${agentId ? 'mémoire' : 'contexte'} ${parts.join('/')}, v${instruction.version})`)}`,
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(skillDir, 'SKILL.md'), `${frontmatter}${instruction.content}\n`);
  }
  return dir;
}
