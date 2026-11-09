import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { settingsRepository } from '../settings/repository.js';

/**
 * Envoi des e-mails de Skipper (« mot de passe oublié », liens d'un administrateur, invitations aux pages partagées,
 * canaux de notification e-mail) par l'API transactionnelle de Brevo (`POST /v3/smtp/email`). Deux sources de
 * configuration, la première trouvée gagne :
 * - variables d'environnement `BREVO_API_KEY` et `MAIL_FROM` ;
 * - Paramètres › Serveur (clé `mail` de app_settings, clé d'API chiffrée), réglés par un administrateur.
 * L'expéditeur doit être une adresse (ou un domaine) validée dans Brevo ; par défaut « Skipper <skipper@toolso.io> ».
 */

const KEY = 'mail';
const BREVO_URL = 'https://api.brevo.com/v3';
export const DEFAULT_FROM = 'Skipper <skipper@toolso.io>';

interface StoredMail {
  /** Chiffrée. */
  apiKey: string;
  from: string;
}

export interface MailView {
  /** 'env' : variables d'environnement (non modifiable dans l'interface) ; 'settings' ; 'none' : pas configuré. */
  source: 'env' | 'settings' | 'none';
  provider: 'brevo';
  from: string | null;
  hasApiKey: boolean;
  /** Fin de la clé d'API (4 caractères), pour la reconnaître sans la montrer. */
  apiKeyHint: string | null;
}

export interface MailInput {
  /** Absente ou null : garder la clé enregistrée. */
  apiKey?: string | null;
  from: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface Resolved {
  apiKey: string;
  from: string;
  source: 'env' | 'settings';
}

let cached: Resolved | null | undefined;
/** Relu toutes les minutes : une autre instance (bleu/vert) a pu changer les réglages. */
let cachedAt = 0;
const CACHE_MS = 60_000;

function fromEnv(): Resolved | null {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, from: process.env.MAIL_FROM?.trim() || DEFAULT_FROM, source: 'env' };
}

async function resolve(): Promise<Resolved | null> {
  if (cached !== undefined && Date.now() - cachedAt < CACHE_MS) return cached;
  cachedAt = Date.now();
  const env = fromEnv();
  if (env) return (cached = env);
  const s = await settingsRepository.get<StoredMail>(KEY);
  cached = s?.apiKey ? { apiKey: decryptSecret(s.apiKey), from: s.from || DEFAULT_FROM, source: 'settings' } : null;
  return cached;
}

/** « Nom <adresse> » ou « adresse » → expéditeur Brevo. */
export function parseSender(from: string): { name?: string; email: string } | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*<([^<>\s]+)>|([^<>\s]+))\s*$/.exec(from);
  const email = (m?.[2] ?? m?.[3] ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = m?.[1]?.trim();
  return name ? { name, email } : { email };
}

async function brevo(apiKey: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BREVO_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'api-key': apiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw) as { message?: string; code?: string };
      if (j.message) detail = j.code ? `${j.message} (${j.code})` : j.message;
    } catch {
      /* corps non JSON : tel quel */
    }
    throw new Error(`Brevo HTTP ${res.status}${detail ? ` : ${detail}` : ''}`);
  }
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Corps de l'appel Brevo pour un e-mail (exporté pour les tests). */
export function brevoPayload(from: string, mail: Mail): Record<string, unknown> {
  const sender = parseSender(from);
  if (!sender) throw new Error(`Expéditeur invalide : ${from}`);
  return {
    sender,
    to: [{ email: mail.to }],
    subject: mail.subject,
    textContent: mail.text,
    ...(mail.html ? { htmlContent: mail.html } : {}),
  };
}

export const mailService = {
  async view(): Promise<MailView> {
    const r = fromEnv() ?? null;
    if (r) return { source: 'env', provider: 'brevo', from: r.from, hasApiKey: true, apiKeyHint: r.apiKey.slice(-4) };
    const s = await settingsRepository.get<StoredMail>(KEY);
    if (!s?.apiKey) return { source: 'none', provider: 'brevo', from: s?.from ?? null, hasApiKey: false, apiKeyHint: null };
    let hint: string | null = null;
    try {
      hint = decryptSecret(s.apiKey).slice(-4);
    } catch {
      /* clé illisible (secret de chiffrement changé) : à ressaisir */
    }
    return { source: 'settings', provider: 'brevo', from: s.from, hasApiKey: true, apiKeyHint: hint };
  },

  /** Enregistre la clé d'API et l'expéditeur ; une nouvelle clé est vérifiée auprès de Brevo avant d'être gardée. */
  async update(input: MailInput): Promise<MailView> {
    if (fromEnv()) throw new AppError('L’envoi des e-mails est fixé par la variable d’environnement BREVO_API_KEY');
    const from = input.from.trim() || DEFAULT_FROM;
    if (!parseSender(from)) throw new AppError('Adresse d’expéditeur invalide');
    const previous = await settingsRepository.get<StoredMail>(KEY);
    const newKey = input.apiKey?.trim();
    if (!newKey && !previous?.apiKey) throw new AppError('Clé d’API Brevo requise');
    if (newKey) {
      try {
        await brevo(newKey, '/account');
      } catch (err) {
        throw new AppError(`Clé d’API refusée par Brevo : ${(err as Error).message}`);
      }
    }
    await settingsRepository.set<StoredMail>(KEY, { apiKey: newKey ? encryptSecret(newKey) : previous!.apiKey, from });
    cached = undefined;
    return this.view();
  },

  async clear(): Promise<MailView> {
    await settingsRepository.delete(KEY);
    cached = undefined;
    return this.view();
  },

  async configured(): Promise<boolean> {
    return (await resolve()) !== null;
  },

  async send(mail: Mail): Promise<void> {
    const r = await resolve();
    if (!r) throw new Error('Envoi des e-mails non configuré (Paramètres › Serveur ou BREVO_API_KEY)');
    await brevo(r.apiKey, '/smtp/email', brevoPayload(r.from, mail));
  },

  /** Oublie la configuration en cache (réglages modifiés par une autre instance). */
  reset(): void {
    cached = undefined;
  },
};
