import type { ScopeKind, WidgetDef, WidgetParam } from './types.js';

/**
 * Catalogue des blocs natifs du cockpit : la description de chaque bloc (clé, portées, régions, paramètres), commune
 * au serveur (validation des agencements, outil `cockpit.get`) et à l'interface (catalogue du mode « Personnaliser »,
 * formulaire des paramètres). Le rendu de chaque bloc vit côté frontend (`frontend/src/cockpit/registry.tsx`) :
 * toute nouvelle clé ici demande son composant là-bas, et inversement.
 */

const limit = (def: number, max = 20): WidgetParam => ({ key: 'limit', label: 'Nombre de lignes', type: 'int', min: 1, max, default: def });
const tags: WidgetParam = { key: 'tags', label: 'Étiquettes', type: 'tags', description: 'Ne garder que les tâches portant une de ces étiquettes' };
const weeks = (def: number): WidgetParam => ({ key: 'weeks', label: 'Semaines', type: 'int', min: 2, max: 26, default: def });

const ALL: ScopeKind[] = ['home', 'project', 'tasks', 'agent', 'page'];
const PROJECT: ScopeKind[] = ['project', 'tasks', 'page'];
const HOME_PROJECT: ScopeKind[] = ['home', 'project', 'page'];

export const WIDGETS: WidgetDef[] = [
  // ---- Tuiles --------------------------------------------------------------------------------------------------------
  { key: 'tile.requests', label: 'Demandes en attente', description: 'Demandes des agents qui attendent une réponse.', scopes: ALL, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.agents', label: 'Agents au travail', description: 'Sessions au travail et en attente, sessions terminées depuis 24 h.', scopes: ALL, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.tasks', label: 'Tâches ouvertes', description: 'Tâches à faire et en cours, retards, terminées sur 7 jours.', scopes: ALL, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.usage', label: 'Consommation du mois', description: 'Coût du mois, plafond et limites Claude (visible en crédits ou pour un super administrateur).', scopes: ALL, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.pull_requests', label: 'Pull requests', description: 'Pull requests à fusionner et branches en préparation.', scopes: PROJECT, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  // ---- Listes --------------------------------------------------------------------------------------------------------
  { key: 'list.todo', label: 'À traiter', description: 'Demandes en attente, sessions en erreur ou interrompues, tâches à l’agent arrêté, tâches à valider, pull requests à fusionner.', scopes: HOME_PROJECT, region: 'main', regions: ['main', 'side', 'full'], singleton: true, params: [] },
  { key: 'list.running_sessions', label: 'Agents au travail', description: 'Sessions dont l’agent travaille en ce moment.', scopes: HOME_PROJECT, region: 'main', regions: ['main', 'side', 'full'], params: [limit(10, 30)] },
  { key: 'list.team', label: 'L’équipe en ce moment', description: 'Chaque membre (personne ou agent), ses sessions et les tâches qu’elles ont en charge.', scopes: PROJECT, region: 'main', regions: ['main', 'side', 'full'], singleton: true, params: [{ key: 'onlyAgents', label: 'Agents seulement', type: 'bool', default: false }] },
  { key: 'list.attention_tasks', label: 'Tâches à surveiller', description: 'Tâches urgentes, hautes ou en retard.', scopes: HOME_PROJECT, region: 'main', regions: ['main', 'side', 'full'], params: [tags, limit(10, 30)] },
  { key: 'list.pull_requests', label: 'Pull requests à traiter', description: 'Pull requests à fusionner et brouillons.', scopes: HOME_PROJECT, region: 'main', regions: ['main', 'side', 'full'], params: [limit(10, 30)] },
  { key: 'list.upcoming', label: 'Prochainement', description: 'Prochaines planifications et échéances des tâches.', scopes: PROJECT, region: 'side', regions: ['main', 'side', 'full'], params: [limit(6, 20)] },
  { key: 'list.activity', label: 'Activité récente', description: 'Sessions terminées, pull requests fusionnées, tâches terminées.', scopes: HOME_PROJECT, region: 'side', regions: ['main', 'side', 'full'], params: [limit(8, 30)] },
  { key: 'usage.top_sessions', label: 'Sessions les plus coûteuses du mois', description: 'Les sessions qui ont le plus consommé ce mois-ci (visible en crédits ou pour un super administrateur).', scopes: HOME_PROJECT, region: 'side', regions: ['main', 'side', 'full'], params: [limit(5, 20)] },
  // ---- Tâches --------------------------------------------------------------------------------------------------------
  { key: 'tasks.stages', label: 'Flux des tâches', description: 'Tâches ouvertes par étiquette d’état (à cadrer → prête → en dev → à valider → à livrer), terminées sur 7 jours, délai médian, prévision.', scopes: PROJECT, region: 'side', regions: ['main', 'side', 'full'], params: [tags] },
  { key: 'tasks.weekly', label: 'Débit hebdomadaire', description: 'Tâches créées et terminées par semaine.', scopes: PROJECT, region: 'side', regions: ['main', 'side', 'full'], params: [weeks(8), tags] },
  // ---- Accueil -------------------------------------------------------------------------------------------------------
  { key: 'usage.card', label: 'Consommation', description: 'Consommation par jour sur 30 jours, limites de l’abonnement Claude, sessions les plus coûteuses.', scopes: ['home', 'project', 'page'], region: 'side', regions: ['main', 'side', 'full'], singleton: true, params: [] },
  { key: 'projects.table', label: 'Projets', description: 'Une ligne par projet : agents, demandes, tâches, consommation du mois, dernière activité.', scopes: ['home'], region: 'full', regions: ['main', 'side', 'full'], singleton: true, params: [] },
  // ---- Projet --------------------------------------------------------------------------------------------------------
  { key: 'channel', label: 'Canal #général', description: 'Le canal général du projet, pour parler à l’équipe sans quitter le tableau de bord.', scopes: ['project', 'page'], region: 'main', regions: ['main', 'side', 'full'], singleton: true, params: [limit(6, 20)] },
  // ---- Libre ---------------------------------------------------------------------------------------------------------
  { key: 'text', label: 'Texte', description: 'Un texte libre en Markdown : consigne, liens utiles, légende.', scopes: ALL, region: 'main', regions: ['main', 'side', 'full'], params: [{ key: 'markdown', label: 'Texte (Markdown)', type: 'markdown', default: '' }] },
];

const byKey = new Map(WIDGETS.map((w) => [w.key, w]));

export function widgetDef(key: string): WidgetDef | null {
  return byKey.get(key) ?? null;
}

/** Les blocs natifs qui ont un sens dans une portée. */
export function catalogFor(kind: ScopeKind): WidgetDef[] {
  return WIDGETS.filter((w) => w.scopes.includes(kind));
}
