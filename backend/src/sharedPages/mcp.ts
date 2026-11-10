import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import type { Session } from '../sessions/types.js';
import { userService } from '../users/service.js';
import { sharedPageCommentService } from './commentService.js';
import { artifactDataService } from './dataService.js';
import { DATA_LIMITS, describeSource, type DataSource } from './dataSources.js';
import { sharedPageService } from './service.js';
import { ARTIFACT_KINDS, type ArtifactKind, type SharedPage, type SharedPageComment } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export const pageUrl = (id: string) => `${config.appUrl}/shared/${id}`;

/** Paragraphe du prompt système décrivant les artefacts (pages et données) aux agents. */
export function sharedPagesPrompt(): string {
  return [
    "Artefacts : pour remettre un rapport, un tableau de bord ou toute page consultable, écris un fichier HTML autonome dans le dossier de travail (styles et scripts en ligne ; scripts externes seulement depuis un CDN) et publie-le avec l'outil `pages.publish` : il renvoie un lien `/shared/<id>`, privé pour la personne qui pilote la session jusqu'à ce qu'elle l'ouvre à d'autres (`anyone_with_link`, ou le bouton Partager). Pour mettre un artefact à jour, publie à nouveau avec `page_id` ; pour partir d'un artefact existant sans le toucher, `pages.duplicate` en fait une copie privée (sources de données comprises). `pages.list` liste les artefacts existants. Donne le lien dans ta réponse. Les lecteurs y laissent des commentaires, généraux ou ancrés sur un élément de la page (sélecteur CSS et extrait du texte) : `pages.comments` les lit (les non traités d'abord), `pages.reply` répond dans le fil d'un commentaire, `pages.resolve` le marque traité une fois pris en compte (par exemple après avoir publié une nouvelle version).",
    "Artefact de données (`kind: \"data\"`) : une page dont les chiffres viennent de sources que Skipper rafraîchit tout seul, pour un tableau de bord qui reste à jour sans toi. Déclare les sources dans `pages.publish` (`sources`) : `{ name, type: \"sql\", item: <élément PostgreSQL du coffre>, query }` (lecture seule, 5000 lignes au plus : agrège avec GROUP BY et ORDER BY) ou `{ name, type: \"script\", interpreter: node|python|sh, code }` (lancé dans l'environnement du projet, sans identifiant du coffre ; sa sortie standard doit être du JSON). Mets au point la requête avec `vault.sql_query` avant de la déclarer. Dans la page, les données sont disponibles avant tout script sous `window.Skipper` : `Skipper.data.<name>` (`{ columns, rows }` pour une requête SQL — chaque ligne est un objet colonne → valeur, nombres déjà convertis, dates en ISO — ou le JSON du script), `Skipper.meta` (`refreshedAt`, `sources[]` avec `status` et `error`) et `Skipper.ready((data, meta) => …)`. N'écris jamais les chiffres en dur : la page les lit dans `Skipper.data` et se dessine (prévois le cas d'une source en erreur ou vide : `Skipper.meta.sources`). `refresh_minutes` règle le rafraîchissement automatique (60 = toutes les heures ; absent : à la demande, bouton Rafraîchir). À la publication les sources sont exécutées une première fois et leur état renvoyé ; `pages.refresh` les relance, `pages.data` montre les données d'une source (pour vérifier ce que reçoit la page). Un élément du coffre soumis à approbation n'est pas rafraîchi sans une personne : dis-le-lui, elle rafraîchit depuis l'artefact. Pour les graphiques, préfère un SVG dessiné à la main ou une bibliothèque légère depuis un CDN, des couleurs sobres, une grille discrète, des libellés lisibles, et un rendu correct sur téléphone.",
    "Diapositives (`kind: \"slides\"`) : un seul fichier HTML, une `<section class=\"slide\">` par diapositive (la première = titre), chacune conçue pour **1280 × 720** (le lecteur de Skipper la met à l'échelle, l'affiche une à la fois, gère le clavier, le balayage, la vue en grille, le mode présentation et l'export PDF : n'écris aucune navigation toi-même, pas de défilement dans une diapositive). `data-title` donne le titre d'une diapositive (sinon son premier titre) ; `<aside class=\"notes\">` dans une diapositive = notes de l'orateur, jamais affichées. Styles en ligne dans `<style>` : une palette sobre et constante, textes grands (titres ≥ 44 px, corps ≥ 24 px, jamais sous 18 px), 6 points au plus par diapositive, marges généreuses (≥ 64 px), images et graphiques en SVG en ligne ou images de données ; une idée par diapositive. Vérifie le rendu de chaque diapositive à 1280 × 720 (navigateur headless ou aperçu) avant de publier.",
  ].join('\n');
}

