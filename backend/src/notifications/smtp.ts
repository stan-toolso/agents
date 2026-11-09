import nodemailer, { type Transporter } from 'nodemailer';
import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { settingsRepository } from '../settings/repository.js';

/**
 * Serveur SMTP des notifications par e-mail. Deux sources, la première trouvée gagne :
 * - variables d'environnement `SMTP_URL` (ex. `smtps://user:mot-de-passe@smtp.exemple.fr:465`) et `SMTP_FROM` ;
 * - Paramètres › Serveur (clé `smtp` de app_settings, mot de passe chiffré), réglés par un administrateur.
 */

const KEY = 'smtp';

interface StoredSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  /** Chiffré. */
  password: string | null;
  from: string;
}

export interface SmtpView {
  /** 'env' : variables d'environnement (non modifiable dans l'interface) ; 'settings' ; 'none' : pas configuré. */
  source: 'env' | 'settings' | 'none';
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
}

export interface SmtpInput {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  /** Absent ou null : garder le mot de passe enregistré ; chaîne vide : le retirer. */
  password?: string | null;
  from: string;
}

let cached: { transporter: Transporter; from: string } | null | undefined;
/** Le transport est relu toutes les minutes : une autre instance (bleu/vert) a pu changer les réglages. */
let cachedAt = 0;
const CACHE_MS = 60_000;

function fromEnv(): { url: string; from: string } | null {
  const url = process.env.SMTP_URL?.trim();
  if (!url) return null;
  let from = process.env.SMTP_FROM?.trim();
  if (!from) {
    try {
      const u = new URL(url);
      from = u.username ? decodeURIComponent(u.username) : `skipper@${u.hostname}`;
    } catch {
      from = 'skipper@localhost';
    }
  }
  return { url, from };
}

async function transport(): Promise<{ transporter: Transporter; from: string } | null> {
  if (cached !== undefined && Date.now() - cachedAt < CACHE_MS) return cached;
  cachedAt = Date.now();
  const env = fromEnv();
  if (env) {
    cached = { transporter: nodemailer.createTransport(env.url), from: env.from };
    return cached;
  }
  const s = await settingsRepository.get<StoredSmtp>(KEY);
  cached = s
    ? {
        transporter: nodemailer.createTransport({
          host: s.host,
          port: s.port,
          secure: s.secure,
          ...(s.user ? { auth: { user: s.user, pass: s.password ? decryptSecret(s.password) : '' } } : {}),
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        }),
        from: s.from,
      }
    : null;
  return cached;
}

export const smtpService = {
  async view(): Promise<SmtpView> {
    const env = fromEnv();
    if (env) {
      let host: string | null = null;
      let port: number | null = null;
      let secure = false;
      try {
        const u = new URL(env.url);
        host = u.hostname;
        port = u.port ? Number(u.port) : null;
        secure = u.protocol === 'smtps:';
      } catch {
        /* adresse illisible : affichée sans détail */
      }
      return { source: 'env', host, port, secure, user: null, from: env.from, hasPassword: true };
    }
    const s = await settingsRepository.get<StoredSmtp>(KEY);
    if (!s) return { source: 'none', host: null, port: null, secure: false, user: null, from: null, hasPassword: false };
    return { source: 'settings', host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from, hasPassword: Boolean(s.password) };
  },

  async update(input: SmtpInput): Promise<SmtpView> {
    if (fromEnv()) throw new AppError('Le serveur SMTP est fixé par la variable d’environnement SMTP_URL');
    const host = input.host.trim();
    if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new AppError('Serveur SMTP invalide');
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('Port SMTP invalide');
    const from = input.from.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(from.replace(/^.*<(.+)>$/, '$1'))) throw new AppError('Adresse d’expéditeur invalide');
    const previous = await settingsRepository.get<StoredSmtp>(KEY);
    const user = input.user?.trim() || null;
    const password = input.password == null ? (previous?.password ?? null) : input.password ? encryptSecret(input.password) : null;
    await settingsRepository.set<StoredSmtp>(KEY, { host, port, secure: Boolean(input.secure), user, password, from });
    cached = undefined;
    return this.view();
  },

  async clear(): Promise<SmtpView> {
    await settingsRepository.delete(KEY);
    cached = undefined;
    return this.view();
  },

  async configured(): Promise<boolean> {
    return (await transport()) !== null;
  },

  /**
   * Envoie un e-mail. `fromName` remplace le nom affiché de l'expéditeur (l'adresse reste celle du serveur, pour la
   * délivrabilité) ; `replyTo` dirige les réponses vers une personne (celle qui partage une page, par exemple).
   */
  async send(mail: { to: string; subject: string; text: string; html?: string; fromName?: string; replyTo?: string }): Promise<void> {
    const t = await transport();
    if (!t) throw new Error('Aucun serveur SMTP configuré (Paramètres › Serveur ou SMTP_URL)');
    const from = mail.fromName ? { name: mail.fromName.replace(/[\r\n"<>]/g, ' ').trim().slice(0, 120), address: t.from.replace(/^.*<(.+)>$/, '$1').trim() } : t.from;
    await t.transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) });
  },

  /** Oublie le transport en cache (réglages modifiés par une autre instance). */
  reset(): void {
    cached = undefined;
  },
};
