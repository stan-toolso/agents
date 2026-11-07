import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Mots de passe des personnes : empreinte scrypt (sans dépendance), format `scrypt$N$r$p$sel$empreinte` (base64url),
 * pour pouvoir durcir les paramètres plus tard sans invalider les anciennes empreintes.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer, opts: ScryptOptions, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P }, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Vrai si le mot de passe correspond à l'empreinte ; faux pour une empreinte absente ou illisible. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const opts = { N: Number(n), r: Number(r), p: Number(p) };
  if (!expected.length || !Number.isInteger(opts.N) || !Number.isInteger(opts.r) || !Number.isInteger(opts.p)) return false;
  const key = await derive(password, Buffer.from(salt, 'base64url'), opts, expected.length).catch(() => null);
  return Boolean(key && key.length === expected.length && timingSafeEqual(key, expected));
}

/** Message d'erreur si le mot de passe est trop faible, null s'il convient. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Le mot de passe ne doit pas dépasser ${MAX_PASSWORD_LENGTH} caractères`;
  if (new Set(password).size < 4) return 'Le mot de passe est trop répétitif';
  const local = email?.split('@')[0]?.toLowerCase();
  if (email && (password.toLowerCase() === email.toLowerCase() || (local && local.length >= 4 && password.toLowerCase() === local))) return "Le mot de passe ne doit pas être l'adresse e-mail";
  return null;
}

/**
 * Freinage des essais de mot de passe, par adresse et par IP, en mémoire de l'instance : au-delà de `MAX_FAILURES`
 * échecs dans la fenêtre, les essais suivants sont refusés jusqu'à sa fin. Une réussite remet le compteur de l'adresse à zéro.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_FAILURES_PER_IP = 30;
const failures = new Map<string, { count: number; until: number }>();

function bump(key: string, now: number): void {
  const f = failures.get(key);
  if (!f || f.until <= now) failures.set(key, { count: 1, until: now + WINDOW_MS });
  else f.count += 1;
}

export const loginThrottle = {
  /** Vrai si l'essai doit être refusé sans même vérifier le mot de passe. */
  blocked(email: string, ip: string | null, now = Date.now()): boolean {
    const byEmail = failures.get(`e:${email}`);
    const byIp = ip ? failures.get(`i:${ip}`) : undefined;
    return Boolean((byEmail && byEmail.until > now && byEmail.count >= MAX_FAILURES) || (byIp && byIp.until > now && byIp.count >= MAX_FAILURES_PER_IP));
  },
  fail(email: string, ip: string | null, now = Date.now()): void {
    bump(`e:${email}`, now);
    if (ip) bump(`i:${ip}`, now);
    if (failures.size > 10_000) for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
  },
  succeed(email: string): void {
    failures.delete(`e:${email}`);
  },
  reset(): void {
    failures.clear();
  },
};