async function describeAccess(page: SharedPage): Promise<string> {
  if (page.linkAccess) return 'quiconque est connecté avec le lien';
  const members = await sharedPageService.members(page.id);
  return members.length ? `le propriétaire et ${members.length} personne(s) ajoutée(s)` : 'privée (le propriétaire seulement)';
}

export interface SharedPagesMcpContext {
  project: Project;
  session: Pick<Session, 'id' | 'ownerId'>;
  cwd: string;
}

/** Serveur MCP in-process `pages` : publication de pages HTML par un agent, au nom du propriétaire de la session. */
export function createSharedPagesMcpServer(ctx: SharedPagesMcpContext): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const owner = () => {
    if (!ctx.session.ownerId) throw new AppError("Cette session n'a pas de propriétaire : une page partagée en a besoin");
    return ctx.session.ownerId;
  };

  return createSdkMcpServer({
    name: 'pages',
    version: '1.0.0',
    instructions: 'Pages HTML partagées : publie un fichier HTML du dossier de travail à un lien privé, ou une nouvelle version d\'une page existante (page_id).',
    tools: [
      tool(
        'publish',
        "Publie un fichier HTML du dossier de travail comme artefact (nouvelle page, ou nouvelle version avec page_id). kind: data pour un artefact alimenté par des sources de données rafraîchies par Skipper (sources, refresh_minutes) ; kind: slides pour des diapositives. Renvoie le lien et, pour les données, l'état de chaque source après un premier rafraîchissement.",
        {
          path: z.string().describe('Chemin du fichier .html, relatif au dossier de travail'),
          title: z.string().describe("Titre de l'artefact"),
          description: z.string().optional(),
          page_id: z.string().optional().describe("Identifiant d'un artefact existant pour en publier une nouvelle version"),
          anyone_with_link: z.boolean().optional().describe("Ouvrir la page à quiconque est connecté et a le lien (sinon privée jusqu'au partage)"),
          kind: z.enum(['page', 'data', 'slides']).optional().describe("Type d'artefact : page (défaut), data (page alimentée par des sources de données, lues dans window.Skipper.data) ou slides (diapositives : une <section class=\"slide\"> de 1280×720 par diapositive)"),
          sources: z
            .array(
              z.object({
                name: z.string().describe('Clé de Skipper.data dans la page : lettre minuscule puis lettres, chiffres, _'),
                type: z.enum(['sql', 'script']),
                item: z.string().optional().describe("sql : nom de l'élément PostgreSQL du coffre"),
                database: z.string().optional().describe("sql : base, pour un élément rattaché à un serveur entier"),
                query: z.string().optional().describe('sql : la requête (une instruction, lecture seule, 5000 lignes au plus)'),
                interpreter: z.enum(['node', 'python', 'sh']).optional().describe('script : interpréteur (défaut node)'),
                code: z.string().optional().describe('script : le code ; sa sortie standard doit être du JSON'),
                timeout_seconds: z.number().int().min(1).max(DATA_LIMITS.scriptTimeoutSeconds).optional().describe('script : délai (défaut 60 s)'),
              }),
            )
            .optional()
            .describe("kind data : les sources de données (remplacent celles de la version précédente)"),
          refresh_minutes: z.number().int().min(0).max(DATA_LIMITS.maxRefreshMinutes).optional().describe("kind data : rafraîchissement automatique toutes les N minutes (5 à 10080) ; 0 ou absent : à la demande"),
        },
        async ({ path: p, title, description, page_id, anyone_with_link, kind, sources, refresh_minutes }) =>
          run(async () => {
            if (!/\.html?$/i.test(p)) throw new AppError('Seul un fichier HTML (.html) peut être publié');
            const resolved = path.resolve(ctx.cwd, p);
            if (resolved !== ctx.cwd && !resolved.startsWith(ctx.cwd + path.sep)) throw new AppError(`Le chemin doit rester dans le dossier de travail (${ctx.cwd})`);
            const html = await readFile(resolved).catch(() => {
              throw new AppError(`Fichier introuvable : ${p}`);
            });
            if ((sources || refresh_minutes) && kind !== 'data') throw new AppError('sources et refresh_minutes demandent kind: data');
            const wanted = kind && ARTIFACT_KINDS.includes(kind as ArtifactKind) ? (kind as ArtifactKind) : null;
            let page = await sharedPageService.publish({ ownerId: owner(), title, description, html, pageId: page_id ?? null, linkAccess: anyone_with_link ?? null, projectId: ctx.project.id, sessionId: ctx.session.id, sourcePath: p, kind: wanted });
            const what = page.kind === 'data' ? 'Artefact de données publié' : page.kind === 'slides' ? 'Diapositives publiées' : 'Page publiée';
            const lines = [page.version > 1 ? `Version ${page.version} publiée : ${pageUrl(page.id)}` : `${what} : ${pageUrl(page.id)}`, `${page.id} · ${page.title} · accès : ${await describeAccess(page)}`];
            if (page.kind === 'data') {
              if (sources) await artifactDataService.setSources(page, sources);
              if (refresh_minutes !== undefined) page = await artifactDataService.setRefresh(page, refresh_minutes);
              const states = await artifactDataService.refresh(page, 'auto');
              lines.push(describeRefresh(page, states));
              if (!states.length) lines.push('Aucune source déclarée : Skipper.data est vide dans la page. Passe `sources` à pages.publish.');
            }
            if (!page.linkAccess) lines.push("La personne qui pilote la session peut l'ouvrir à d'autres avec le bouton Partager de la page.");
            return lines.join('\n');
          }),
      ),
      tool(
        'refresh',
        "Rafraîchit maintenant toutes les sources d'un artefact de données et renvoie leur état.",
        { page_id: z.string().describe("Identifiant de l'artefact") },
        async ({ page_id }) =>
          run(async () => {
            const page = await sharedPageService.getOwned(owner(), page_id);
            if (page.kind !== 'data') throw new AppError("Cet artefact n'a pas de sources de données");
            const states = await artifactDataService.refresh(page, 'auto');
            return describeRefresh(page, states);
          }),
      ),
      tool(
        'data',
        "Données actuelles d'une source d'un artefact de données (ce que la page reçoit dans Skipper.data.<source>), tronquées.",
        {
          page_id: z.string().describe("Identifiant de l'artefact"),
          source: z.string().optional().describe('Nom de la source ; absent : état de toutes les sources'),
          limit: z.number().int().min(1).max(200).optional().describe('Lignes montrées (défaut 20)'),
        },
        async ({ page_id, source, limit }) =>
          run(async () => {
            const page = await sharedPageService.getOwned(owner(), page_id);
            if (page.kind !== 'data') throw new AppError("Cet artefact n'a pas de sources de données");
            const all = await artifactDataService.sourcesWithData(page.id);
            if (!source) return describeRefresh(page, all);
            const s = all.find((x) => x.name === source);
            if (!s) throw new AppError(`Source « ${source} » introuvable (${all.map((x) => x.name).join(', ') || 'aucune source'})`);
            const d = s.data as { columns?: string[]; rows?: unknown[] } | unknown[] | null;
            const n = limit ?? 20;
            let body: string;
            if (d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.rows)) body = `columns: ${JSON.stringify(d.columns)}\nrows (${d.rows.length}) :\n${d.rows.slice(0, n).map((r) => JSON.stringify(r)).join('\n')}${d.rows.length > n ? `\n… ${d.rows.length - n} de plus` : ''}`;
            else if (Array.isArray(d)) body = `${d.length} élément(s) :\n${d.slice(0, n).map((r) => JSON.stringify(r)).join('\n')}${d.length > n ? `\n… ${d.length - n} de plus` : ''}`;
            else body = JSON.stringify(d, null, 1).slice(0, 8000);
            return `${describeSource(s)}\n${body}`;
          }),
      ),
      tool(
        'duplicate',
        "Duplique un artefact (page ou données) : copie privée de sa dernière version, avec son type et ses sources de données, au nom du propriétaire de la session ; ni membres, ni commentaires, ni historique. Publie ensuite tes modifications sur la copie avec pages.publish et son page_id.",
        {
          page_id: z.string().describe("Identifiant de l'artefact à dupliquer"),
          title: z.string().optional().describe('Titre de la copie (défaut : « Copie de … »)'),
        },
        async ({ page_id, title }) =>
          run(async () => {
            const copy = await sharedPageService.duplicate(await userService.get(owner()), page_id, { title: title ?? null });
            return [`Copie créée : ${pageUrl(copy.id)}`, `${copy.id} · ${copy.title} · accès : privée (le propriétaire seulement)`].join('\n');
          }),
      ),
      tool('list', 'Liste les pages partagées du propriétaire de la session.', { limit: z.number().int().min(1).max(100).optional() }, async ({ limit }) =>
        run(async () => {
          const pages = await sharedPageService.listOwned(owner(), limit ?? 20);
          if (!pages.length) return 'Aucune page partagée pour le moment.';
          const lines: string[] = [];
          for (const p of pages) lines.push(`- ${p.id} · ${p.title} · v${p.version} · ${await describeAccess(p)} · ${pageUrl(p.id)}`);
          return lines.join('\n');
        }),
      ),
      tool(
        'comments',
        "Commentaires laissés sur une page partagée (fil par commentaire, ancre sur un élément de la page, état traité). Par défaut, seuls les commentaires non traités.",
        {
          page_id: z.string().describe('Identifiant de la page'),
          all: z.boolean().optional().describe('Inclure les commentaires traités'),
        },
        async ({ page_id, all }) =>
          run(async () => {
            const page = await sharedPageService.getFor(owner(), page_id);
            const roots = (await sharedPageCommentService.roots(page.id)).filter((c) => all || !c.resolvedAt);
            if (!roots.length) return all ? 'Aucun commentaire sur cette page.' : 'Aucun commentaire non traité sur cette page (all: true pour voir les traités).';
            const out: string[] = [`${roots.length} commentaire(s) sur « ${page.title} » (v${page.version}) :`];
            for (const c of roots) {
              out.push(await formatComment(c, page));
              for (const r of await sharedPageCommentService.replies(c.id)) out.push(`    ↳ ${await authorName(r)} · ${r.createdAt.toISOString()} : ${r.body.replace(/\n/g, '\n      ')}`);
            }
            return out.join('\n');
          }),
      ),
      tool('reply', "Répond dans le fil d'un commentaire d'une page partagée, au nom du propriétaire de la session.", { comment_id: z.string(), body: z.string().describe('Texte de la réponse') }, async ({ comment_id, body }) =>
        run(async () => {
          const reply = await sharedPageCommentService.reply(await actor(), comment_id, body);
          return `Réponse ${reply.id} postée sur le commentaire ${comment_id}.`;
        }),
      ),
      tool('resolve', "Marque un commentaire d'une page partagée traité (ou le rouvre avec resolved: false).", { comment_id: z.string(), resolved: z.boolean().optional().describe('Défaut : true') }, async ({ comment_id, resolved }) =>
        run(async () => {
          const c = await sharedPageCommentService.resolve(await actor(), comment_id, resolved ?? true);
          return c.resolvedAt ? `Commentaire ${c.id} marqué traité.` : `Commentaire ${c.id} rouvert.`;
        }),
      ),
    ],
  });

  async function actor() {
    return { user: await userService.get(owner()), sessionId: ctx.session.id };
  }
}

