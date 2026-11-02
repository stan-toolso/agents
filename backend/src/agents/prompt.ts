import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import type { User } from '../users/types.js';
import { AGENT_KIND_LABELS, type Agent } from './types.js';

/** Lien vers la fiche d'un agent dans l'application. */
export const agentLink = (agent: Pick<Agent, 'id' | 'projectId'>) => `${config.appUrl}/projects/${agent.projectId}/agents/${agent.id}`;

/**
 * Section du prompt système d'une session jouée par un agent : qui il est, ses instructions, sa mémoire (dossier du
 * contexte), et qui l'a convoqué. Placée juste après le prompt du projet, avant l'identité de la session.
 */
export function agentIdentityPrompt(agent: Agent, project: Pick<Project, 'name'>, requestedBy: Pick<User, 'name' | 'email'> | null): string {
  const role = AGENT_KIND_LABELS[agent.kind];
  const lines = [
    `Tu es **${agent.name}**, ${role} du projet ${project.name}${agent.description ? ` : ${agent.description}` : ''}. Tu es un membre du projet à part entière : tes sessions, tes messages dans les fils de tâches, tes commits et tes pull requests sont à ton nom (les outils signent pour toi). Les personnes du projet peuvent te convoquer en te mentionnant (« @${agent.name} ») dans le fil d'une tâche, ou en te confiant une tâche ; tu reçois alors leur message dans cette session ou dans une nouvelle.`,
    requestedBy ? `- Cette session a été demandée par ${requestedBy.name} (${requestedBy.email}) : c'est à cette personne que tu réponds d'abord.` : '',
    `- Ta fiche : ${agentLink(agent)}`,
    agent.contextFolder
      ? `- Ta mémoire durable est le dossier \`${agent.contextFolder}\` de la bibliothèque de contexte : lis-le en début de travail et ranges-y ce qui doit durer (décisions, conventions, glossaire). Le reste de la bibliothèque est à lire aussi, mais n'y écris que des instructions valables pour tout le projet.`
      : '',
    agent.instructions.trim() ? `\nInstructions de ${agent.name} :\n\n${agent.instructions.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Paragraphe du prompt système de toute session d'un projet qui a des agents : qui ils sont et comment les
 * convoquer (mention dans un fil, outil `agents.summon`). `me` : l'agent qui joue la session, exclu de la liste.
 */
export function agentsPromptSummary(agents: Agent[], me: Agent | null): string {
  const others = agents.filter((a) => a.enabled && !a.archivedAt && a.id !== me?.id);
  if (!others.length) return '';
  const lines = others.map((a) => `- ${a.name} (${AGENT_KIND_LABELS[a.kind]}${a.description ? ` : ${a.description}` : ''}, identifiant ${a.id})`);
  return [
    `Le projet a des agents, membres du projet au même titre que les personnes${me ? ' (en plus de toi)' : ''} :`,
    ...lines,
    "Pour passer la main à l'un d'eux : mentionne-le dans le fil de la tâche (« @Nom » dans `tasks.comment`), ou convoque-le avec l'outil `agents.summon` (identifiant ou nom, instruction, tâche éventuelle) : il reçoit le message dans sa session reliée à la tâche, ou dans une nouvelle. Convoquer un agent lance ou relance une session (soumis à autorisation). Ne le fais que quand une personne l'a décidé ou que tes instructions le prévoient.",
  ].join('\n');
}
