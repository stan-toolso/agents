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
import { sharedPageService } from './service.js';
import type { SharedPage, SharedPageComment } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export const pageUrl = (id: string) => `${config.appUrl}/shared/${id}`;

/** Paragraphe du prompt système décrivant les pages partagées aux agents. */
export function sharedPagesPrompt(): string {
  return "Pour remettre un rapport, un tableau de bord ou toute page consultable, écris un fichier HTML autonome dans le dossier de travail (styles et scripts en ligne ; scripts externes seulement depuis un CDN) et publie-le avec l'outil `pages.publish` : il renvoie un lien `/shared/<id>`, privé pour la personne qui pilote la session jusqu'à ce qu'elle l'ouvre à d'autres (`anyone_with_link`, ou le bouton Partager). Pour mettre une page à jour, publie à nouveau avec `page_id`. `pages.list` liste les pages existantes. Donne le lien dans ta réponse. Les lecteurs d'une page y laissent des commentaires, généraux ou ancrés sur un élément de la page (sélecteur CSS et extrait du texte) : `pages.comments` les lit (les non traités d'abord), `pages.reply` répond dans le fil d'un commentaire, `pages.resolve` le marque traité une fois pris en compte (par exemple après avoir publié une nouvelle version).";
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
        'Publie un fichier HTML du dossier de travail comme page partagée (nouvelle page, ou nouvelle version avec page_id). Renvoie le lien.',
        {
          path: z.string().describe('Chemin du fichier .html, relatif au dossier de travail'),
          title: z.string().describe('Titre de la page'),
          description: z.string().optional(),
          page_id: z.string().optional().describe("Identifiant d'une page existante pour en publier une nouvelle version"),
          anyone_with_link: z.boolean().optional().describe("Ouvrir la page à quiconque est connecté et a le lien (sinon privée jusqu'au partage)"),
        },
        async ({ path: p, title, description, page_id, anyone_with_link }) =>
          run(async () => {
            if (!/\.html?$/i.test(p)) throw new AppError('Seul un fichier HTML (.html) peut être publié');
            const resolved = path.resolve(ctx.cwd, p);
            if (resolved !== ctx.cwd && !resolved.startsWith(ctx.cwd + path.sep)) throw new AppError(`Le chemin doit rester dans le dossier de travail (${ctx.cwd})`);
            const html = await readFile(resolved).catch(() => {
              throw new AppError(`Fichier introuvable : ${p}`);
            });
            const page = await sharedPageService.publish({ ownerId: owner(), title, description, html, pageId: page_id ?? null, linkAccess: anyone_with_link ?? null, projectId: ctx.project.id, sessionId: ctx.session.id, sourcePath: p });
            const access = await describeAccess(page);
            return [
              page.version > 1 ? `Version ${page.version} publiée : ${pageUrl(page.id)}` : `Page publiée : ${pageUrl(page.id)}`,
              `${page.id} · ${page.title} · accès : ${access}`,
              page.linkAccess ? '' : "La personne qui pilote la session peut l'ouvrir à d'autres avec le bouton Partager de la page.",
            ]
              .filter(Boolean)
              .join('\n');
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
