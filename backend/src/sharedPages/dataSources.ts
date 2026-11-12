import { AppError } from '../errors.js';
import { checkGraphqlQuery, checkGraphqlVariables, type GraphqlSourceConfig } from '../cockpit/graphqlSource.js';

/**
 * Sources de données d'un artefact « Données » (fonctions pures, testées dans dataSources.test.ts).
 *
 * - `sql` : une requête en lecture seule sur un élément PostgreSQL du coffre (portée du propriétaire dans le projet de
 *   l'artefact, relue à chaque rafraîchissement). Résultat : `{ columns, rows }`, les nombres que PostgreSQL rend en
 *   texte (bigint, numeric) reconvertis en nombres, les dates en ISO.
 * - `script` : un script (node, python, sh) lancé dans l'environnement Docker du projet ; sa sortie standard doit être
 *   du JSON (n'importe quelle forme). Il ne voit aucun identifiant du coffre.
 * - `graphql` : une requête de lecture sur l'API de Skipper, **vivante** : exécutée à la lecture de la page avec les
 *   droits de la personne qui regarde (cockpit/liveSources.ts), jamais rafraîchie ni gardée en base.
 * - `agent` : une consigne confiée à une session (au nom du propriétaire de l'artefact, ou d'un agent du projet) à
 *   chaque rafraîchissement ; la session calcule le résultat comme elle l'entend (documents, code du dépôt, coffre…)
 *   et l'écrit avec l'outil `pages.set_data`. Pour les chiffres qu'aucune requête ne sait produire.
 */

export type DataSourceKind = 'sql' | 'script' | 'graphql' | 'agent';
export type { GraphqlSourceConfig };
export type ScriptInterpreter = 'node' | 'python' | 'sh';
export const SCRIPT_INTERPRETERS: readonly ScriptInterpreter[] = ['node', 'python', 'sh'];

export interface SqlSourceConfig {
  item: string;
  database: string | null;
  query: string;
}
export interface ScriptSourceConfig {
  interpreter: ScriptInterpreter;
  code: string;
  timeoutSeconds: number;
}

export interface AgentSourceConfig {
  /** Consigne donnée à la session à chaque rafraîchissement. */
  prompt: string;
  /** Agent du projet (nom ou identifiant) qui calcule la source ; null : une session au nom du propriétaire de l'artefact. */
  agent: string | null;
}

/** `running` : une session calcule la source (type agent) ; `inactive` : jamais en base ; source d'une ancienne version dont la définition a changé depuis (plus rafraîchie, sans données). */
export type DataSourceStatus = 'pending' | 'ok' | 'error' | 'skipped' | 'running' | 'inactive';

export interface DataSource {
  id: string;
  pageId: string;
  name: string;
  kind: DataSourceKind;
  config: SourceConfig;
  position: number;
  data: unknown;
  rowCount: number | null;
  status: DataSourceStatus;
  error: string | null;
  durationMs: number | null;
  refreshedAt: Date | null;
  attemptedAt: Date | null;
  /** agent : dernière session lancée pour calculer la source. */
  sessionId?: string | null;
}

export type SourceConfig = SqlSourceConfig | ScriptSourceConfig | GraphqlSourceConfig | AgentSourceConfig;

/** Définition d'une source telle que la donne un agent (outil pages.publish) ou l'API. */
export interface DataSourceInput {
  name: string;
  type: string;
  item?: string | null;
  database?: string | null;
  query?: string | null;
  interpreter?: string | null;
  code?: string | null;
  timeout_seconds?: number | null;
  /** graphql : variables de la requête (valeurs modèles {{project.id}}, {{viewer.id}}, {{params.x}}, {{now-7d}} admises). */
  variables?: Record<string, unknown> | null;
  /** agent : consigne de la session qui calcule la source. */
  prompt?: string | null;
  /** agent : agent du projet (nom ou identifiant) ; absent : une session au nom du propriétaire. */
  agent?: string | null;
}

