import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { agentService } from '../agents/service.js';
import { log } from '../log.js';
import { pubSub } from '../pubsub.js';
import { claudeSettings, cliEnv } from '../settings/claude.js';
import { sessionRepository } from './repository.js';
import type { Session } from './types.js';

/**
 * Titre généré d'une session. Une session lancée par une personne (lanceur, chat) ou par un agent sans nom explicite
 * reçoit d'abord un nom provisoire (la consigne tronquée) et le drapeau `config.autoTitle` ; à la fin de son premier
 * tour, un modèle léger propose un titre de 4 à 8 mots à partir de la consigne et de la première réponse, qui remplace
 * le nom provisoire. Le drapeau tombe alors (ou au premier renommage manuel) : le titre n'est généré qu'une fois.
 *
 * Les sessions de tâches (titre de la tâche), planifiées (nom de la planification) ou nommées explicitement ne portent
 * pas le drapeau. La personne propriétaire peut couper la génération (Paramètres → Claude, `autoTitle`).
 *
 * L'appel passe par Claude Code (SDK Agent) avec les identifiants de la personne : il marche avec une clé API comme
 * avec un jeton d'abonnement, comme le test des identifiants. Son coût est inscrit dans usage_ledger.
 */
export const AUTO_TITLE_KEY = 'autoTitle';
export const TITLE_MODEL = 'claude-haiku-4-5-20251001';

const PROMPT_MAX = 4000;
const ANSWER_MAX = 4000;
const TITLE_MAX = 80;
const TIMEOUT_MS = 60_000;

/** Configuration d'une session au nom provisoire : titre généré après le premier tour. */
export const autoTitleConfig = (): Record<string, unknown> => ({ [AUTO_TITLE_KEY]: true });

export function wantsAutoTitle(session: Pick<Session, 'config' | 'archivedAt'>): boolean {
  return session.config?.[AUTO_TITLE_KEY] === true && !session.archivedAt;
}

/** Configuration sans le drapeau (titre généré, ou nom choisi par une personne). */
export function withoutAutoTitle(cfg: Record<string, unknown>): Record<string, unknown> {
  const { [AUTO_TITLE_KEY]: _dropped, ...rest } = cfg ?? {};
  return rest;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[…]` : text);

/** Consigne envoyée au modèle léger. */
export function titlePrompt(prompt: string, answer: string | null): string {
  return [
    "Propose un titre court pour cette conversation entre une personne et un agent de développement : 4 à 8 mots, dans la langue de la demande, qui dit de quoi il s'agit (le sujet, pas la forme de la question).",
    'Réponds uniquement par le titre : pas de guillemets, pas de point final, pas de préfixe, pas de Markdown.',
    '',
    '<demande>',
    clip(prompt.trim(), PROMPT_MAX),
    '</demande>',
    ...(answer?.trim() ? ['', '<premiere_reponse>', clip(answer.trim(), ANSWER_MAX), '</premiere_reponse>'] : []),
  ].join('\n');
}

/** Nettoie la réponse du modèle : première ligne non vide, sans guillemets, préfixe ni ponctuation finale. Null si inutilisable. */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  let title = line
    .replace(/^(titre|title)\s*:\s*/i, '')
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ');
  // Guillemets et ponctuation finale, dans n'importe quel ordre (« Titre ». ou "Titre.").
  for (let previous = ''; previous !== title; ) {
    previous = title;
    title = title.replace(/^["'«“‘`\s]+|["'»”’`\s]+$/g, '').replace(/[.。!]+$/, '');
  }
  title = title.trim();
  if (!title) return null;
  if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return title;
}

/** Inscrit le coût de la génération dans usage_ledger (rattaché à la session et à son propriétaire). */
async function recordCost(session: Session, costUsd: number, models: Record<string, number>): Promise<void> {
  if (!(costUsd > 0)) return;
  const byModel = Object.keys(models).length ? models : { [TITLE_MODEL]: costUsd };
  await pool.query('INSERT INTO usage_ledger (session_id, project_id, user_id, models, cost_usd) VALUES ($1, $2, $3, $4::jsonb, $5)', [
    session.id,
    session.projectId,
    session.ownerId,
    JSON.stringify(Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, Number(v.toFixed(6))]))),
    costUsd.toFixed(6),
  ]);
}

