import type { Region, ScopeKind, WidgetDef, WidgetParam } from './types.js';

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
const PROJECT: ScopeKind[] = ['project', 'page'];
const HOME_PROJECT: ScopeKind[] = ['home', 'project', 'page'];
const TASKS: ScopeKind[] = ['tasks'];
const AGENT: ScopeKind[] = ['agent'];
const tile = (key: string, label: string, description: string, scopes: ScopeKind[]): WidgetDef => ({ key, label, description, scopes, region: 'tiles', regions: ['tiles'], singleton: true, params: [] });
const card = (key: string, label: string, description: string, scopes: ScopeKind[], region: Region, params: WidgetParam[] = []): WidgetDef => ({ key, label, description, scopes, region, regions: ['main', 'side', 'full'], singleton: true, params });

export const WIDGETS: WidgetDef[] = [
  // ---- Tuiles --------------------------------------------------------------------------------------------------------
  { key: 'tile.requests', label: 'Demandes en attente', description: 'Demandes des agents qui attendent une réponse.', scopes: HOME_PROJECT, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.agents', label: 'Agents au travail', description: 'Sessions au travail et en attente, sessions terminées depuis 24 h.', scopes: HOME_PROJECT, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.tasks', label: 'Tâches ouvertes', description: 'Tâches à faire et en cours, retards, terminées sur 7 jours.', scopes: HOME_PROJECT, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
  { key: 'tile.usage', label: 'Consommation du mois', description: 'Coût du mois, plafond et limites Claude (visible en crédits ou pour un super administrateur).', scopes: HOME_PROJECT, region: 'tiles', regions: ['tiles'], singleton: true, params: [] },
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
  // ---- Pilotage des tâches (portée project:<id>:tasks ; calculs dans frontend/src/lib/taskStats.ts) -----------------
  tile('pilot.tile.open', 'Ouvertes', 'Tâches ouvertes : à faire, en cours, urgentes ou hautes.', TASKS),
  tile('pilot.tile.in_progress', 'En cours', 'Tâches en cours : agents au travail, en attente, sans agent, bloquées.', TASKS),
  tile('pilot.tile.done_week', 'Terminées sur 7 jours', 'Tâches terminées sur 7 jours, comparées aux 7 jours précédents.', TASKS),
  tile('pilot.tile.overdue', 'En retard', 'Tâches en retard et échéances dans les 7 jours.', TASKS),
  tile('pilot.tile.throughput', 'Débit', 'Tâches terminées par semaine (moyenne, mini, maxi) sur la période.', TASKS),
  tile('pilot.tile.lead_time', 'Délai de traitement', 'Création → fin : médiane et 85e percentile des tâches terminées sur la période.', TASKS),
  tile('pilot.tile.cycle_time', 'Cycle time', 'Passage en cours → fin : médiane et 85e percentile ; tâches en cours depuis plus longtemps.', TASKS),
  tile('pilot.tile.forecast', 'Fin estimée du reste à faire', 'Simulation de Monte-Carlo sur le débit observé : dates à 50 % et 85 % de chances.', TASKS),
  tile('pilot.tile.net_flow', 'Flux net sur la période', 'Créées moins terminées moins annulées : le reste à faire grandit ou diminue.', TASKS),
  card('pilot.burnup', 'Avancement cumulé', 'Périmètre et tâches terminées jour par jour, projection au débit moyen.', TASKS, 'main'),
  card('pilot.throughput', 'Flux par semaine', 'Tâches créées et terminées chaque semaine.', TASKS, 'side'),
  card('pilot.flow', 'Flux cumulé', 'Tâches à faire, en cours et terminées à la fin de chaque jour.', TASKS, 'main'),
  card('pilot.aging', 'Vieillissement des tâches en cours', 'Âge de chaque tâche en cours, comparé au cycle time.', TASKS, 'side'),
  card('pilot.by_priority', 'Ouvertes par priorité', 'Répartition des tâches ouvertes par priorité.', TASKS, 'main'),
  card('pilot.by_assignee', 'Charge par responsable', 'Répartition des tâches ouvertes par responsable.', TASKS, 'side'),
  card('pilot.watchlist', 'À surveiller', 'Retards, blocages, urgentes sans session, en cours sans activité, échéances proches.', TASKS, 'main', [limit(10, 30)]),
  card('pilot.in_progress', 'En cours', 'Tâches en cours, avec l’état de leur session et leur âge.', TASKS, 'side', [limit(10, 30)]),
  card('pilot.next', 'Prochaines à lancer', 'Tâches à faire, par priorité puis échéance.', TASKS, 'main', [limit(8, 30)]),
  card('pilot.done', 'Terminées récemment', 'Dernières tâches terminées, avec délai et cycle.', TASKS, 'side', [limit(8, 30)]),
  // ---- Fiche d'un agent (portée agent:<id>) ---------------------------------------------------------------------------
  tile('agent.tile.active', 'Sessions en cours', 'Sessions de l’agent en cours.', AGENT),
  tile('agent.tile.sessions', 'Sessions au total', 'Toutes les sessions jouées par l’agent.', AGENT),
  tile('agent.tile.tasks', 'Tâches touchées', 'Tâches auxquelles l’agent a participé.', AGENT),
  tile('agent.tile.cost', 'Consommation', 'Coût du mois et total de l’agent.', AGENT),
  card('agent.sessions', 'Sessions', 'Les dernières sessions de l’agent, qui les a demandées, leurs tâches, leur coût.', AGENT, 'main', [limit(20, 50)]),
  card('agent.tasks', 'Tâches', 'Les dernières tâches touchées par l’agent, avec leur état.', AGENT, 'side', [limit(20, 50)]),
  // ---- Libre ---------------------------------------------------------------------------------------------------------
  { key: 'text', label: 'Texte', description: 'Un texte libre en Markdown : consigne, liens utiles, légende.', scopes: ALL, region: 'main', regions: ['main', 'side', 'full'], params: [{ key: 'markdown', label: 'Texte (Markdown)', type: 'markdown', default: '' }] },
];

const byKey = new Map(WIDGETS.map((w) => [w.key, w]));

export function widgetDef(key: string): WidgetDef | null {
  return byKey.get(key) ?? null;
}

/** Les blocs natifs qui ont un sens dans une portée. */
export function catalogFor(kind: ScopeKind): WidgetDef[] {
  // `singleton` est facultatif dans les définitions mais non nul dans le schéma GraphQL (CockpitWidget.singleton: Boolean!).
  return WIDGETS.filter((w) => w.scopes.includes(kind)).map((w) => ({ ...w, singleton: Boolean(w.singleton) }));
}
