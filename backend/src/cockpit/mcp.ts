import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { auditService } from '../audit/service.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { userRepository } from '../users/repository.js';
import { getExecutableSchema } from './schemaRegistry.js';
import { GRAPHQL_LIMITS, checkGraphqlQuery, checkGraphqlVariables, resolveVariables } from './graphqlSource.js';
import { runGraphql } from './liveSources.js';
import { describeSchema } from './schemaDoc.js';
import { describeBlock, describeCatalog, diffLayouts } from './layout.js';
import { cockpitService } from './service.js';
import { pageScopeKey, projectScopeKey, tasksScopeKey } from './scope.js';
import { PROJECT_TAB_KEYS, projectPageService } from './projectPages.js';
import type { Layout, ResolvedLayout } from './types.js';
import { REGION_LABELS, REGIONS } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Outils libres du serveur `cockpit` : lecture seule. Modifier un agencement passe par l'autorisation de la personne. */
export const COCKPIT_FREE_TOOLS = ['mcp__cockpit__get', 'mcp__cockpit__history', 'mcp__cockpit__query', 'mcp__cockpit__schema', 'mcp__cockpit__pages_list'];

/** Paragraphe du prompt système qui présente le cockpit composable aux agents. */
export function cockpitPromptSummary(): string {
  return [
    "Cockpit configurable (serveur MCP `cockpit`) : le tableau de bord du projet (`project`), la vue pilotage des tâches (`tasks`), la fiche d'un agent (`agent:<id>`) et l'accueil de la personne qui pilote (`home`) sont des agencements de blocs par région (tuiles, colonne principale, colonne latérale, pleine largeur). `cockpit.get` (portée `project` ou `home`) montre l'agencement actuel et le catalogue des blocs natifs disponibles avec leurs paramètres ; `cockpit.update` le modifie par opérations (`ops` : add, remove, move, set) ou par un agencement complet (`layout`), en créant une version ; `cockpit.reset` revient au défaut ; `cockpit.history` et `cockpit.restore` consultent et restaurent les versions ; `cockpit.query` exécute une requête GraphQL de lecture avec les droits de la personne qui pilote (pour mettre au point une source `graphql` d'artefact : les données de Skipper, tâches, sessions, PR, livraisons, consommation, vues par la personne qui regarde) et `cockpit.schema` montre les champs disponibles. Préfère un bloc natif paramétré (étiquettes, nombre de semaines…) quand il répond au besoin. Sinon, construis un **bloc artefact** : une page HTML (`pages.publish`, le plus souvent un artefact de données) conçue pour un cadre — pas d'en-tête, largeur fluide, hauteur au contenu, couleurs par `var(--cc-fg)`, `var(--cc-dim)`, `var(--cc-accent)`, `var(--cc-border)`, `var(--cc-bg-elevated)` (variables du thème injectées par Skipper, clair comme sombre), un seul sujet — puis épingle-la avec `cockpit.update` (`{ op: 'add', block: { kind: 'artifact', artifact: <id>, region: 'side' | 'main' | 'full', title, params } }`). Dans le cadre, la page reçoit `Skipper.context` (`viewer`, `project`, `scope`, `params` du bloc, `theme`) en plus de `Skipper.data`, et peut appeler `Skipper.navigate('/tasks/<id>')`, `Skipper.openSession({ prompt })` ou `Skipper.summon({ agent, text })` : l'interface exécute l'action après confirmation de la personne. Un artefact épinglé dans le tableau de bord du projet doit être ouvert aux membres du projet (`updateSharedPage { projectAccess: true }` par son propriétaire, ou le bouton Partager) : l'outil avertit sinon. Modifier le tableau de bord du projet change ce que voit toute l'équipe : fais-le sur demande ou avec accord, dis ce que tu as changé, et pas en silence.",
  ].join('\n');
}

export interface CockpitMcpContext {
  project: Project;
  sessionId: string;
  /** Personne (ou agent) au nom de qui les agencements sont lus et modifiés : le propriétaire de la session. */
  userId: string;
}

function describe(r: ResolvedLayout): string {
  const lines = [`Portée ${r.scope.key} · ${r.isDefault ? 'agencement par défaut' : `version ${r.version}`}${r.canEdit ? '' : ' · lecture seule pour vous'}`];
  for (const region of REGIONS) {
    const blocks = r.layout.blocks.filter((b) => b.region === region);
    if (!blocks.length) continue;
    lines.push(`${REGION_LABELS[region]} (${region}) :`, ...blocks.map((b) => `  - ${b.id} · ${describeBlock(b)}`));
  }
  if (!r.layout.blocks.length) lines.push('(aucun bloc)');
  return lines.join('\n');
}

