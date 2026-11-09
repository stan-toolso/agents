import { describe, expect, it, vi } from 'vitest';

vi.mock('./mail.js', () => ({ mailService: { send: vi.fn() } }));
const { discordPayload, emailContent, slackPayload, validateTarget } = await import('./transports.js');

const item = { title: '« Revue » attend votre autorisation', message: 'Bash: rm -rf <dist> & co', url: 'https://skipper.example/sessions/s1', projectName: 'Skipper' };

describe('cibles des canaux', () => {
  it('accepte les webhooks Slack et Discord et masque leur secret', () => {
    expect(validateTarget('slack', ' https://hooks.slack.com/services/T000/B000/XXXXabcd ')).toEqual({ target: 'https://hooks.slack.com/services/T000/B000/XXXXabcd', hint: 'hooks.slack.com/…abcd' });
    expect(validateTarget('discord', 'https://discord.com/api/webhooks/123/tok-en_1').hint).toBe('discord.com/…en_1');
    expect(validateTarget('email', 'ana@exemple.fr').hint).toBe('ana@exemple.fr');
  });

  it('refuse toute autre adresse (pas de requête vers un hôte arbitraire)', () => {
    expect(() => validateTarget('slack', 'https://evil.example/services/x')).toThrow();
    expect(() => validateTarget('slack', 'http://hooks.slack.com/services/x')).toThrow();
    expect(() => validateTarget('discord', 'https://discord.com.evil.example/api/webhooks/1/x')).toThrow();
    expect(() => validateTarget('email', 'pas-une-adresse')).toThrow();
  });
});

describe('mise en forme', () => {
  it('Slack : lien sur le titre, caractères de contrôle échappés', () => {
    const { text } = slackPayload([item]);
    expect(text).toBe('*<https://skipper.example/sessions/s1|[Skipper] « Revue » attend votre autorisation>*\nBash: rm -rf &lt;dist&gt; &amp; co');
  });

  it('Slack : un lot devient une liste', () => {
    const { text } = slackPayload([item, { ...item, title: 'Tâche terminée', message: null }]);
    expect(text.split('\n')[0]).toBe('*2 notifications Skipper*');
    expect(text).toContain('• *<https://skipper.example/sessions/s1|[Skipper] Tâche terminée>*');
  });

  it('Discord : lien Markdown, mentions désactivées, 2000 caractères au plus', () => {
    const p = discordPayload([item]);
    expect(p.content.startsWith('**[\\[Skipper\\] « Revue » attend votre autorisation](<https://skipper.example/sessions/s1>)**')).toBe(true);
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(discordPayload(Array.from({ length: 50 }, () => ({ ...item, message: 'x'.repeat(500) }))).content.length).toBeLessThanOrEqual(2000);
  });

  it('e-mail : objet, texte et HTML échappé', () => {
    const mail = emailContent([item]);
    expect(mail.subject).toBe('[Skipper] « Revue » attend votre autorisation');
    expect(mail.text).toContain('https://skipper.example/sessions/s1');
    expect(mail.html).toContain('&lt;dist&gt; &amp; co');
    expect(emailContent([item, item]).subject).toBe('2 notifications Skipper');
  });
});
