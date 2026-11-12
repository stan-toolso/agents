import { ACCENT, INK, MUTED, button, esc, firstName, initials, layout } from '../sharedPages/emails.js';

export interface ProjectInviteEmailInput {
  actor: { name: string; email: string };
  project: { name: string; description?: string | null };
  /** Adresse du destinataire. */
  to: string;
  /** Mot d'accueil de la personne qui invite (facultatif). */
  message?: string | null;
  /** Lien du bouton : connexion directe pour un compte restreint, sinon les conversations du projet. */
  url: string;
  /** Lien de connexion directe : durée de validité en jours (null : la personne se connecte comme d'habitude). */
  directLoginDays: number | null;
}

/**
 * Invitation à rejoindre les conversations d'un projet (rôle invité), fonction pure : même gabarit que l'e-mail de
 * partage d'une page (sharedPages/emails.ts), avec le mot de la personne qui invite et ce que l'invité pourra faire.
 */
export function projectGuestInviteEmail(input: ProjectInviteEmailInput): { subject: string; text: string; html: string; fromName: string; replyTo: string } {
  const { actor, project, to, url, directLoginDays } = input;
  const message = input.message?.trim() || null;
  const description = project.description?.trim() || null;
  const subject = `${actor.name} vous invite à rejoindre les conversations de « ${project.name} »`;
  const preheader = message ? message.replace(/\s+/g, ' ').slice(0, 140) : `Rejoignez l'équipe de ${project.name} sur Skipper pour discuter avec elle et ses agents.`;
  const access = directLoginDays
    ? `Aucun compte à créer, aucun mot de passe à retenir : le bouton vous connecte directement avec votre adresse ${to}. Ce lien vous est personnel et reste valable ${directLoginDays} jours ; ne le transférez pas.`
    : `Connectez-vous avec votre adresse ${to}, comme d'habitude.`;
  const what = "Vous pourrez lire les canaux de discussion du projet, y écrire, répondre dans les fils, réagir, joindre des fichiers et interpeller les personnes et les agents de l'équipe en les mentionnant (@Nom). Les artefacts (pages, tableaux de bord) qu'on vous partage vous attendront au même endroit.";
  const text = [
    `${actor.name} (${actor.email}) vous invite à rejoindre les conversations du projet « ${project.name} » sur Skipper.`,
    ...(description ? ['', description] : []),
    ...(message ? ['', `Le mot de ${firstName(actor.name)} :`, ...message.split('\n').map((l) => `> ${l}`)] : []),
    '',
    `Rejoindre les conversations : ${url}`,
    '',
    access,
    what,
    '',
    '—',
    `Vous recevez ce message parce que ${actor.name} vous a invité sur Skipper avec l'adresse ${to}. Répondez à cet e-mail pour lui écrire directement.`,
  ].join('\n');

  const avatar = `<td width="44" valign="top" style="padding-right:14px"><div style="width:44px;height:44px;border-radius:22px;background:#e8eefc;color:${ACCENT};font-size:16px;font-weight:700;line-height:44px;text-align:center">${esc(initials(actor.name))}</div></td>`;
  const quote = message
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr><td style="border-left:3px solid ${ACCENT};background:#f6f8fd;border-radius:0 8px 8px 0;padding:14px 18px;font-size:15px;line-height:24px;color:${INK};white-space:pre-wrap">${esc(message)}<div style="margin-top:8px;font-size:13px;color:${MUTED}">— ${esc(firstName(actor.name))}</div></td></tr></table>`
    : '';
  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border:1px solid #e5e7eb;border-radius:10px"><tr><td style="padding:18px 20px">
<div style="font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:#8a94a3">Projet</div>
<div style="margin-top:4px;font-size:18px;line-height:26px;font-weight:700;color:${INK}">${esc(project.name)}</div>
${description ? `<div style="margin-top:6px;font-size:14px;line-height:21px;color:${MUTED}">${esc(description)}</div>` : ''}
</td></tr></table>`;
  const body = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${avatar}<td valign="middle">
<div style="font-size:17px;line-height:24px;color:${INK}"><strong>${esc(actor.name)}</strong> vous invite à rejoindre les conversations d’un projet</div>
<div style="font-size:13px;line-height:20px;color:${MUTED}">${esc(actor.email)}</div>
</td></tr></table>
${quote}
${card}
${button('Rejoindre les conversations', url)}
<p style="margin:14px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${esc(access)}</p>
<p style="margin:10px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${esc(what)}</p>
<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #eef0f3;font-size:12px;line-height:18px;color:#8a94a3">Le bouton ne s’ouvre pas ? Copiez ce lien dans votre navigateur :<br><a href="${esc(url)}" style="color:${ACCENT};word-break:break-all">${esc(url)}</a></p>`;
  const footer = `Vous recevez ce message parce que ${esc(actor.name)} vous a invité sur Skipper avec l’adresse ${esc(to)}. Répondez à cet e-mail pour lui écrire directement.`;
  return { subject, text, html: layout({ preheader, body, footer, title: subject }), fromName: `${actor.name} via Skipper`, replyTo: actor.email };
}
