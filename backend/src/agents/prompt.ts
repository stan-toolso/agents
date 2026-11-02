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
export function agentIdentityPrompt(agent: Agent, project: Pick<Project, 'name'>, requestedBy: Pick<User, 'name' | 'email'> | null, opts: GitAccess = {}): string {
  const role = AGENT_KIND_LABELS[agent.kind];
  const lines = [
    `Tu es **${agent.name}**, ${role} du projet ${project.name}${agent.description ? ` : ${agent.description}` : ''}. Tu es un membre du projet à part entière : tes sessions, tes messages dans les fils de tâches, tes commits et tes pull requests sont à ton nom (les outils signent pour toi). Les personnes du projet peuvent te convoquer en te mentionnant (« @${agent.name} ») dans le fil d'une tâche, ou en te confiant une tâche ; tu reçois alors leur message dans cette session ou dans une nouvelle.`,
    requestedBy ? `- Cette session a été demandée par ${requestedBy.name} (${requestedBy.email}) : c'est à cette personne que tu réponds d'abord.` : '',
    `- Ta fiche : ${agentLink(agent)}`,
    readOnlyLine(opts),
    agent.instructions.trim() ? `\nInstructions de ${agent.name} :\n\n${agent.instructions.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Accès git des comptes d'une session (`OwnerAccounts`) utiles au prompt. */
type GitAccess = { githubReadOnly?: boolean; githubPullRequests?: boolean; gitlabReadOnly?: boolean; gitlabPullRequests?: boolean };

/**
 * Phrases sur les comptes git prêtés en lecture seule (GitHub, GitLab ou les deux) : sans pull requests (rien ne sort de
 * la session), ou avec (seul `tasks.pr_open` pousse la branche et ouvre la PR).
 */
function readOnlyLine(opts: GitAccess): string {
  const strict = [opts.githubReadOnly && !opts.githubPullRequests ? 'GitHub' : null, opts.gitlabReadOnly && !opts.gitlabPullRequests ? 'GitLab' : null].filter(Boolean);
  const withPrs = [opts.githubReadOnly && opts.githubPullRequests ? 'GitHub' : null, opts.gitlabReadOnly && opts.gitlabPullRequests ? 'GitLab' : null].filter(Boolean);
  const which = (hosts: unknown[]) => (hosts.length === 2 ? 'Tes comptes GitHub et GitLab sont prêtés' : `Ton compte ${hosts[0]} est prêté`);
  return [
    strict.length
      ? `- ${which(strict)} en lecture seule : sur ${strict.join(' et ')}, tu peux lire et récupérer les dépôts, mais ni pousser une branche ni ouvrir de pull request (ou merge request). Laisse tes commits en local et demande dans le fil de la tâche à une personne de pousser, ou signale-le.`
      : '',
    withPrs.length
      ? `- ${which(withPrs)} en lecture seule, pull requests permises : sur ${withPrs.join(' et ')}, \`git push\` est refusé, mais tu peux ouvrir une pull request (ou merge request) avec l'outil \`tasks.pr_open\`, qui pousse ta branche de travail (jamais la branche de base) puis ouvre la PR. Commite d'abord ; pour des commits ajoutés après l'ouverture, demande dans le fil de la tâche à une personne de pousser.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
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

/**
 * Paragraphe du prompt système d'un chat ou d'une session d'espace personnel : les agents de tous les projets de la
 * personne, avec leur rôle et leur projet. Interpeller un agent (« @Nom », « demande à Nom ») vaut décision de le
 * convoquer : le chat lui transmet la demande et rapporte sa réponse plutôt que de chercher un projet de ce nom.
 */
export function scopedAgentsPromptSummary(agents: Agent[], projects: Pick<Project, 'id' | 'name'>[]): string {
  const active = agents.filter((a) => a.enabled && !a.archivedAt);
  if (!active.length) return '';
  const nameOf = (a: Agent) => projects.find((p) => p.id === a.projectId)?.name ?? a.projectId;
  const lines = active.map((a) => `- ${a.name} : ${AGENT_KIND_LABELS[a.kind]} du projet ${nameOf(a)}${a.description ? ` (${a.description})` : ''}, identifiant ${a.id}`);
  return [
    'Les projets de la personne ont des agents, membres de leur projet au même titre que les personnes :',
    ...lines,
    "Quand la personne s'adresse à l'un d'eux (« @Nom », « demande à Nom… ») ou que sa demande relève clairement du rôle d'un agent, convoque-le avec `agents.summon` : un message complet et autonome (il ne voit pas cette conversation), la tâche concernée s'il y en a une ; puis attends sa réponse avec `sessions.wait` sur la session renvoyée et rapporte-la (avec le lien de sa session). Un nom d'agent n'est pas un nom de projet : l'agent travaille dans son projet. Si plusieurs agents portent ce nom, précise le projet (paramètre `project`).",
  ].join('\n');
}
