import { AppError } from '../errors.js';
import type { DataSourceKind, DataSourceStatus } from './dataSources.js';

/**
 * Alertes d'un artefact de données (fonctions pures, testées dans alerts.test.ts).
 *
 * Une règle porte sur une source : un chemin dans ses données (`rows.0.taux`, `rows.*.status`, `total`), un opérateur et
 * une valeur. Elle est évaluée à chaque rafraîchissement réussi de la source (et pour `failed`, à chaque échec) ; elle ne
 * déclenche ses actions (notification, session) qu'au **franchissement** : passage de « normale » à « déclenchée », puis
 * retour à la normale. L'anti-rebond (`for`) demande N évaluations consécutives contraires à l'état courant avant de
 * basculer, dans un sens comme dans l'autre.
 *
 * Pas d'expression JavaScript : `vm` de Node n'isole pas du serveur, et une règle déclarée par un agent ne doit rien
 * pouvoir exécuter. Chemin + opérateur + valeur couvrent les cas demandés (seuil, ligne en défaut, valeur changée).
 */

export type AlertOp = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'changed' | 'failed';
export const ALERT_OPS: readonly AlertOp[] = ['>', '>=', '<', '<=', '==', '!=', 'contains', 'not_contains', 'empty', 'not_empty', 'changed', 'failed'];
/** Opérateurs sans valeur de comparaison. */
const UNARY: readonly AlertOp[] = ['empty', 'not_empty', 'changed', 'failed'];

export type AlertMatch = 'any' | 'all';
/** Qui reçoit la notification : le propriétaire de l'artefact, tous les membres du projet, ou personne. */
export type AlertNotify = 'owner' | 'project' | 'none';
export const ALERT_NOTIFY: readonly AlertNotify[] = ['owner', 'project', 'none'];

/** `unknown` : jamais évaluée (ou définition changée) ; `ok` : normale ; `firing` : déclenchée. */
export type AlertState = 'unknown' | 'ok' | 'firing';

export interface AlertConfig {
  /** Chemin dans les données de la source ; vide = la donnée entière. `*` parcourt un tableau (ou les valeurs d'un objet). */
  path: string;
  op: AlertOp;
  /** Valeur comparée (nombre, texte, booléen ou null) ; absente pour empty, not_empty, changed, failed. */
  value: string | number | boolean | null;
  /** Plusieurs valeurs sélectionnées (chemin avec `*`) : il suffit d'une (`any`, défaut) ou il les faut toutes (`all`). */
  match: AlertMatch;
  /** Anti-rebond : évaluations consécutives nécessaires pour basculer (1 à 10). */
  for: number;
  notify: AlertNotify;
  /** Notifier aussi le retour à la normale. */
  notifyResolved: boolean;
  /** Consigne de la session lancée au déclenchement ; null : pas de session (sauf agent nommé : consigne par défaut). */
  prompt: string | null;
  /** Agent du projet (nom ou identifiant) convoqué au déclenchement ; null : session au nom du propriétaire si `prompt`. */
  agent: string | null;
  /** Message lisible repris dans la notification. */
  message: string | null;
}

/** Définition d'une règle telle que la donne un agent (outil pages.publish) ou l'API. */
export interface AlertInput {
  name: string;
  source: string;
  path?: string | null;
  op: string;
  value?: unknown;
  match?: string | null;
  for?: number | null;
  notify?: string | null;
  notify_resolved?: boolean | null;
  prompt?: string | null;
  agent?: string | null;
  message?: string | null;
}

export interface ParsedAlert {
  name: string;
  source: string;
  config: AlertConfig;
}

/** Règle gardée en base, avec son état. */
export interface DataAlert extends ParsedAlert {
  id: string;
  pageId: string;
  position: number;
  state: AlertState;
  /** Évaluations consécutives contraires à l'état courant (anti-rebond). */
  streak: number;
  /** Dernières valeurs sélectionnées (pour `changed` et l'affichage), tronquées. */
  lastValue: unknown;
  evaluatedAt: Date | null;
  triggeredAt: Date | null;
  resolvedAt: Date | null;
  fireCount: number;
  /** Dernière session lancée par l'alerte. */
  sessionId: string | null;
  sessionAt: Date | null;
  /** Dernier problème : chemin introuvable, action impossible (budget, identifiants…). */
  error: string | null;
}

export const ALERT_LIMITS = {
  alerts: 20,
  maxFor: 10,
  promptChars: 20_000,
  messageChars: 300,
  pathChars: 200,
  /** Valeurs gardées et montrées (lignes en défaut). */
  shownValues: 5,
  /** Une session par alerte et par heure au plus, quoi qu'il arrive. */
  sessionCooldownMinutes: 60,
} as const;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SEGMENT = /^(\*|[A-Za-z0-9_$\- ]{1,80})$/;

