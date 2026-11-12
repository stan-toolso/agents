/**
 * E-mails des pages partagées (fonctions pures, testées) : invitation à consulter une page, avec le mot de la
 * personne qui partage, et lien de connexion demandé par un invité. Mise en page « e-mail » classique (tableaux,
 * styles en ligne, largeur 560 px, sans image externe) pour un rendu correct dans Gmail, Outlook et sur téléphone ;
 * toujours une version texte.
 */

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ACCENT = '#2f5fd0';
export const INK = '#1b1f24';
export const MUTED = '#5f6b7a';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Initiales d'un nom (« Stanislas Giraudet » → « SG »), pour la pastille de l'expéditeur. */
export function initials(name: string): string {
  const parts = name.replace(/[<>()[\]"]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts).map((p) => [...p][0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Bouton « à l'épreuve d'Outlook » (tableau + lien plein). */
export function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px"><tr><td align="center" bgcolor="${ACCENT}" style="border-radius:8px">
<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;background:${ACCENT}">${esc(label)}</a>
</td></tr></table>`;
}

/** Gabarit commun : fond gris clair, carte blanche, marque Skipper, pied de page. */
export function layout(opts: { preheader: string; body: string; footer: string; title: string }): string {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(opts.title)}</title>
<style>@media (max-width:480px){.sk-card{padding:26px 20px 22px!important}.sk-outer{padding:20px 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f4f6">${esc(opts.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" class="sk-outer" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-family:${FONT};font-size:15px;font-weight:700;letter-spacing:.2px;color:${INK}"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${ACCENT};margin-right:8px;vertical-align:middle"></span><span style="vertical-align:middle">Skipper</span></td></tr>
<tr><td class="sk-card" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 36px 30px;font-family:${FONT};font-size:15px;line-height:24px;color:${INK}">
${opts.body}
</td></tr>
<tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#8a94a3">${opts.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export interface PageShareEmailInput {
  actor: { name: string; email: string };
  page: { title: string; description?: string | null };
  /** Adresse du destinataire. */
  to: string;
  /** Message d'introduction de la personne qui partage (facultatif). */
  message?: string | null;
  /** Lien du bouton : connexion directe pour un invité, sinon la page elle-même. */
  url: string;
  /** Lien de connexion directe : durée de validité en jours (null : la personne se connecte comme d'habitude). */
  directLoginDays: number | null;
}

/** Invitation à consulter une page partagée. */
export function pageShareEmail(input: PageShareEmailInput): { subject: string; text: string; html: string; fromName: string; replyTo: string } {
  const { actor, page, to, url, directLoginDays } = input;
  const message = input.message?.trim() || null;
  const description = page.description?.trim() || null;
  const subject = `${actor.name} vous invite à consulter « ${page.title} »`;
  const preheader = message ? message.replace(/\s+/g, ' ').slice(0, 140) : description ? description.replace(/\s+/g, ' ').slice(0, 140) : `Une page vous attend sur Skipper : ${page.title}`;
  const access = directLoginDays
    ? `Aucun compte à créer, aucun mot de passe à retenir : le bouton vous connecte directement avec votre adresse ${to}. Ce lien vous est personnel et reste valable ${directLoginDays} jours ; ne le transférez pas.`
    : `Connectez-vous avec votre adresse ${to}, comme d'habitude.`;
  const text = [
    `${actor.name} (${actor.email}) vous a partagé une page sur Skipper :`,
    '',
    `« ${page.title} »`,
    ...(description ? [description] : []),
    ...(message ? ['', `Le mot de ${firstName(actor.name)} :`, ...message.split('\n').map((l) => `> ${l}`)] : []),
    '',
    `Consulter la page : ${url}`,
    '',
    access,
    'Vous pourrez la lire et y laisser vos commentaires, sur l’ensemble ou sur un passage précis.',
    '',
    '—',
    `Vous recevez ce message parce que ${actor.name} a partagé une page avec ${to}. Répondez à cet e-mail pour lui écrire directement.`,
  ].join('\n');

  const avatar = `<td width="44" valign="top" style="padding-right:14px"><div style="width:44px;height:44px;border-radius:22px;background:#e8eefc;color:${ACCENT};font-size:16px;font-weight:700;line-height:44px;text-align:center">${esc(initials(actor.name))}</div></td>`;
  const quote = message
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr><td style="border-left:3px solid ${ACCENT};background:#f6f8fd;border-radius:0 8px 8px 0;padding:14px 18px;font-size:15px;line-height:24px;color:${INK};white-space:pre-wrap">${esc(message)}<div style="margin-top:8px;font-size:13px;color:${MUTED}">— ${esc(firstName(actor.name))}</div></td></tr></table>`
    : '';
  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border:1px solid #e5e7eb;border-radius:10px"><tr><td style="padding:18px 20px">
<div style="font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:#8a94a3">Page partagée</div>
<div style="margin-top:4px;font-size:18px;line-height:26px;font-weight:700;color:${INK}">${esc(page.title)}</div>
${description ? `<div style="margin-top:6px;font-size:14px;line-height:21px;color:${MUTED}">${esc(description)}</div>` : ''}
</td></tr></table>`;
  const body = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${avatar}<td valign="middle">
<div style="font-size:17px;line-height:24px;color:${INK}"><strong>${esc(actor.name)}</strong> vous invite à consulter une page</div>
<div style="font-size:13px;line-height:20px;color:${MUTED}">${esc(actor.email)}</div>
</td></tr></table>
${quote}
${card}
${button('Consulter la page', url)}
<p style="margin:14px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${esc(access)} Vous pourrez la lire et y laisser vos commentaires, sur l’ensemble ou sur un passage précis.</p>
<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #eef0f3;font-size:12px;line-height:18px;color:#8a94a3">Le bouton ne s’ouvre pas ? Copiez ce lien dans votre navigateur :<br><a href="${esc(url)}" style="color:${ACCENT};word-break:break-all">${esc(url)}</a></p>`;
  const footer = `Vous recevez ce message parce que ${esc(actor.name)} a partagé une page avec ${esc(to)} sur Skipper. Répondez à cet e-mail pour lui écrire directement.`;
  return { subject, text, html: layout({ preheader, body, footer, title: subject }), fromName: `${actor.name} via Skipper`, replyTo: actor.email };
}

/** Lien de connexion demandé par un invité depuis la page de connexion. */
export function loginLinkEmail(input: { name: string; to: string; url: string; minutes: number }): { subject: string; text: string; html: string } {
  const subject = 'Votre lien de connexion à Skipper';
  const hello = input.name && input.name !== input.to ? `Bonjour ${firstName(input.name)},` : 'Bonjour,';
  const text = [
    hello,
    '',
    `Voici votre lien pour vous connecter à Skipper et retrouver les pages partagées avec vous (valable ${input.minutes} minutes) :`,
    input.url,
    '',
    "Si vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message : personne ne peut se connecter sans ce lien.",
  ].join('\n');
  const body = `<p style="margin:0;font-size:17px;line-height:24px;font-weight:600">${esc(hello)}</p>
<p style="margin:12px 0 0">Voici votre lien pour vous connecter à Skipper et retrouver les pages partagées avec vous.</p>
${button('Me connecter', input.url)}
<p style="margin:14px 0 0;font-size:13px;line-height:20px;color:${MUTED}">Ce lien est valable ${input.minutes} minutes et vous est personnel. Si vous n’êtes pas à l’origine de cette demande, ignorez simplement ce message : personne ne peut se connecter sans ce lien.</p>
<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #eef0f3;font-size:12px;line-height:18px;color:#8a94a3">Le bouton ne s’ouvre pas ? Copiez ce lien dans votre navigateur :<br><a href="${esc(input.url)}" style="color:${ACCENT};word-break:break-all">${esc(input.url)}</a></p>`;
  return { subject, text, html: layout({ preheader: 'Un clic pour retrouver les pages partagées avec vous.', body, footer: `Envoyé à ${esc(input.to)} à sa demande, depuis la page de connexion de Skipper.`, title: subject }) };
}
