import { describe, expect, it } from 'vitest';
import { projectGuestInviteEmail } from './invitationEmail.js';

const base = { actor: { name: 'Stan Giraudet', email: 'stan@toolso.io' }, project: { name: 'Skipper', description: 'Agents <en> équipe' }, to: 'claire@client.fr' };

describe("e-mail d'invitation aux conversations d'un projet", () => {
  it('cite le projet, le mot de la personne et le lien de connexion directe', () => {
    const mail = projectGuestInviteEmail({ ...base, message: 'Bienvenue à bord !', url: 'https://skipper.test/auth/link/abc', directLoginDays: 30 });
    expect(mail.subject).toBe('Stan Giraudet vous invite à rejoindre les conversations de « Skipper »');
    expect(mail.text).toContain('> Bienvenue à bord !');
    expect(mail.text).toContain('valable 30 jours');
    expect(mail.html).toContain('Agents &lt;en&gt; équipe');
    expect(mail.html).toContain('https://skipper.test/auth/link/abc');
    expect(mail.replyTo).toBe('stan@toolso.io');
    expect(mail.fromName).toBe('Stan Giraudet via Skipper');
  });

  it('sans lien direct, invite à se connecter comme d’habitude', () => {
    const mail = projectGuestInviteEmail({ ...base, url: 'https://skipper.test/projects/p/conversations', directLoginDays: null });
    expect(mail.text).toContain('comme d\'habitude');
    expect(mail.text).not.toContain('Le mot de');
  });
});