/** Compte rendu d'un rafraîchissement : une ligne par source, puis le réglage. */
function describeRefresh(page: SharedPage, states: DataSource[]): string {
  const lines = states.map((s) => `- ${describeSource(s)}`);
  lines.push(page.refreshMinutes ? `Rafraîchissement automatique toutes les ${page.refreshMinutes} minute(s) (en veille après ${DATA_LIMITS.idleDays} jours sans lecture).` : 'Rafraîchissement à la demande (bouton Rafraîchir de l’artefact, ou pages.refresh).');
  return lines.join('\n');
}

async function authorName(c: SharedPageComment): Promise<string> {
  const u = await userService.get(c.authorId).catch(() => null);
  return (u?.name ?? 'quelqu’un') + (c.sessionId ? ' (agent)' : '');
}

async function formatComment(c: SharedPageComment, page: SharedPage): Promise<string> {
  const where = c.anchor ? `sur <${c.anchor.tag ?? '?'}> \`${c.anchor.selector}\`${c.anchor.text ? ` « ${c.anchor.text} »` : ''}` : 'général';
  const state = c.resolvedAt ? 'traité' : 'à traiter';
  const version = c.version !== page.version ? ` · v${c.version}` : '';
  return `- ${c.id} · ${state} · ${where}${version} · ${await authorName(c)} · ${c.createdAt.toISOString()}\n  ${c.body.replace(/\n/g, '\n  ')}`;
}

/**
 * Politique d'autorisation d'un appel `pages.publish` : libre pour une nouvelle page privée ou une nouvelle
 * version d'une page que personne d'autre ne voit ; soumis à l'humain quand la page est exposée à d'autres.
 */
export async function sharedPagesPolicy(input: Record<string, unknown>): Promise<'allow' | 'ask'> {
  if (input.anyone_with_link === true) return 'ask';
  if (typeof input.page_id === 'string' && input.page_id) {
    const page = await sharedPageService.get(input.page_id).catch(() => null);
    if (page && (await sharedPageService.isShared(page))) return 'ask';
  }
  return 'allow';
}
