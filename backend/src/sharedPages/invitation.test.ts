import { describe, expect, it } from 'vitest';
import { invitationEmail } from './service.js';

describe("e-mail d'invitation à une page partagée", () => {
  it('donne le lien de la page et le compte Google à utiliser, échappé en HTML', () => {
    const mail = invitationEmail({ name: 'Stan <Toolso>', email: 'stan@toolso.io' }, { id: 'p1', title: 'Offre & prix' }, 'client@gmail.com', 'https://skipper.example/');
    expect(mail.subject).toBe('Stan <Toolso> vous a partagé « Offre & prix »');
    expect(mail.text).toContain('https://skipper.example/shared/p1');
    expect(mail.text).toContain('client@gmail.com');
    expect(mail.html).toContain('href="https://skipper.example/shared/p1"');
    expect(mail.html).toContain('Stan &lt;Toolso&gt;');
    expect(mail.html).toContain('Offre &amp; prix');
  });
});
