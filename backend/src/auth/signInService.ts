import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { smtpService } from '../notifications/smtp.js';
import { userRepository } from '../users/repository.js';
import type { ExternalIdentity, User, UserIdentity } from '../users/types.js';
import { googleAuth } from './google.js';
import { hashPassword, loginThrottle, passwordProblem, verifyPassword } from './password.js';
import { isLoginProviderId, loginProviders, type LoginProviderId } from './providers.js';

/**
 * Connexion autrement qu'avec Google : comptes Microsoft et GitHub, e-mail et mot de passe, liens pour choisir ou
 * réinitialiser son mot de passe. Toujours la même règle : personne ne s'inscrit seul, seule une personne invitée
 * (`users.kind = 'person'`) se connecte ; un agent de projet jamais.
 */

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Durée d'un lien « mot de passe oublié » et d'un lien créé par un administrateur (invitation). */
const SELF_SERVICE_TTL_MS = 60 * 60 * 1000;
const ADMIN_LINK_TTL_MS = 7 * 24 * 3600 * 1000;
/** Un seul lien « mot de passe oublié » toutes les deux minutes par personne. */
const SELF_SERVICE_COOLDOWN_MS = 2 * 60 * 1000;

/** Empreinte de comparaison quand l'adresse est inconnue : le temps de réponse ne dit pas si le compte existe. */
let dummyHash: Promise<string> | null = null;

export interface LoginMethodsView {
  email: string;
  hasPassword: boolean;
  passwordSetAt: Date | null;
  googleLinked: boolean;
  identities: UserIdentity[];
  providers: { id: string; label: string; configured: boolean }[];
  passwordLoginEnabled: boolean;
}

/** Modes de connexion offerts par le serveur (page de connexion, sans session). */
export async function availableMethods(): Promise<{ google: boolean; microsoft: boolean; github: boolean; password: boolean; passwordReset: boolean }> {
  return {
    google: googleAuth.configured,
    microsoft: loginProviders.microsoft.configured,
    github: loginProviders.github.configured,
    password: config.passwordLogin,
    passwordReset: config.passwordLogin && (await smtpService.configured().catch(() => false)),
  };
}

