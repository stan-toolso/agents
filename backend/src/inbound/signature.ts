import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature HMAC facultative des appels entrants : quand la clé d'API a un secret de signature, l'appelant envoie
 * `X-Skipper-Timestamp: <secondes Unix>` et `X-Skipper-Signature: sha256=<hex>` où hex = HMAC-SHA256(secret,
 * `<timestamp>.<corps brut>`). L'horodatage borne le rejeu (5 minutes d'écart au plus).
 */

export const SIGNATURE_TOLERANCE_S = 300;

export function sign(secret: string, timestamp: string | number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifySignature(secret: string, body: string, timestampHeader: string | undefined, signatureHeader: string | undefined, nowMs = Date.now()): SignatureCheck {
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'Signature requise : en-têtes X-Skipper-Timestamp et X-Skipper-Signature' };
  if (!/^\d{1,12}$/.test(timestampHeader.trim())) return { ok: false, reason: 'X-Skipper-Timestamp doit être un horodatage Unix en secondes' };
  const ts = Number(timestampHeader.trim());
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: `Horodatage hors de la fenêtre de ${SIGNATURE_TOLERANCE_S / 60} minutes` };
  const expected = Buffer.from(sign(secret, timestampHeader.trim(), body));
  // Plusieurs signatures séparées par des virgules sont acceptées (rotation du secret côté appelant).
  for (const candidate of signatureHeader.split(',').map((s) => s.trim())) {
    const got = Buffer.from(candidate);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: 'Signature invalide' };
}