/** Valide et normalise les règles d'un artefact ; `sources` : les sources déclarées (nom → type). */
export function parseAlerts(inputs: AlertInput[], sources: { name: string; kind: DataSourceKind }[]): ParsedAlert[] {
  if (inputs.length > ALERT_LIMITS.alerts) throw new AppError(`${ALERT_LIMITS.alerts} alertes au plus par artefact`);
  const seen = new Set<string>();
  return inputs.map((a, i) => {
    const name = (a.name ?? '').trim();
    const where = `Alerte ${i + 1}${name ? ` (« ${name} »)` : ''}`;
    if (!NAME.test(name)) throw new AppError(`${where} : le nom doit commencer par une lettre minuscule, puis lettres minuscules, chiffres ou _ (40 caractères au plus)`);
    if (seen.has(name)) throw new AppError(`${where} : nom en double`);
    seen.add(name);
    const sourceName = (a.source ?? '').trim();
    const source = sources.find((s) => s.name === sourceName);
    if (!source) throw new AppError(`${where} : source « ${sourceName} » inconnue (${sources.map((s) => s.name).join(', ') || 'aucune source'})`);
    if (source.kind === 'graphql') throw new AppError(`${where} : une source graphql est vivante (lue aux droits de chaque lecteur, jamais rafraîchie en base) : pas d'alerte possible`);
    const op = a.op as AlertOp;
    if (!ALERT_OPS.includes(op)) throw new AppError(`${where} : op doit être l'un de ${ALERT_OPS.join(', ')}`);
    const path = (a.path ?? '').trim();
    if (path.length > ALERT_LIMITS.pathChars) throw new AppError(`${where} : chemin trop long`);
    if (path && !path.split('.').every((s) => SEGMENT.test(s))) throw new AppError(`${where} : chemin invalide « ${path} » (segments séparés par des points : clés, indices, ou * pour parcourir un tableau ; ex. rows.0.taux, rows.*.status)`);
    let value: AlertConfig['value'] = null;
    if (!UNARY.includes(op)) {
      if (a.value === undefined) throw new AppError(`${where} : value est obligatoire avec l'opérateur ${op}`);
      if (a.value !== null && !['string', 'number', 'boolean'].includes(typeof a.value)) throw new AppError(`${where} : value doit être un nombre, un texte, un booléen ou null`);
      value = a.value as AlertConfig['value'];
      if (['>', '>=', '<', '<='].includes(op) && toNumber(value) === null) throw new AppError(`${where} : l'opérateur ${op} compare des nombres ; value doit en être un`);
    }
    const match = (a.match ?? 'any') as AlertMatch;
    if (match !== 'any' && match !== 'all') throw new AppError(`${where} : match doit être any ou all`);
    const n = a.for ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > ALERT_LIMITS.maxFor) throw new AppError(`${where} : for (évaluations consécutives avant de basculer) entre 1 et ${ALERT_LIMITS.maxFor}`);
    const notify = (a.notify ?? 'owner') as AlertNotify;
    if (!ALERT_NOTIFY.includes(notify)) throw new AppError(`${where} : notify doit être owner, project ou none`);
    const prompt = a.prompt?.trim() || null;
    if (prompt && prompt.length > ALERT_LIMITS.promptChars) throw new AppError(`${where} : consigne trop longue (${ALERT_LIMITS.promptChars} caractères au plus)`);
    const agent = a.agent?.trim() || null;
    if (notify === 'none' && !prompt && !agent) throw new AppError(`${where} : aucune action (notify: none, ni prompt ni agent)`);
    const message = a.message?.trim() || null;
    if (message && message.length > ALERT_LIMITS.messageChars) throw new AppError(`${where} : message trop long (${ALERT_LIMITS.messageChars} caractères au plus)`);
    return { name, source: sourceName, config: { path, op, value, match, for: n, notify, notifyResolved: a.notify_resolved ?? true, prompt, agent, message } };
  });
}

export interface Selected {
  value: unknown;
  /** Objet qui contient la valeur (la ligne d'un résultat SQL), pour le contexte de l'alerte. */
  parent: unknown;
}

