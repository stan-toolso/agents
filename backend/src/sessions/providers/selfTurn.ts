/**
 * Tours que l'agent reprend de lui-même, sans instruction d'une personne : le CLI Claude Code relance l'agent quand une
 * tâche de fond se termine (commande Bash lancée en arrière-plan pour « se réveiller » à une heure donnée, sous-agent,
 * surveillance). Constaté le 13/11/2026 (session toolso ea2d295e) : l'agent s'était programmé un contrôle à 16 h 12,
 * il l'a fait et a rendu compte, mais rien ne l'a signalé à la personne, et le tour, sans instruction en tête, se
 * confondait avec le précédent dans le transcript. D'où un repère dans le transcript au début du tour et une
 * notification `session.self_turn` à sa fin (sessions/service.ts).
 */

const MAX_TRIGGER = 160;

/** Ce qui a réveillé l'agent, d'après la notification de tâche du SDK (`system/task_notification`). */
export function wakeTrigger(message: { summary?: unknown; description?: unknown }): string {
  const raw = typeof message.summary === 'string' && message.summary.trim() ? message.summary : typeof message.description === 'string' ? message.description : '';
  let text = raw.replace(/\s+/g, ' ').trim();
  // « Background command "until …; echo …" completed (exit code 0) » (CLI 2.1.3xx) : en français, la commande citée.
  const bash = /^Background command "(.*)" (completed|failed|was stopped)(?: \(exit code (-?\d+)\))?$/.exec(text);
  if (bash) {
    const verb = bash[2] === 'completed' ? 'terminée' : bash[2] === 'failed' ? 'en échec' : 'arrêtée';
    const cmd = bash[1].length > 100 ? `${bash[1].slice(0, 99)}…` : bash[1];
    text = `commande de fond ${verb} (« ${cmd} »)`;
  }
  return text.length > MAX_TRIGGER ? `${text.slice(0, MAX_TRIGGER - 1)}…` : text;
}

/** Texte du repère affiché au début du tour. */
export function selfTurnNotice(trigger: string): string {
  return `L'agent reprend de lui-même${trigger ? ` : ${trigger}` : ', à la fin d’une tâche de fond'}`;
}

/** Texte d'un message de l'agent (blocs `text`), null s'il n'en a pas. */
export function assistantText(message: { message?: unknown }): string | null {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: unknown })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}

/** Extrait du dernier message de l'agent pour la notification : première ligne utile, sans Markdown lourd. */
export function selfTurnExcerpt(text: string | null, max = 200): string | null {
  if (!text) return null;
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s|]+/, '').replace(/\*\*/g, '').trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
