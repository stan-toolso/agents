/**
 * Outils pré-autorisés d'une planification, côté interface : forme d'une règle (au format Claude Code),
 * couverture approchée (pour ne proposer que ce qui manque) et libellé lisible. La validation qui fait foi
 * est celle du serveur (schedules/permissions.ts).
 */

export interface Rule {
  toolName: string;
  content: string | null;
}

const TOOL_RE = /^[A-Za-z0-9_:.*-]+$/;

/** `Bash(git log *)` → { Bash, git log * } ; null si la forme est invalide. */
export function parseRule(text: string): Rule | null {
  const s = text.trim();
  const open = s.indexOf('(');
  if (open === -1) return TOOL_RE.test(s) ? { toolName: s, content: null } : null;
  if (!s.endsWith(')')) return null;
  const toolName = s.slice(0, open).trim();
  if (!TOOL_RE.test(toolName)) return null;
  const content = s.slice(open + 1, -1).trim();
  return { toolName, content: content || null };
}

const bashPrefix = (c: string) => (c === '*' ? '' : c.endsWith(' *') ? c.slice(0, -2).trim() : c.endsWith(':*') ? c.slice(0, -2).trim() : null);

/** La règle `rule` est-elle couverte par la liste (identique, outil entier, serveur MCP entier, préfixe Bash plus court) ? */
export function ruleCovered(rules: string[], rule: string): boolean {
  const target = parseRule(rule);
  if (!target) return false;
  return rules.some((text) => {
    const r = parseRule(text);
    if (!r) return false;
    if (r.content === null) {
      if (r.toolName === target.toolName) return true;
      const server = r.toolName.replace(/__\*$/, '');
      return server.startsWith('mcp__') && server.split('__').length === 2 && target.toolName.startsWith(`${server}__`);
    }
    if (r.toolName !== target.toolName || target.content === null) return false;
    if (r.content.toLowerCase() === target.content.toLowerCase()) return true;
    if (r.toolName !== 'Bash') return false;
    const a = bashPrefix(r.content);
    const b = bashPrefix(target.content);
    return a !== null && b !== null && (a === '' || b === a || b.startsWith(`${a} `));
  });
}

/** Libellé d'une règle : « Coffre · sql_query sur production », « Commande git log … », sinon la règle telle quelle. */
export function ruleLabel(rule: string): string {
  const r = parseRule(rule);
  if (!r) return rule;
  const parts = r.toolName.split('__');
  if (parts[0] === 'mcp' && parts.length >= 2) {
    const server = parts[1] === 'vault' ? 'Coffre' : parts[1];
    const tool = parts.slice(2).join('__');
    if (!tool) return `${server} (tous ses outils)`;
    return r.content ? `${server} · ${tool} sur « ${r.content} »` : `${server} · ${tool}`;
  }
  if (r.toolName === 'Bash') return r.content ? `Commande ${r.content.replace(/\s*:?\*$/, ' …')}` : 'Toute commande';
  return r.content ? `${r.toolName} ${r.content}` : r.toolName;
}