/** Valeurs désignées par un chemin. Un segment absent ne sélectionne rien ; `length` donne la longueur d'un tableau. */
export function selectValues(data: unknown, path: string): Selected[] {
  let current: Selected[] = [{ value: data, parent: null }];
  if (!path) return current;
  for (const seg of path.split('.')) {
    const next: Selected[] = [];
    for (const { value } of current) {
      if (value == null || typeof value !== 'object') continue;
      if (seg === '*') {
        const items = Array.isArray(value) ? value : Object.values(value);
        for (const v of items) next.push({ value: v, parent: value });
      } else if (Array.isArray(value)) {
        if (/^\d+$/.test(seg) && Number(seg) < value.length) next.push({ value: value[Number(seg)], parent: value });
        else if (seg === 'length') next.push({ value: value.length, parent: value });
      } else if (Object.prototype.hasOwnProperty.call(value, seg)) {
        next.push({ value: (value as Record<string, unknown>)[seg], parent: value });
      }
    }
    current = next;
  }
  return current;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim())) return Number(v);
  if (typeof v === 'boolean') return null;
  return null;
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

function equals(a: unknown, b: unknown): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null && (typeof a === 'number' || typeof b === 'number')) return na === nb;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Une valeur satisfait-elle la comparaison ? */
export function compare(v: unknown, op: AlertOp, ref: AlertConfig['value']): boolean {
  switch (op) {
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const a = toNumber(v);
      const b = toNumber(ref);
      if (a === null || b === null) return false;
      return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
    }
    case '==':
      return equals(v, ref);
    case '!=':
      return !equals(v, ref);
    case 'contains':
    case 'not_contains': {
      const has = typeof v === 'string' ? ref != null && v.includes(String(ref)) : Array.isArray(v) ? v.some((x) => equals(x, ref)) : false;
      return op === 'contains' ? has : !has;
    }
    default:
      return false;
  }
}

export interface AlertEvaluation {
  /** null : pas d'évaluation (source en échec ou sautée) ; l'état ne bouge pas. */
  matched: boolean | null;
  /** Valeurs retenues pour l'affichage et le prochain `changed` (les premières, tronquées). */
  value: unknown;
  /** Lignes en défaut (objets parents des valeurs qui satisfont la règle), pour le contexte. */
  offending: unknown[];
  /** Pourquoi la règle n'a pas pu être évaluée, ou détail utile (chemin introuvable). */
  note: string | null;
}

/** Valeurs gardées : un seul élément est gardé tel quel, sinon un tableau des premiers. */
const keep = (values: unknown[]) => (values.length === 1 ? values[0] : values.slice(0, ALERT_LIMITS.shownValues));

/**
 * Évalue une règle sur l'état d'une source. `previous` : valeurs retenues à l'évaluation précédente (pour `changed`) ;
 * `undefined` quand la règle n'a jamais été évaluée (le premier passage ne compte pas comme un changement).
 */
export function evaluateAlert(config: AlertConfig, source: { status: DataSourceStatus; data: unknown; error?: string | null }, previous: unknown): AlertEvaluation {
  if (config.op === 'failed') {
    if (source.status === 'error') return { matched: true, value: source.error ?? 'erreur', offending: [], note: null };
    if (source.status === 'ok') return { matched: false, value: null, offending: [], note: null };
    return { matched: null, value: previous ?? null, offending: [], note: null };
  }
  if (source.status !== 'ok') return { matched: null, value: previous ?? null, offending: [], note: `source ${source.status === 'error' ? 'en erreur' : source.status === 'skipped' ? 'non rafraîchie' : 'sans données'} : règle non évaluée` };
  const selected = selectValues(source.data, config.path);
  const values = selected.map((s) => s.value);
  const note = !selected.length && config.path ? `chemin « ${config.path} » introuvable dans les données` : null;
  if (config.op === 'empty' || config.op === 'not_empty') {
    const empty = !values.length || values.every(isEmpty);
    return { matched: config.op === 'empty' ? empty : !empty, value: keep(values), offending: [], note: null };
  }
  if (config.op === 'changed') {
    const value = keep(values);
    const matched = previous !== undefined && JSON.stringify(previous ?? null) !== JSON.stringify(value ?? null);
    return { matched, value, offending: [], note };
  }
  const hits = selected.filter((s) => compare(s.value, config.op, config.value));
  // Aucune valeur : jamais déclenchée (ni « toutes » par vacuité).
  const matched = selected.length > 0 && (config.match === 'all' ? hits.length === selected.length : hits.length > 0);
  const offending = config.path.includes('*') ? hits.slice(0, ALERT_LIMITS.shownValues).map((h) => h.parent) : [];
  return { matched, value: keep(matched ? hits.map((h) => h.value) : values), offending, note };
}

export type AlertEvent = 'triggered' | 'resolved' | null;

