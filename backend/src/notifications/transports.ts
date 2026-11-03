import { AppError } from '../errors.js';
import { smtpService } from './smtp.js';

/**
 * Transports des canaux de notification hors navigateur : webhook Slack, webhook Discord, e-mail. Chaque envoi
 * porte une ou plusieurs notifications (anti-rafale, batcher.ts) avec un lien absolu vers la page concernée.
 */

export type ChannelKind = 'slack' | 'discord' | 'email';
export const CHANNEL_KINDS: readonly ChannelKind[] = ['slack', 'discord', 'email'];

/** Ce qu'un transport reçoit d'une notification. */
export interface OutgoingItem {
  title: string;
  message: string | null;
  /** Lien absolu (https://…/sessions/…) ; null : aucun. */
  url: string | null;
  projectName: string | null;
}

const SLACK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/;
const DISCORD = /^https:\/\/((ptb|canary)\.)?(discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Vérifie et normalise la cible d'un canal ; renvoie aussi sa version affichable (sans le secret du webhook). */
export function validateTarget(kind: ChannelKind, raw: string): { target: string; hint: string } {
  const target = raw.trim();
  if (kind === 'email') {
    if (!EMAIL.test(target) || target.length > 254) throw new AppError('Adresse e-mail invalide');
    return { target, hint: target };
  }
  const pattern = kind === 'slack' ? SLACK : DISCORD;
  if (!pattern.test(target)) {
    throw new AppError(kind === 'slack' ? 'Adresse de webhook Slack attendue (https://hooks.slack.com/services/…)' : 'Adresse de webhook Discord attendue (https://discord.com/api/webhooks/…)');
  }
  const url = new URL(target);
  return { target, hint: `${url.host}/…${target.slice(-4)}` };
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Échappement des caractères de contrôle du mrkdwn de Slack (&, <, >). */
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const prefix = (i: OutgoingItem) => (i.projectName ? `[${i.projectName}] ` : '');

export function slackPayload(items: OutgoingItem[]): { text: string } {
  const line = (i: OutgoingItem, bullet: boolean) => {
    const title = slackEscape(prefix(i) + i.title);
    const head = i.url ? `<${i.url}|${title}>` : title;
    const body = i.message ? `\n${bullet ? '   ' : ''}${slackEscape(clip(i.message, bullet ? 300 : 1500))}` : '';
    return `${bullet ? '• ' : ''}*${head}*${body}`;
  };
  if (items.length === 1) return { text: line(items[0], false) };
  return { text: clip(`*${items.length} notifications Skipper*\n${items.map((i) => line(i, true)).join('\n')}`, 3900) };
}

/** Discord : liens Markdown [texte](url), 2000 caractères au plus, mentions désactivées. */
export function discordPayload(items: OutgoingItem[]): { content: string; allowed_mentions: { parse: never[] } } {
  const esc = (s: string) => s.replace(/([[\]()*_~`|\\])/g, '\\$1');
  const line = (i: OutgoingItem, bullet: boolean) => {
    const title = esc(prefix(i) + i.title);
    const head = i.url ? `[${title}](<${i.url}>)` : title;
    const body = i.message ? `\n${bullet ? '  ' : ''}${esc(clip(i.message, bullet ? 200 : 1200))}` : '';
    return `${bullet ? '• ' : ''}**${head}**${body}`;
  };
  const content = items.length === 1 ? line(items[0], false) : `**${items.length} notifications Skipper**\n${items.map((i) => line(i, true)).join('\n')}`;
  return { content: clip(content, 2000), allowed_mentions: { parse: [] } };
}

const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function emailContent(items: OutgoingItem[]): { subject: string; text: string; html: string } {
  const subject = clip(items.length === 1 ? `${prefix(items[0])}${items[0].title}` : `${items.length} notifications Skipper`, 180);
  const text = items.map((i) => [prefix(i) + i.title, i.message, i.url].filter(Boolean).join('\n')).join('\n\n');
  const html =
    '<div style="font-family:system-ui,sans-serif;font-size:14px">' +
    items
      .map((i) => {
        const title = htmlEscape(prefix(i) + i.title);
        const head = i.url ? `<a href="${htmlEscape(i.url)}">${title}</a>` : title;
        const body = i.message ? `<div style="color:#555;white-space:pre-wrap">${htmlEscape(clip(i.message, 2000))}</div>` : '';
        return `<p style="margin:0 0 14px"><strong>${head}</strong>${body}</p>`;
      })
      .join('') +
    '<p style="color:#888;font-size:12px">Envoyé par Skipper. Les canaux de notification se règlent dans Paramètres › Notifications ou dans les réglages du projet.</p></div>';
  return { subject, text, html };
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`HTTP ${res.status}${detail ? ` : ${detail}` : ''}`);
  }
}

/** Envoie un lot sur un canal ; lève en cas d'échec (message destiné à l'interface, sans la cible). */
export async function deliver(kind: ChannelKind, target: string, items: OutgoingItem[]): Promise<void> {
  if (!items.length) return;
  if (kind === 'slack') return postJson(target, slackPayload(items));
  if (kind === 'discord') return postJson(target, discordPayload(items));
  const { subject, text, html } = emailContent(items);
  await smtpService.send({ to: target, subject, text, html });
}
