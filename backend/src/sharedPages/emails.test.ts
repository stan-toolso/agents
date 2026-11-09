import { describe, expect, it } from 'vitest';
import { initials, loginLinkEmail, pageShareEmail } from './emails.js';

const base = { actor: { name: 'Stan <Toolso>', email: 'stan@toolso.io' }, page: { title: 'Offre & prix', description: 'Proposition 2027' }, to: 'client@gmail.com', url: 'https://skipper.example/auth/link/abc' };

describe('e-mail de partage d’une page', () => {
  it('reprend le message, la page et le lien, échappés en HTML', () => {
    const mail = pageShareEmail({ ...base, message: 'Bonjour Claire,\nvoici la <b>proposition</b>.', directLoginDays: 30 });
    expect(mail.subject).toBe('Stan <Toolso> vous invite à consulter « Offre & prix »');
    expect(mail.fromName).toBe('Stan <Toolso> via Skipper');
    expect(mail.replyTo).toBe('stan@toolso.io');
    expect(mail.text).toContain('> voici la <b>proposition</b>.');
    expect(mail.text).toContain('Consulter la page : https://skipper.example/auth/link/abc');
    expect(mail.text).toContain('Aucun compte à créer');
    expect(mail.text).toContain('30 jours');
    expect(mail.html).toContain('href="https://skipper.example/auth/link/abc"');
    expect(mail.html).toContain('Stan &lt;Toolso&gt;');
    expect(mail.html).toContain('Offre &amp; prix');
    expect(mail.html).toContain('voici la &lt;b&gt;proposition&lt;/b&gt;.');
    expect(mail.html).not.toContain('<b>proposition');
  });

  it('sans message ni connexion directe : la description en aperçu, connexion habituelle', () => {
    const mail = pageShareEmail({ ...base, message: '  ', directLoginDays: null });
    expect(mail.text).not.toContain('Le mot de');
    expect(mail.text).toContain('comme d\'habitude');
    expect(mail.html).toContain('Proposition 2027');
  });

  it('initiales et lien de connexion', () => {
    expect(initials('Stanislas Giraudet')).toBe('SG');
    expect(initials('élodie')).toBe('É');
    expect(initials('')).toBe('?');
    const mail = loginLinkEmail({ name: 'claire@client.fr', to: 'claire@client.fr', url: 'https://x/auth/link/t', minutes: 60 });
    expect(mail.text.startsWith('Bonjour,')).toBe(true);
    expect(mail.html).toContain('href="https://x/auth/link/t"');
  });
});