/**
 * Prochain état d'une règle (anti-rebond et franchissement). `streak` compte les évaluations consécutives contraires à
 * l'état courant ; il faut en atteindre `for` pour basculer, et seule une bascule produit un événement. Première
 * évaluation (`unknown`) : normale aussitôt sans événement, déclenchée après `for` évaluations positives.
 * `changed` : chaque changement déclenche (même déjà déclenchée), et l'absence de changement remet à la normale sans
 * notification de retour.
 */
export function nextAlertState(prev: { state: AlertState; streak: number }, matched: boolean | null, config: Pick<AlertConfig, 'for' | 'op'>): { state: AlertState; streak: number; event: AlertEvent } {
  if (matched === null) return { state: prev.state, streak: prev.streak, event: null };
  if (config.op === 'changed') return matched ? { state: 'firing', streak: 0, event: 'triggered' } : { state: 'ok', streak: 0, event: null };
  if (!matched && prev.state === 'unknown') return { state: 'ok', streak: 0, event: null };
  const firing = prev.state === 'firing';
  if (matched === firing) return { state: prev.state, streak: 0, event: null };
  const streak = prev.streak + 1;
  if (streak < config.for) return { state: prev.state, streak, event: null };
  return matched ? { state: 'firing', streak: 0, event: 'triggered' } : { state: 'ok', streak: 0, event: 'resolved' };
}

const OP_TEXT: Record<AlertOp, string> = {
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  '==': '=',
  '!=': '≠',
  contains: 'contient',
  not_contains: 'ne contient pas',
  empty: 'est vide',
  not_empty: "n'est pas vide",
  changed: 'a changé',
  failed: 'en erreur',
};

/** Condition lisible : « commandes · rows.*.status = "ko" (une ligne) ». */
export function describeCondition(a: Pick<ParsedAlert, 'source' | 'config'>): string {
  const c = a.config;
  if (c.op === 'failed') return `source ${a.source} en erreur`;
  const target = `${a.source}${c.path ? `.${c.path}` : ''}`;
  const value = UNARY.includes(c.op) ? '' : ` ${JSON.stringify(c.value)}`;
  const scope = c.path.includes('*') ? (c.match === 'all' ? ' (toutes les valeurs)' : ' (au moins une valeur)') : '';
  return `${target} ${OP_TEXT[c.op]}${value}${scope}${c.for > 1 ? `, ${c.for} fois de suite` : ''}`;
}

/** Valeur courte pour un message (notification, prompt, outil). */
export const shortValue = (v: unknown, max = 200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Résumé d'une alerte pour un agent (une ligne). */
export function describeAlert(a: Pick<DataAlert, 'name' | 'source' | 'config' | 'state' | 'lastValue' | 'triggeredAt' | 'error'>): string {
  const state = a.state === 'firing' ? `DÉCLENCHÉE${a.triggeredAt ? ` depuis ${a.triggeredAt.toISOString()}` : ''}` : a.state === 'ok' ? 'normale' : 'jamais évaluée';
  const actions = [a.config.notify !== 'none' ? `notifie ${a.config.notify === 'project' ? 'le projet' : 'le propriétaire'}` : null, a.config.agent ? `convoque ${a.config.agent}` : a.config.prompt ? 'lance une session' : null].filter(Boolean).join(', ');
  return `${a.name} · si ${describeCondition(a)} · ${actions} · ${state}${a.lastValue !== undefined && a.lastValue !== null ? ` · valeur ${shortValue(a.lastValue, 120)}` : ''}${a.error ? ` · ${a.error}` : ''}`;
}

/** Texte envoyé à la session lancée par une alerte. */
export function alertInstruction(page: { id: string; title: string }, alert: Pick<DataAlert, 'name' | 'source' | 'config'>, ev: Pick<AlertEvaluation, 'value' | 'offending'>, link: string): string {
  const prompt = alert.config.prompt ?? "Analyse cette alerte (consulte les données de l'artefact avec pages.data) et agis selon ton rôle : préviens qui doit l'être, ou crée une tâche si quelque chose est à corriger.";
  return [
    `Alerte « ${alert.name} » déclenchée sur l'artefact de données « ${page.title} » (${page.id}, ${link}).`,
    `Condition : ${describeCondition(alert)}.`,
    alert.config.message ? `Message : ${alert.config.message}` : null,
    `Valeur : ${shortValue(ev.value, 1000)}`,
    ev.offending.length ? `Lignes en cause (${ev.offending.length} au plus ${ALERT_LIMITS.shownValues}) :\n${ev.offending.map((o) => `- ${shortValue(o, 600)}`).join('\n')}` : null,
    '',
    prompt,
    '',
    "Ne republie pas l'artefact pour faire taire l'alerte : elle revient à la normale d'elle-même quand les données ne satisfont plus la condition.",
  ]
    .filter((l) => l !== null)
    .join('\n');
}
