import type { AgentRef } from '../graphql/agents';
import './agents.css';

/** Couleur stable dérivée du nom (quand l'agent n'en a pas choisi une). */
export function agentColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return `hsl(${h} 55% 45%)`;
}

/** Avatar d'un agent : son emoji, sinon l'initiale de son nom, sur sa couleur. */
export default function AgentAvatar({ agent, size = 24, className = '', title }: { agent: Pick<AgentRef, 'name' | 'avatar'>; size?: number; className?: string; title?: string }) {
  const emoji = agent.avatar?.emoji?.trim();
  return (
    <span
      className={`agent-avatar${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, fontSize: emoji ? Math.round(size * 0.58) : Math.round(size * 0.5), background: agent.avatar?.color?.trim() || agentColor(agent.name) }}
      title={title ?? `${agent.name} (agent)`}
      aria-label={title ?? `${agent.name} (agent)`}
    >
      {emoji || agent.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** Avatar et nom, en ligne. */
export function AgentChip({ agent, size = 18, className = '' }: { agent: Pick<AgentRef, 'name' | 'avatar'>; size?: number; className?: string }) {
  return (
    <span className={`agent-chip${className ? ` ${className}` : ''}`}>
      <AgentAvatar agent={agent} size={size} />
      <span className="agent-chip-name">{agent.name}</span>
    </span>
  );
}