export const DATA_LIMITS = {
  sources: 12,
  /** Lignes gardées par requête SQL. */
  sqlRows: 5000,
  /** Taille du JSON d'une source. */
  sourceBytes: 2 * 1024 * 1024,
  queryChars: 20_000,
  codeChars: 100_000,
  scriptTimeoutSeconds: 120,
  defaultScriptTimeoutSeconds: 60,
  /** Intervalles proposés (minutes) ; tout entier entre min et max est accepté. */
  minRefreshMinutes: 5,
  /** Source agent : une session par rafraîchissement, pas plus d'une par heure. */
  minAgentRefreshMinutes: 60,
  promptChars: 20_000,
  maxRefreshMinutes: 10080,
  /** Sans lecture ni modification depuis ce nombre de jours, le rafraîchissement automatique se met en veille. */
  idleDays: 14,
} as const;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Valide et normalise une liste de sources ; lève une AppError lisible (l'agent la lit telle quelle). */
export function parseSources(inputs: DataSourceInput[]): { name: string; kind: DataSourceKind; config: SourceConfig }[] {
  if (inputs.length > DATA_LIMITS.sources) throw new AppError(`${DATA_LIMITS.sources} sources au plus par artefact`);
  const seen = new Set<string>();
  return inputs.map((s, i) => {
    const name = (s.name ?? '').trim();
    const where = `Source ${i + 1}${name ? ` (« ${name} »)` : ''}`;
    if (!NAME.test(name)) throw new AppError(`${where} : le nom doit commencer par une lettre minuscule, puis lettres minuscules, chiffres ou _ (40 caractères au plus) ; c'est la clé de Skipper.data dans la page`);
    if (seen.has(name)) throw new AppError(`${where} : nom en double`);
    seen.add(name);
    if (s.type === 'sql') {
      const item = (s.item ?? '').trim();
      const query = (s.query ?? '').trim().replace(/;\s*$/, '');
      if (!item) throw new AppError(`${where} : item (nom de l'élément PostgreSQL du coffre) est obligatoire`);
      if (!query) throw new AppError(`${where} : query (la requête SQL) est obligatoire`);
      if (query.length > DATA_LIMITS.queryChars) throw new AppError(`${where} : requête trop longue (${DATA_LIMITS.queryChars} caractères au plus)`);
      return { name, kind: 'sql' as const, config: { item: item.toLowerCase(), database: s.database?.trim() || null, query } };
    }
    if (s.type === 'script') {
      const interpreter = (s.interpreter ?? 'node') as ScriptInterpreter;
      if (!SCRIPT_INTERPRETERS.includes(interpreter)) throw new AppError(`${where} : interpreter doit être ${SCRIPT_INTERPRETERS.join(', ')}`);
      const code = s.code ?? '';
      if (!code.trim()) throw new AppError(`${where} : code (le script) est obligatoire`);
      if (code.length > DATA_LIMITS.codeChars) throw new AppError(`${where} : script trop long (${DATA_LIMITS.codeChars} caractères au plus)`);
      const t = s.timeout_seconds ?? DATA_LIMITS.defaultScriptTimeoutSeconds;
      if (!Number.isInteger(t) || t < 1 || t > DATA_LIMITS.scriptTimeoutSeconds) throw new AppError(`${where} : timeout_seconds entre 1 et ${DATA_LIMITS.scriptTimeoutSeconds}`);
      return { name, kind: 'script' as const, config: { interpreter, code, timeoutSeconds: t } };
    }
    if (s.type === 'graphql') {
      try {
        checkGraphqlQuery(s.query ?? '');
        return { name, kind: 'graphql' as const, config: { query: (s.query ?? '').trim(), variables: checkGraphqlVariables(s.variables) } };
      } catch (err) {
        throw new AppError(`${where} : ${(err as Error).message}`);
      }
    }
    if (s.type === 'agent') {
      const prompt = (s.prompt ?? '').trim();
      if (!prompt) throw new AppError(`${where} : prompt (la consigne de la session qui calcule la source) est obligatoire`);
      if (prompt.length > DATA_LIMITS.promptChars) throw new AppError(`${where} : consigne trop longue (${DATA_LIMITS.promptChars} caractères au plus)`);
      return { name, kind: 'agent' as const, config: { prompt, agent: s.agent?.trim() || null } };
    }
    throw new AppError(`${where} : type doit être « sql », « script », « graphql » ou « agent »`);
  });
}

/**
 * Intervalle de rafraîchissement : null (à la demande) ou un entier de minutes borné. `withAgent` : l'artefact a une
 * source agent (une session par rafraîchissement), d'où un minimum d'une heure.
 */
export function parseRefreshMinutes(v: number | null | undefined, withAgent = false): number | null {
  if (v == null || v === 0) return null;
  if (!Number.isInteger(v) || v < DATA_LIMITS.minRefreshMinutes || v > DATA_LIMITS.maxRefreshMinutes) {
    throw new AppError(`Intervalle de rafraîchissement : entre ${DATA_LIMITS.minRefreshMinutes} minutes et 7 jours (${DATA_LIMITS.maxRefreshMinutes} minutes), ou 0 pour « à la demande »`);
  }
  if (withAgent && v < DATA_LIMITS.minAgentRefreshMinutes) {
    throw new AppError(`Un artefact avec une source agent lance une session à chaque rafraîchissement : ${DATA_LIMITS.minAgentRefreshMinutes} minutes au moins`);
  }
  return v;
}

const NUMERIC_TEXT = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

/** Valeur d'une cellule rendue lisible en JSON : dates en ISO, Buffer en texte court, bigint en nombre. */
function cell(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) return `<${v.length} octets>`;
  return v;
}

