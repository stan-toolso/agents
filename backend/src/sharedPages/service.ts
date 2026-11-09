import { AppError, NotFoundError } from '../errors.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { smtpService } from '../notifications/smtp.js';
import { userRepository } from '../users/repository.js';
import { userService } from '../users/service.js';
import type { User } from '../users/types.js';
import { sharedPageRepository } from './repository.js';
import { AGENT_HANDOFF_MODES, type AgentHandoff, type PublishInput, type SharedPage } from './types.js';

export const MAX_PAGE_BYTES = 10 * 1024 * 1024;

function cleanTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) throw new AppError('Le titre de la page est obligatoire');
  if (title.length > 200) throw new AppError('Le titre dépasse 200 caractères');
  return title;
}

function cleanDescription(raw: string | null | undefined): string | null {
  const d = raw?.trim() ?? '';
  if (d.length > 1000) throw new AppError('La description dépasse 1000 caractères');
  return d || null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Contenu de l'e-mail d'invitation à une page partagée (pur, testé). */
export function invitationEmail(actor: Pick<User, 'name' | 'email'>, page: Pick<SharedPage, 'id' | 'title'>, to: string, appUrl: string): { subject: string; text: string; html: string } {
  const link = `${appUrl.replace(/\/$/, '')}/shared/${page.id}`;
  const subject = `${actor.name} vous a partagé « ${page.title} »`;
  const text = [
    `${actor.name} (${actor.email}) a partagé une page avec vous sur Skipper : « ${page.title} ».`,
    '',
    `Ouvrez-la ici : ${link}`,
    '',
    `Connectez-vous avec l'adresse ${to} (compte Google, Microsoft ou GitHub de cette adresse, ou mot de passe, selon ce que propose la page de connexion). Vous ne verrez que les pages partagées avec vous, et pourrez y laisser des commentaires.`,
  ].join('\n');
  const html = `<p>${escapeHtml(actor.name)} (${escapeHtml(actor.email)}) a partagé une page avec vous sur Skipper : <strong>${escapeHtml(page.title)}</strong>.</p>
<p><a href="${escapeHtml(link)}">Ouvrir la page</a></p>
<p style="color:#666">Connectez-vous avec l'adresse ${escapeHtml(to)} (compte Google, Microsoft ou GitHub de cette adresse, ou mot de passe, selon ce que propose la page de connexion). Vous ne verrez que les pages partagées avec vous, et pourrez y laisser des commentaires.</p>`;
  return { subject, text, html };
}

/** E-mail d'invitation, si un serveur SMTP est configuré ; un échec est journalisé (le lien reste à envoyer à la main). */
async function sendInvitation(actor: User, page: SharedPage, user: User): Promise<void> {
  try {
    if (!(await smtpService.configured())) return;
    await smtpService.send({ to: user.email, ...invitationEmail(actor, page, user.email, config.appUrl) });
  } catch (err) {
    log.warn(`[pages] e-mail d'invitation à ${user.email} : ${(err as Error).message}`);
  }
}

/** Nom de fichier sûr pour un téléchargement. */
export const downloadName = (title: string) => `${title.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80) || 'page'}.html`;

export const sharedPageService = {
  async get(id: string): Promise<SharedPage> {
    const page = await sharedPageRepository.findById(id);
    if (!page) throw new NotFoundError('Page partagée introuvable, ou non partagée avec vous');
    return page;
  },

  /**
   * Peut-on voir la page ? Propriétaire, lien ouvert, ou membre. Le lien ouvert vaut pour les personnes de Skipper,
   * pas pour un invité des pages partagées (`guest`) : lui ne voit que les pages où il a été ajouté.
   */
  async canView(page: SharedPage, userId: string, guest = false): Promise<boolean> {
    if (page.ownerId === userId || (page.linkAccess && !guest)) return true;
    return sharedPageRepository.isMember(page.id, userId);
  },

  /** Page visible par la personne ; sinon « introuvable » (l'existence n'est pas révélée). */
  async getFor(userId: string, id: string): Promise<SharedPage> {
    const page = await this.get(id);
    const guest = page.linkAccess && page.ownerId !== userId ? Boolean((await userRepository.findById(userId))?.isGuest) : false;
    if (!(await this.canView(page, userId, guest))) throw new NotFoundError('Page partagée introuvable, ou non partagée avec vous');
    return page;
  },

  async getOwned(userId: string, id: string): Promise<SharedPage> {
    const page = await this.getFor(userId, id);
    if (page.ownerId !== userId) throw new AppError('Seul le propriétaire de la page peut faire cela', 'FORBIDDEN');
    return page;
  },

  listFor: (userId: string) => sharedPageRepository.listFor(userId),
  listOwned: (userId: string, limit = 20) => sharedPageRepository.listOwned(userId, Math.min(Math.max(limit, 1), 100)),
  versions: (pageId: string) => sharedPageRepository.versions(pageId),
  members: (pageId: string) => sharedPageRepository.members(pageId),

  /** La page est-elle vue par d'autres que son propriétaire ? */
  async isShared(page: SharedPage): Promise<boolean> {
    return page.linkAccess || (await sharedPageRepository.members(page.id)).length > 0;
  },

  /** Publie une nouvelle page, ou une nouvelle version d'une page du propriétaire. */
  async publish(input: PublishInput): Promise<SharedPage> {
    if (!input.html.length) throw new AppError('La page est vide');
    if (input.html.length > MAX_PAGE_BYTES) throw new AppError(`La page est trop volumineuse (${(input.html.length / 1024 / 1024).toFixed(1)} Mo, 10 Mo au plus)`);
    const title = cleanTitle(input.title);
    const description = input.description === undefined ? undefined : cleanDescription(input.description);
    if (input.pageId) {
      const page = await this.get(input.pageId);
      if (page.ownerId !== input.ownerId) throw new AppError("Seul le propriétaire d'une page en publie de nouvelles versions", 'FORBIDDEN');
      const updated = await sharedPageRepository.addVersion(page.id, {
        title,
        description,
        linkAccess: input.linkAccess ?? null,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        sourcePath: input.sourcePath ?? null,
        html: input.html,
        createdBy: input.ownerId,
      });
      if (!updated) throw new NotFoundError('Page partagée introuvable');
      return updated;
    }
    return sharedPageRepository.create({
      ownerId: input.ownerId,
      title,
      description: description ?? null,
      linkAccess: input.linkAccess ?? false,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      sourcePath: input.sourcePath ?? null,
      html: input.html,
    });
  },

  /** Contenu d'une version (la dernière par défaut). */
  async content(page: SharedPage, version?: number | null): Promise<{ html: Buffer; version: number }> {
    const v = version ?? page.version;
    if (!Number.isInteger(v) || v < 1 || v > page.version) throw new NotFoundError('Version introuvable');
    const html = await sharedPageRepository.content(page.id, v);
    if (!html) throw new NotFoundError('Le contenu de cette version est manquant');
    return { html, version: v };
  },

  async update(userId: string, id: string, input: { title?: string | null; description?: string | null; linkAccess?: boolean | null; agentHandoff?: string | null }): Promise<SharedPage> {
    await this.getOwned(userId, id);
    const patch: { title?: string; description?: string | null; linkAccess?: boolean; agentHandoff?: AgentHandoff } = {};
    if (input.title != null) patch.title = cleanTitle(input.title);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.linkAccess != null) patch.linkAccess = input.linkAccess;
    if (input.agentHandoff != null) {
      if (!AGENT_HANDOFF_MODES.includes(input.agentHandoff as AgentHandoff)) throw new AppError('Réglage de transmission à l’agent inconnu');
      patch.agentHandoff = input.agentHandoff as AgentHandoff;
    }
    return (await sharedPageRepository.update(id, patch)) ?? this.get(id);
  },

  /**
   * Ajoute une personne à la page. Une adresse sans compte Skipper est refusée (code NO_ACCOUNT), sauf avec `invite` :
   * un compte d'invité des pages partagées est alors créé (il ne verra que les pages partagées avec lui) et, si un
   * serveur SMTP est configuré, un e-mail d'invitation lui donne le lien.
   */
  async addMember(actor: User, id: string, email: string, opts: { invite?: boolean } = {}): Promise<SharedPage> {
    const page = await this.getOwned(actor.id, id);
    const address = email.trim().toLowerCase();
    let user = await userRepository.findByEmail(address);
    let invited = false;
    if (!user) {
      if (!opts.invite) throw new AppError(`Aucun compte Skipper pour ${email.trim()} : invitez cette personne pour qu'elle puisse se connecter et voir la page`, 'NO_ACCOUNT');
      if (actor.isGuest) throw new AppError('Un invité ne peut pas inviter de nouvelles personnes', 'FORBIDDEN');
      ({ user, created: invited } = await userService.findOrCreateGuest(address));
    }
    if (user.kind === 'agent') throw new AppError("Cette adresse est celle d'un agent de projet : une page se partage avec des personnes");
    if (user.id === page.ownerId) throw new AppError('Le propriétaire voit toujours la page');
    if (await sharedPageRepository.addMember(id, user.id, actor.id)) {
      void notificationService.notify({ type: 'page.shared', title: `${actor.name} a partagé une page avec vous`, message: page.title, link: `/shared/${page.id}`, userId: user.id, payload: { pageId: page.id } });
      // Jamais connecté : la cloche ne l'atteint pas, l'e-mail (s'il est possible) lui apporte le lien.
      if (invited || !user.lastLoginAt) void sendInvitation(actor, page, user);
    }
    return page;
  },

  /** Le propriétaire retire qui il veut ; un membre peut se retirer lui-même. */
  async removeMember(actor: User, id: string, userId: string): Promise<SharedPage> {
    const page = await this.getFor(actor.id, id);
    if (page.ownerId !== actor.id && userId !== actor.id) throw new AppError('Seul le propriétaire de la page retire des personnes', 'FORBIDDEN');
    if (userId === page.ownerId) throw new AppError('Le propriétaire ne peut pas être retiré');
    await sharedPageRepository.removeMember(id, userId);
    return page;
  },

  async delete(userId: string, id: string): Promise<boolean> {
    await this.getOwned(userId, id);
    return sharedPageRepository.delete(id);
  },
};