function describeChange(before: Layout, after: Layout): string {
  const d = diffLayouts(before, after);
  const parts = [
    ...d.added.map((b) => `+ ${describeBlock(b)}`),
    ...d.removed.map((b) => `− ${describeBlock(b)}`),
    ...d.changed.map((b) => `~ ${describeBlock(b)}`),
  ];
  return parts.length ? parts.join('\n') : 'Aucun changement.';
}

/** Serveur MCP in-process `cockpit` : agencements des tableaux de bord, au nom du propriétaire de la session. */
export function createCockpitMcpServer(ctx: CockpitMcpContext): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const user = async () => {
    const u = await userRepository.findById(ctx.userId);
    if (!u) throw new AppError('Propriétaire de la session introuvable');
    return u;
  };
  /** `project` = le projet de la session ; `home` = l'accueil de la personne ; une clé complète est acceptée. */
  const key = (scope: string | undefined) => {
    const s = (scope ?? 'project').trim().toLowerCase();
    if (s === 'project' || s === 'projet') return projectScopeKey(ctx.project.id);
    if (s === 'tasks' || s === 'taches' || s === 'tâches' || s === 'pilotage') return tasksScopeKey(ctx.project.id);
    if (s.startsWith('page:')) return pageScopeKey(ctx.project.id, s.slice('page:'.length));
    return s;
  };
  const scopeParam = z.string().optional().describe("Portée : « project » (tableau de bord du projet de la session, défaut), « tasks » (vue pilotage des tâches du projet), « home » (accueil du propriétaire de la session), « home:default » (accueil par défaut de toute la cellule, administrateurs), « agent:<id> » (onglet Activité de la fiche d'un agent), « page:<slug> » (page personnalisée du projet), ou une clé complète (project:<id>)");
  const audit = (action: string, r: ResolvedLayout, details: Record<string, unknown>) =>
    r.scope.projectId ? auditService.record({ projectId: r.scope.projectId, actor: { sessionId: ctx.sessionId }, action, targetType: 'cockpit', targetId: r.scope.key, targetLabel: r.scope.key, details: { version: r.version, ...details } }) : Promise.resolve();

  return createSdkMcpServer({
    name: 'cockpit',
    version: '1.0.0',
    instructions: "Agencements des tableaux de bord de Skipper (blocs natifs par région). get : l'agencement et le catalogue ; update : opérations ou agencement complet (nouvelle version) ; reset, history, restore.",
    tools: [
      tool('get', "L'agencement actuel d'une portée (blocs par région, avec leurs identifiants et paramètres) et le catalogue des blocs natifs qu'on peut y placer.", { scope: scopeParam }, async ({ scope }) =>
        run(async () => {
          const r = await cockpitService.resolve(await user(), key(scope));
          return [describe(r), '', `Blocs natifs disponibles (kind builtin, clé widget) :`, describeCatalog(r.scope.kind), '', "Un bloc artefact : { kind: \"artifact\", artifact: <id de l'artefact>, region: main|side|full, title?, params?, height?, pollSeconds? }."].join('\n');
        }),
      ),
      tool(
        'update',
        "Modifie l'agencement d'une portée : soit des opérations (ops) appliquées à l'agencement actuel, soit un agencement complet (layout). Crée une version ; renvoie le nouvel agencement et ce qui a changé.",
        {
          scope: scopeParam,
          ops: z
            .array(
              z.object({
                op: z.enum(['add', 'remove', 'move', 'set']),
                id: z.string().optional().describe('remove, move, set : identifiant du bloc'),
                block: z
                  .object({
                    kind: z.enum(['builtin', 'artifact']),
                    widget: z.string().optional().describe('builtin : clé du catalogue'),
                    artifact: z.string().optional().describe("artifact : identifiant de l'artefact"),
                    region: z.enum(['tiles', 'main', 'side', 'full']).optional(),
                    title: z.string().optional(),
                    params: z.object({}).catchall(z.any()).optional(),
                    height: z.number().optional().describe('artifact : hauteur fixe en pixels (sinon au contenu)'),
                    pollSeconds: z.number().optional().describe('artifact : rechargement périodique (15 s au moins)'),
                  })
                  .optional()
                  .describe('add : le bloc à ajouter'),
                region: z.enum(['tiles', 'main', 'side', 'full']).optional().describe('move : nouvelle région'),
                index: z.number().int().min(0).optional().describe('add, move : position dans la région (0 = en tête ; absent : à la fin)'),
                title: z.string().optional().describe('set : nouveau titre (vide : titre par défaut)'),
                params: z.object({}).catchall(z.any()).optional().describe('set : paramètres à modifier (fusionnés avec les actuels)'),
              }),
            )
            .optional()
            .describe("Opérations appliquées dans l'ordre"),
          layout: z.object({ v: z.number().int().optional(), blocks: z.array(z.object({}).catchall(z.any())) }).optional().describe('Agencement complet, à la place de ops'),
          note: z.string().optional().describe('Note de version : ce qui change et pourquoi'),
        },
        async ({ scope, ops, layout, note }) =>
          run(async () => {
            const { result, before } = await cockpitService.update(await user(), key(scope), { ops, layout, note, sessionId: ctx.sessionId });
            await audit('cockpit.update', result, { note: note ?? null, ops: ops?.length ?? null });
            return [`Version ${result.version} enregistrée.`, describeChange(before, result.layout), ...(result.warnings?.length ? ['', 'Attention :', ...result.warnings.map((w) => `- ${w}`)] : []), '', describe(result)].join('\n');
          }),
      ),
      tool('reset', "Remet l'agencement par défaut d'une portée (l'historique est conservé).", { scope: scopeParam }, async ({ scope }) =>
        run(async () => {
          const r = await cockpitService.reset(await user(), key(scope), ctx.sessionId);
          await audit('cockpit.reset', r, {});
          return `Agencement par défaut rétabli.\n${describe(r)}`;
        }),
      ),
      tool('history', "Les versions d'un agencement, la plus récente d'abord.", { scope: scopeParam }, async ({ scope }) =>
        run(async () => {
          const u = await user();
          const versions = await cockpitService.history(u, key(scope));
          if (!versions.length) return 'Aucune version enregistrée : agencement par défaut.';
          const authors = new Map((await userRepository.findByIds([...new Set(versions.map((v) => v.authorId).filter((x): x is string => Boolean(x)))])).map((a) => [a.id, a.name]));
          return versions.map((v) => `- v${v.version} · ${v.createdAt.toISOString()} · ${v.authorId ? authors.get(v.authorId) ?? 'inconnu' : 'Skipper'}${v.sessionId ? ' (session d’agent)' : ''}${v.reset ? ' · réinitialisation' : ''}${v.note ? ` · ${v.note}` : ''} · ${v.layout.blocks.length} bloc(s)`).join('\n');
        }),
      ),
      tool(
        'pages_list',
        "Les pages personnalisées du projet (onglets de plus dans l'en-tête, chacune un agencement de portée page:<slug>) et le réglage des onglets natifs (masqués, ordre).",
        {},
        async () =>
          run(async () => {
            const pages = await projectPageService.list(ctx.project.id);
            const tabs = await projectPageService.tabs(ctx.project.id);
            return [pages.length ? pages.map((p) => `- page:${p.slug} · ${p.title}${p.icon ? ` · ${p.icon}` : ''} · position ${p.position} · /projects/${ctx.project.id}/p/${p.slug}`).join('\n') : 'Aucune page personnalisée.', `Onglets masqués : ${tabs.hidden.join(', ') || 'aucun'} ; ordre : ${tabs.order.join(', ') || 'par défaut'}.`, `Onglets natifs : ${PROJECT_TAB_KEYS.join(', ')}.`].join('\n');
          }),
      ),
      tool(
        'page_create',
        "Crée une page personnalisée du projet (un onglet de plus) ; compose-la ensuite avec cockpit.update sur la portée page:<slug>.",
        { title: z.string().describe('Titre de la page (onglet)'), icon: z.string().optional().describe('Icône Bootstrap, ex. bi-graph-up'), slug: z.string().optional().describe('Identifiant dans l’URL ; dérivé du titre sinon') },
        async ({ title, icon, slug }) =>
          run(async () => {
            const page = await projectPageService.create(ctx.project.id, { title, icon, slug }, ctx.userId);
            await auditService.record({ projectId: ctx.project.id, actor: { sessionId: ctx.sessionId }, action: 'project_page.create', targetType: 'project_page', targetId: page.id, targetLabel: page.title, details: { slug: page.slug } });
            return `Page créée : page:${page.slug} · ${page.title} · /projects/${ctx.project.id}/p/${page.slug}. Compose-la avec cockpit.update { scope: "page:${page.slug}", ops: [...] }.`;
          }),
      ),
      tool(
        'page_update',
        "Renomme une page personnalisée, change son icône ou sa position.",
        { slug: z.string().describe('Identifiant de la page'), title: z.string().optional(), icon: z.string().optional(), position: z.number().int().min(0).optional() },
        async ({ slug, title, icon, position }) =>
          run(async () => {
            const page = await projectPageService.update(await projectPageService.bySlug(ctx.project.id, slug), { title, icon, position });
            await auditService.record({ projectId: ctx.project.id, actor: { sessionId: ctx.sessionId }, action: 'project_page.update', targetType: 'project_page', targetId: page.id, targetLabel: page.title, details: { title, icon, position } });
            return `Page mise à jour : page:${page.slug} · ${page.title}${page.icon ? ` · ${page.icon}` : ''} · position ${page.position}.`;
          }),
      ),
      tool(
        'page_delete',
        "Supprime une page personnalisée et son agencement.",
        { slug: z.string().describe('Identifiant de la page') },
        async ({ slug }) =>
          run(async () => {
            const page = await projectPageService.bySlug(ctx.project.id, slug);
            await projectPageService.delete(page);
            await auditService.record({ projectId: ctx.project.id, actor: { sessionId: ctx.sessionId }, action: 'project_page.delete', targetType: 'project_page', targetId: page.id, targetLabel: page.title, details: { slug } });
            return `Page « ${page.title} » supprimée.`;
          }),
      ),
      tool(
        'tabs',
        "Règle les onglets du projet : onglets natifs masqués (jamais overview ni settings) et ordre des onglets (clés natives et page:<slug>).",
        { hidden: z.array(z.string()).optional().describe('Onglets natifs masqués'), order: z.array(z.string()).optional().describe('Ordre des onglets ; les absents suivent') },
        async ({ hidden, order }) =>
          run(async () => {
            const current = await projectPageService.tabs(ctx.project.id);
            const tabs = await projectPageService.setTabs(ctx.project.id, { hidden: hidden ?? current.hidden, order: order ?? current.order });
            await auditService.record({ projectId: ctx.project.id, actor: { sessionId: ctx.sessionId }, action: 'project.tabs', targetType: 'project', targetId: ctx.project.id, targetLabel: ctx.project.name, details: tabs as unknown as Record<string, unknown> });
            return `Onglets masqués : ${tabs.hidden.join(', ') || 'aucun'} ; ordre : ${tabs.order.join(', ') || 'par défaut'}.`;
          }),
      ),
      tool(
        'query',
        "Exécute une requête GraphQL de lecture sur l'API de Skipper avec les droits de la personne qui pilote la session : pour mettre au point une source `graphql` d'un artefact (même bornes : une opération query, pas d'introspection, 8 niveaux, 80 champs). Les variables acceptent les valeurs modèles ({{project.id}}, {{viewer.id}}, {{now-7d}}…).",
        {
          query: z.string().describe('La requête (opération query)'),
          variables: z.object({}).catchall(z.any()).optional().describe('Variables, valeurs modèles admises'),
          limit: z.number().int().min(1).max(200).optional().describe('Éléments montrés par liste (défaut 20)'),
        },
        async ({ query, variables, limit }) =>
          run(async () => {
            const u = await user();
            const vars = resolveVariables(checkGraphqlVariables(variables), { project: { id: ctx.project.id, name: ctx.project.name }, viewer: { id: u.id, name: u.name }, params: {} });
            const r = await runGraphql(checkGraphqlQuery(query), vars, u);
            const n = limit ?? 20;
            const trim = (v: unknown): unknown => (Array.isArray(v) ? [...v.slice(0, n).map(trim), ...(v.length > n ? [`… ${v.length - n} de plus`] : [])] : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trim(x)])) : v);
            const body = JSON.stringify(trim(r.data), null, 1);
            return [`${r.status === 'ok' ? 'OK' : 'Erreur'} en ${r.durationMs} ms${r.error ? ` · ${r.error}` : ''}`, `variables résolues : ${JSON.stringify(vars)}`, body.length > 12_000 ? `${body.slice(0, 12_000)}\n… (tronqué)` : body].join('\n');
          }),
      ),
      tool(
        'schema',
        "Le schéma GraphQL de Skipper pour écrire une source : sans argument, les champs de lecture de la racine (Query) avec leurs arguments ; avec `type`, la définition d'un type (ex. Task, Session, ProjectDashboard).",
        { type: z.string().optional().describe('Nom d’un type à détailler ; absent : les champs de Query') },
        async ({ type }) => run(async () => describeSchema(getExecutableSchema(), type ?? null, GRAPHQL_LIMITS)),
      ),
      tool('restore', "Restaure une version de l'historique (nouvelle version en tête).", { scope: scopeParam, version: z.number().int().min(1).describe('Numéro de la version à restaurer') }, async ({ scope, version }) =>
        run(async () => {
          const r = await cockpitService.restore(await user(), key(scope), version, ctx.sessionId);
          await audit('cockpit.restore', r, { restored: version });
          return `Version ${version} restaurée (version ${r.version}).\n${describe(r)}`;
        }),
      ),
    ],
  });
}