/**
 * Résultat SQL prêt pour la page : `{ columns, rows }`. Une colonne dont toutes les valeurs non nulles sont des
 * nombres écrits en texte (count, sum, numeric : PostgreSQL les rend en chaînes) est convertie en nombres ; un zéro en
 * tête (code postal, identifiant) garde la colonne en texte.
 */
export function normalizeSqlResult(fields: string[], rawRows: Record<string, unknown>[]): { columns: string[]; rows: Record<string, unknown>[] } {
  const rows = rawRows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const f of fields) o[f] = cell(r[f]);
    return o;
  });
  for (const f of fields) {
    let any = false;
    let numeric = true;
    for (const r of rows) {
      const v = r[f];
      if (v == null) continue;
      if (typeof v === 'number') {
        any = true;
        continue;
      }
      if (typeof v !== 'string' || !NUMERIC_TEXT.test(v)) {
        numeric = false;
        break;
      }
      any = true;
    }
    if (any && numeric) for (const r of rows) if (typeof r[f] === 'string') r[f] = Number(r[f]);
  }
  return { columns: fields, rows };
}

/** Lit la sortie d'un script : du JSON, éventuellement précédé de lignes de journal (on prend le dernier document JSON). */
export function parseScriptOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new AppError('Le script n’a rien écrit sur la sortie standard : il doit y écrire du JSON (JSON.stringify en node, json.dumps en python)');
  try {
    return JSON.parse(text);
  } catch {
    // Journal suivi du JSON : le dernier bloc qui commence par { ou [ en début de ligne.
    const idx = Math.max(text.lastIndexOf('\n{'), text.lastIndexOf('\n['));
    if (idx >= 0) {
      try {
        return JSON.parse(text.slice(idx + 1));
      } catch {
        /* ci-dessous */
      }
    }
    throw new AppError(`La sortie du script n’est pas du JSON valide : « ${text.slice(0, 200)}${text.length > 200 ? '…' : ''} »`);
  }
}

/** Nombre d'éléments d'un résultat (lignes SQL, longueur d'un tableau, sinon null). */
export function countRows(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object' && Array.isArray((data as { rows?: unknown }).rows)) return (data as { rows: unknown[] }).rows.length;
  return null;
}

/** Garde la taille d'une source sous la limite (le JSON est gardé en base et envoyé à chaque lecteur). */
export function assertDataSize(data: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
  if (bytes > DATA_LIMITS.sourceBytes) throw new AppError(`Résultat trop volumineux (${(bytes / 1024 / 1024).toFixed(1)} Mo, ${DATA_LIMITS.sourceBytes / 1024 / 1024} Mo au plus) : agrège côté source (GROUP BY, LIMIT)`);
}

/** Fichier et commande d'un script selon l'interpréteur. */
export function scriptCommand(interpreter: ScriptInterpreter): { file: string; command: string[] } {
  if (interpreter === 'python') return { file: 'source.py', command: ['python3', 'source.py'] };
  if (interpreter === 'sh') return { file: 'source.sh', command: ['sh', 'source.sh'] };
  return { file: 'source.mjs', command: ['node', 'source.mjs'] };
}

/** Résumé d'une source pour un agent ou le journal (une ligne). */
export function describeSource(s: Pick<DataSource, 'name' | 'kind' | 'config' | 'status' | 'error' | 'rowCount' | 'refreshedAt' | 'sessionId'>): string {
  const agent = s.kind === 'agent' ? (s.config as AgentSourceConfig).agent : null;
  const what =
    s.kind === 'sql'
      ? `SQL sur « ${(s.config as SqlSourceConfig).item} »${(s.config as SqlSourceConfig).database ? ` [${(s.config as SqlSourceConfig).database}]` : ''}`
      : s.kind === 'graphql'
        ? 'GraphQL (vivante, aux droits de la personne qui regarde)'
        : s.kind === 'agent'
          ? `agent (session ${agent ? `de ${agent}` : 'du propriétaire'}, données écrites par pages.set_data)`
          : `script ${(s.config as ScriptSourceConfig).interpreter}`;
  if (s.kind === 'graphql') return `${s.name} · ${what}`;
  const state =
    s.status === 'ok'
      ? `ok${s.rowCount != null ? `, ${s.rowCount} ligne(s)` : ''}`
      : s.status === 'error'
        ? `erreur : ${s.error}`
        : s.status === 'skipped'
          ? `non rafraîchie : ${s.error}`
          : s.status === 'running'
            ? `en cours de calcul${s.sessionId ? ` (session ${s.sessionId})` : ''}`
            : s.kind === 'agent'
              ? 'jamais écrite (pages.set_data)'
              : 'jamais rafraîchie';
  return `${s.name} · ${what} · ${state}${s.refreshedAt ? ` · données du ${s.refreshedAt.toISOString()}` : ''}`;
}
