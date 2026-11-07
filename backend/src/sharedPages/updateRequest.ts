import { config } from '../config.js';
import { AppError } from '../errors.js';
import { personAuthor } from '../sessions/instructionAuthor.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { userRepository } from '../users/repository.js';
import type { User } from '../users/types.js';
import { sharedPageCommentService } from './commentService.js';
import { sharedPageService } from './service.js';
import type { SharedPage, SharedPageComment } from './types.js';

/**
 * Mise à jour d'une page partagée par la session qui l'a publiée (« je commente, l'agent corrige ») : le propriétaire
 * de la page envoie à cette session une instruction qui reprend les commentaires à traiter (ancre, fil) et, s'il
 * en a donné une, sa demande ; l'agent republie une version avec `pages.publish` puis marque les commentaires
 * traités avec `pages.resolve`.
 */

export interface UpdateRequestInput {
  /** Demande libre de la personne (facultative quand il y a des commentaires). */
  instruction?: string | null;
  /** Joindre les commentaires non traités (défaut : oui). */
  withComments?: boolean | null;
}

/** Un commentaire racine avec ses réponses et les noms des auteurs, pour l'instruction. */
export interface ThreadForInstruction {
  comment: SharedPageComment;
  author: string;
  replies: Array<{ author: string; body: string }>;
}

const MAX_INSTRUCTION = 10_000;

const indent = (text: string, pad: string) => text.split('\n').map((l) => `${pad}${l}`).join('\n');

/** Texte de l'instruction envoyée à la session (fonction pure, testée). */
export function formatUpdateInstruction(page: SharedPage, threads: ThreadForInstruction[], instruction: string | null, author: string): string {
  const lines: string[] = [];
  const n = threads.length;
  lines.push(`Mise à jour demandée par ${author} de la page partagée « ${page.title} » (page_id ${page.id}, version ${page.version}, ${config.appUrl}/shared/${page.id}).`);
  if (instruction) lines.push('', `Demande : ${instruction}`);
  if (n) {
    lines.push('', `${n} commentaire${n > 1 ? 's' : ''} à prendre en compte :`);
    threads.forEach((t, i) => {
      const c = t.comment;
      const where = c.anchor ? `sur <${c.anchor.tag ?? '?'}> \`${c.anchor.selector}\`${c.anchor.text ? ` « ${c.anchor.text} »` : ''}` : 'général';
      const version = c.version !== page.version ? ` (fait sur la version ${c.version})` : '';
      lines.push('', `${i + 1}. [${c.id}] ${t.author}, ${where}${version} :`, indent(c.body, '   '));
      for (const r of t.replies) lines.push(indent(`↳ ${r.author} : ${r.body}`, '   '));
    });
  }
  lines.push(
    '',
    `Fais les changements dans le fichier HTML de la page${page.sourcePath ? ` (${page.sourcePath})` : ''}, puis publie une nouvelle version avec \`pages.publish\` (page_id ${page.id}).` +
      (n ? " Marque ensuite chaque commentaire pris en compte comme traité avec `pages.resolve` (comment_id entre crochets ci-dessus) et réponds dans son fil avec `pages.reply` quand une remarque appelle une précision ou n'a pas été suivie." : '') +
      ' Résume en une ou deux phrases ce que tu as changé.',
  );
  return lines.join('\n');
}

export const sharedPageUpdateService = {
  /** Commentaires non traités de la page, avec leurs réponses et les noms des auteurs. */
  async openThreads(page: SharedPage): Promise<ThreadForInstruction[]> {
    const roots = (await sharedPageCommentService.roots(page.id)).filter((c) => !c.resolvedAt);
    const replies = await Promise.all(roots.map((r) => sharedPageCommentService.replies(r.id)));
    const ids = new Set<string>();
    roots.forEach((r, i) => {
      ids.add(r.authorId);
      replies[i].forEach((x) => ids.add(x.authorId));
    });
    const users = ids.size ? await userRepository.findByIds([...ids]) : [];
    const name = (c: SharedPageComment) => (users.find((u) => u.id === c.authorId)?.name ?? 'quelqu’un') + (c.sessionId ? ' (agent)' : '');
    return roots.map((comment, i) => ({ comment, author: name(comment), replies: replies[i].map((r) => ({ author: name(r), body: r.body })) }));
  },

  /**
   * Envoie l'instruction à la session d'origine de la page (relancée, ou restaurée si elle était archivée). Réservé
   * au propriétaire ; le droit sur la session elle-même est vérifié par l'appelant (membre du projet).
   */
  async request(user: User, pageId: string, input: UpdateRequestInput): Promise<{ session: Session; text: string }> {
    const page = await sharedPageService.getOwned(user.id, pageId);
    if (!page.sessionId) throw new AppError("Cette page n'est rattachée à aucune session : seule une page publiée par un agent (outil pages.publish) peut lui être renvoyée");
    const instruction = (input.instruction ?? '').trim().slice(0, MAX_INSTRUCTION) || null;
    const threads = input.withComments === false ? [] : await this.openThreads(page);
    if (!instruction && !threads.length) throw new AppError('Rien à transmettre : aucun commentaire à traiter, et pas de demande');
    const text = formatUpdateInstruction(page, threads, instruction, user.name || user.email);
    const session = await sessionService.sendMessage(page.sessionId, text, null, { byPerson: true, unarchive: true, author: personAuthor(user) });
    return { session, text };
  },
};