/** Interroge le modèle léger avec les identifiants Claude de la personne ; renvoie le texte et le coût. */
async function askModel(env: Record<string, string | undefined>, prompt: string): Promise<{ text: string | null; costUsd: number; models: Record<string, number> }> {
  const abortController = new AbortController();
  const q = query({
    prompt,
    options: {
      cwd: config.workspacesRoot,
      env,
      model: TITLE_MODEL,
      maxTurns: 1,
      tools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      systemPrompt: 'Tu donnes des titres courts et précis à des conversations.',
      pathToClaudeCodeExecutable: config.claudeBin,
      abortController,
    },
  });
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    for await (const message of q) {
      if (message.type !== 'result') continue;
      const models: Record<string, number> = {};
      for (const [name, usage] of Object.entries(message.modelUsage ?? {})) models[name] = usage.costUSD;
      const text = message.subtype === 'success' && !message.is_error ? message.result : null;
      return { text, costUsd: message.total_cost_usd ?? 0, models };
    }
    return { text: null, costUsd: 0, models: {} };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

type Generator = (env: Record<string, string | undefined>, prompt: string) => Promise<{ text: string | null; costUsd: number; models: Record<string, number> }>;

const inFlight = new Set<string>();

export const autoTitleService = {
  /** Remplaçable dans les tests. */
  generator: askModel as Generator,

  /**
   * Fin d'un tour : si la session attend encore son titre, le génère (une seule génération à la fois par session).
   * Ne lève jamais : un échec laisse le nom provisoire, et le drapeau tombe pour ne pas réessayer à chaque tour.
   */
  async afterTurn(sessionId: string, publish: (s: Session | null) => Promise<unknown> = async (s) => s && pubSub.publish('sessionUpdated', s)): Promise<void> {
    if (inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    try {
      const session = await sessionRepository.findById(sessionId);
      if (!session || !wantsAutoTitle(session)) return;
      const title = await this.generate(session).catch((err) => {
        log.warn(`[sessions] titre de la session ${sessionId} : génération impossible`, err);
        return null;
      });
      // Relue : un renommage manuel pendant la génération l'emporte.
      const fresh = await sessionRepository.findById(sessionId);
      if (!fresh || !wantsAutoTitle(fresh)) return;
      await publish(await sessionRepository.update(sessionId, { config: withoutAutoTitle(fresh.config), ...(title ? { name: title } : {}) }));
    } catch (err) {
      log.error(`[sessions] titre de la session ${sessionId}`, err);
    } finally {
      inFlight.delete(sessionId);
    }
  },

  /** Titre proposé pour la session (null : génération coupée par la personne, pas d'identifiants ou réponse inutilisable). */
  async generate(session: Session): Promise<string | null> {
    if (!session.ownerId || !session.prompt?.trim()) return null;
    // Mêmes identifiants que la session (compte Claude prêté à un agent, prise en main par une personne).
    const accounts = await agentService.accountsForSession(session);
    if (!accounts?.claudeUserId) return null;
    const settings = await claudeSettings.forUser(accounts.claudeUserId);
    if (settings.settings.autoTitle === false || !settings.hasCredentials()) return null;
    const event = await sessionRepository.findLastEvent(session.id, ['claude.result']);
    const answer = typeof event?.payload.result === 'string' ? event.payload.result : null;
    const credentials = await settings.credentialEnv(undefined, { sessionId: session.id, projectId: session.projectId });
    const { text, costUsd, models } = await this.generator(cliEnv(credentials), titlePrompt(session.prompt, answer));
    await recordCost(session, costUsd, models).catch((err) => log.error('[usage] coût du titre de session', err));
    return cleanTitle(text);
  },
};
