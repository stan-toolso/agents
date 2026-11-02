import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project } from '../projects/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { agentService } from './service.js';
import { AGENT_KIND_LABELS, type Agent } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Outils libres du serveur `agents` ; `summon` lance ou relance une session (budget) et passe par l'autorisation. */
export const AGENTS_FREE_TOOLS = ['mcp__agents__list'];

const line = (a: Agent, me: Agent | null) =>
  `- ${a.id} · ${a.name} · ${AGENT_KIND_LABELS[a.kind]}${a.description ? ` · ${a.description}` : ''}${a.enabled ? '' : ' · en pause'}${a.id === me?.id ? ' · toi' : ''}`;

/**
 * Serveur MCP in-process `agents` : les agents du projet et leur convocation. Convoquer un agent revient à lui
 * envoyer un message (dans sa session reliée à la tâche, ou dans une nouvelle session) : il en est le propriétaire,
 * la session de l'appelant n'en est pas la parente (ce sont des collègues, pas des sous-agents).
 */
export function createAgentsMcpServer(project: Project, sessionId: string): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const me = async () => {
    const session = await sessionRepository.findById(sessionId);
    return { session, agent: await agentService.forUser(session?.ownerId) };
  };

  return createSdkMcpServer({
    name: 'agents',
    version: '1.0.0',
    instructions: `Agents du projet "${project.name}" : membres du projet qui ne sont pas des personnes (Product Manager, Developer…). list les décrit ; summon convoque l'un d'eux avec un message (et une tâche éventuelle) : il le reçoit dans sa session reliée à la tâche ou dans une nouvelle session. Convoque un agent seulement quand une personne l'a décidé ou que tes instructions le prévoient.`,
    tools: [
      tool('list', 'Les agents du projet : identifiant, nom, rôle, description, état.', {}, async () =>
        run(async () => {
          const { agent } = await me();
          const agents = await agentService.listByProject(project.id);
          return agents.length ? agents.map((a) => line(a, agent)).join('\n') : 'Aucun agent dans ce projet.';
        }),
      ),
      tool(
        'summon',
        "Convoque un agent du projet : lui transmet le message dans sa session reliée à la tâche (relancée au besoin), sinon ouvre une session pour lui sur la tâche (ou une session libre sans tâche). Renvoie la session. Le message doit être complet : l'agent ne connaît pas ta conversation.",
        {
          agent: z.string().describe("Identifiant ou nom de l'agent"),
          text: z.string().describe('Message complet et autonome : ce qui est décidé, ce qu\'il doit faire, où trouver le contexte'),
          task_id: z.string().optional().describe('Tâche concernée : il travaille dessus et suit son fil'),
        },
        async ({ agent: ref, text: body, task_id }) =>
          run(async () => {
            const { session, agent: caller } = await me();
            const target = await agentService.resolve(project.id, ref);
            if (target.id === caller?.id) throw new Error("C'est toi : écris plutôt dans le fil de la tâche");
            const created = await agentService.summon(target.id, {
              taskId: task_id ?? null,
              text: body,
              // La personne qui a demandé la session de l'appelant reste celle qui demande ; un agent qui agit seul ne demande pour personne.
              requestedById: session?.requestedById ?? (caller ? null : (session?.ownerId ?? null)),
              actor: { type: 'human' },
            });
            return `${target.name} convoqué${task_id ? ` sur la tâche ${task_id}` : ''} : session ${created.id} (« ${created.name} »). Il répondra dans le fil de la tâche s'il y en a une ; sinon consulte la session.`;
          }),
      ),
    ],
  });
}

/** Paragraphe du prompt système : les agents sont décrits par `agentsPromptSummary` (agents/prompt.ts) ; ce serveur est son mode d'emploi. */
export const agentsMcpPrompt = () => 'Serveur MCP `agents` : `list` (les agents du projet), `summon` (convoquer un agent avec un message et une tâche éventuelle ; soumis à autorisation).';