const resetUrl = (token: string) => `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;

function assertPerson(user: User | null, email: string): User {
  if (!user || user.kind !== 'person') throw new AppError(`Aucune invitation pour ${email}`, 'NOT_INVITED');
  return user;
}

export const signInService = {
  availableMethods,

  /**
   * Connexion par un compte Microsoft ou GitHub : le compte déjà relié, sinon une invitation à l'une de ses adresses
   * vérifiées (le compte est alors relié pour les fois suivantes).
   */
  async loginWithIdentity(identity: ExternalIdentity): Promise<User> {
    const linked = await userRepository.findIdentity(identity.provider, identity.subject);
    let user: User | null = linked ? await userRepository.findById(linked.userId) : null;
    if (!user) {
      if (!identity.verifiedEmails.length) {
        throw new AppError(
          identity.email
            ? `L'adresse ${identity.email} n'est pas garantie par ${loginProviders[identity.provider].label} : connectez-vous autrement puis reliez ce compte depuis Paramètres › Connexion`
            : `Aucune adresse vérifiée sur ce compte ${loginProviders[identity.provider].label}`,
          'EMAIL_NOT_VERIFIED',
        );
      }
      for (const email of identity.verifiedEmails) {
        const found = await userRepository.findByEmail(email);
        if (found?.kind === 'person') {
          user = found;
          break;
        }
      }
    }
    user = assertPerson(user, identity.verifiedEmails[0] ?? identity.email ?? 'ce compte');
    await userRepository.linkIdentity({ provider: identity.provider, subject: identity.subject, userId: user.id, email: identity.email });
    return userRepository.touchLogin(user.id, { name: identity.name, avatarUrl: identity.avatarUrl });
  },

  /** Relie un compte Microsoft ou GitHub à la personne connectée (Paramètres › Connexion), quelle que soit son adresse. */
  async linkIdentity(user: User, identity: ExternalIdentity): Promise<void> {
    const linked = await userRepository.findIdentity(identity.provider, identity.subject);
    if (linked && linked.userId !== user.id) throw new AppError(`Ce compte ${loginProviders[identity.provider].label} est déjà relié à une autre personne`, 'ACCOUNT_MISMATCH');
    await userRepository.linkIdentity({ provider: identity.provider, subject: identity.subject, userId: user.id, email: identity.email });
  },

  async unlinkIdentity(user: User, provider: string): Promise<LoginMethodsView> {
    if (provider === 'google') {
      await userRepository.unlinkGoogle(user.id);
    } else {
      if (!isLoginProviderId(provider)) throw new AppError('Fournisseur inconnu');
      await userRepository.unlinkIdentity(user.id, provider);
    }
    return this.methodsOf(user.id);
  },

  /** E-mail et mot de passe ; message volontairement identique que l'adresse soit inconnue ou le mot de passe faux. */
  async loginWithPassword(rawEmail: string, password: string, ip: string | null): Promise<User> {
    if (!config.passwordLogin) throw new AppError('Connexion par mot de passe désactivée sur ce serveur', 'NOT_CONFIGURED');
    const email = rawEmail.trim().toLowerCase();
    if (!email || !password) throw new AppError('Adresse e-mail ou mot de passe incorrect', 'INVALID_CREDENTIALS');
    if (loginThrottle.blocked(email, ip)) throw new AppError('Trop d’essais : réessayez dans quelques minutes', 'TOO_MANY_ATTEMPTS');
    const user = await userRepository.findByEmail(email);
    const stored = user?.kind === 'person' ? await userRepository.passwordHash(user.id) : null;
    const ok = stored ? await verifyPassword(password, stored) : await verifyPassword(password, await (dummyHash ??= hashPassword(randomBytes(12).toString('hex'))));
    if (!user || !stored || !ok) {
      loginThrottle.fail(email, ip);
      throw new AppError('Adresse e-mail ou mot de passe incorrect', 'INVALID_CREDENTIALS');
    }
    loginThrottle.succeed(email);
    return userRepository.touchLogin(user.id);
  },

  /** Choisit ou change son mot de passe (Paramètres › Connexion) ; le mot de passe en cours est demandé s'il existe. */
  async setPassword(user: User, currentPassword: string | null | undefined, newPassword: string, keepTokenHash: string | null): Promise<LoginMethodsView> {
    if (!config.passwordLogin) throw new AppError('Connexion par mot de passe désactivée sur ce serveur', 'NOT_CONFIGURED');
    const stored = await userRepository.passwordHash(user.id);
    if (stored && !(await verifyPassword(currentPassword ?? '', stored))) throw new AppError('Mot de passe actuel incorrect', 'INVALID_CREDENTIALS');
    const problem = passwordProblem(newPassword, user.email);
    if (problem) throw new AppError(problem);
    await userRepository.setPasswordHash(user.id, await hashPassword(newPassword));
    await userRepository.revokePasswordTokens(user.id);
    // Un changement de mot de passe ferme les autres sessions ouvertes (celle-ci reste).
    if (stored) await userRepository.deleteUserSessions(user.id, keepTokenHash);
    return this.methodsOf(user.id);
  },

  async removePassword(user: User): Promise<LoginMethodsView> {
    await userRepository.setPasswordHash(user.id, null);
    await userRepository.revokePasswordTokens(user.id);
    return this.methodsOf(user.id);
  },

  /**
   * « Mot de passe oublié » : envoie un lien valable une heure si l'adresse est celle d'une personne invitée et qu'un
   * serveur SMTP est configuré. Ne dit jamais si l'adresse existe.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    if (!config.passwordLogin) return;
    const email = rawEmail.trim().toLowerCase();
    const user = email ? await userRepository.findByEmail(email) : null;
    if (!user || user.kind !== 'person') return;
    if (!(await smtpService.configured())) return;
    const last = await userRepository.lastSelfServiceTokenAt(user.id);
    if (last && Date.now() - last.getTime() < SELF_SERVICE_COOLDOWN_MS) return;
    const token = randomBytes(32).toString('base64url');
    await userRepository.createPasswordToken(hash(token), user.id, new Date(Date.now() + SELF_SERVICE_TTL_MS), null);
    const url = resetUrl(token);
    const hasPassword = Boolean(user.passwordSetAt);
    const subject = hasPassword ? 'Réinitialiser votre mot de passe Skipper' : 'Choisir votre mot de passe Skipper';
    const text = `Bonjour ${user.name},\n\nPour ${hasPassword ? 'réinitialiser' : 'choisir'} votre mot de passe Skipper, ouvrez ce lien (valable une heure) :\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`;
    await smtpService.send({ to: user.email, subject, text }).catch((err) => log.warn(`[auth] envoi du lien de mot de passe à ${user.email} impossible : ${(err as Error).message}`));
  },

  /**
   * Lien pour choisir son mot de passe, créé par un administrateur (invitation sans Google, mot de passe perdu) :
   * valable 7 jours, à transmettre, ou envoyé par e-mail si demandé et possible.
   */
  async createPasswordLink(target: User, admin: User, sendEmail: boolean): Promise<{ url: string; expiresAt: Date; emailed: boolean }> {
    if (!config.passwordLogin) throw new AppError('Connexion par mot de passe désactivée sur ce serveur (PASSWORD_LOGIN=off)', 'NOT_CONFIGURED');
    if (target.kind !== 'person') throw new AppError('Un agent de projet ne se connecte pas');
    if (target.isSuperAdmin && !admin.isSuperAdmin && target.id !== admin.id) throw new AppError('Seul un super administrateur crée ce lien pour un super administrateur', 'FORBIDDEN');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ADMIN_LINK_TTL_MS);
    await userRepository.createPasswordToken(hash(token), target.id, expiresAt, admin.id);
    const url = resetUrl(token);
    let emailed = false;
    if (sendEmail) {
      if (!(await smtpService.configured())) throw new AppError('Aucun serveur SMTP configuré (Paramètres › Serveur) : copiez le lien et transmettez-le');
      const text = `Bonjour ${target.name},\n\n${admin.name} vous invite à choisir votre mot de passe Skipper. Ouvrez ce lien (valable 7 jours) :\n${url}\n\nVous vous connecterez ensuite sur ${config.appUrl} avec votre adresse ${target.email}.`;
      await smtpService.send({ to: target.email, subject: 'Choisir votre mot de passe Skipper', text });
      emailed = true;
    }
    return { url, expiresAt, emailed };
  },

  /** Personne d'un lien encore valable (page « Choisir un mot de passe »), ou null. */
  async userOfToken(token: string): Promise<User | null> {
    if (!token) return null;
    return userRepository.findPasswordTokenUser(hash(token));
  },

  /** Choisit le mot de passe par un lien : le lien est consommé, les autres liens et sessions fermés, la personne connectée. */
  async resetPassword(token: string, password: string): Promise<User> {
    if (!config.passwordLogin) throw new AppError('Connexion par mot de passe désactivée sur ce serveur', 'NOT_CONFIGURED');
    const user = await this.userOfToken(token);
    if (!user || user.kind !== 'person') throw new AppError('Ce lien a expiré ou a déjà servi : demandez-en un nouveau', 'INVALID_TOKEN');
    const problem = passwordProblem(password, user.email);
    if (problem) throw new AppError(problem);
    if (!(await userRepository.consumePasswordToken(hash(token)))) throw new AppError('Ce lien a expiré ou a déjà servi : demandez-en un nouveau', 'INVALID_TOKEN');
    await userRepository.setPasswordHash(user.id, await hashPassword(password));
    await userRepository.revokePasswordTokens(user.id);
    await userRepository.deleteUserSessions(user.id);
    loginThrottle.succeed(user.email);
    return userRepository.touchLogin(user.id);
  },

  async methodsOf(userId: string): Promise<LoginMethodsView> {
    const user = await userRepository.findById(userId);
    if (!user) throw new AppError('Utilisateur introuvable', 'NOT_FOUND');
    return {
      email: user.email,
      hasPassword: Boolean(user.passwordSetAt),
      passwordSetAt: user.passwordSetAt,
      googleLinked: Boolean(user.googleSub),
      identities: await userRepository.listIdentities(user.id),
      providers: [
        { id: 'google', label: 'Google', configured: googleAuth.configured },
        ...(Object.values(loginProviders) as { id: LoginProviderId; label: string; configured: boolean }[]).map((p) => ({ id: p.id, label: p.label, configured: p.configured })),
      ],
      passwordLoginEnabled: config.passwordLogin,
    };
  },

  purgeExpiredTokens: () => userRepository.deleteExpiredPasswordTokens(),
  tokenHash: hash,
};
