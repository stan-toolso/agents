import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Réglages en mémoire, chiffrement transparent : seul l'appel à Brevo compte ici.
const store = new Map<string, unknown>();
vi.mock('../settings/repository.js', () => ({
  settingsRepository: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: unknown) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  },
}));
vi.mock('../settings/crypto.js', () => ({ encryptSecret: (s: string) => `enc:${s}`, decryptSecret: (s: string) => s.replace(/^enc:/, '') }));

const { mailService, parseSender, brevoPayload, DEFAULT_FROM } = await import('./mail.js');

const fetchMock = vi.fn();
beforeEach(() => {
  store.clear();
  delete process.env.BREVO_API_KEY;
  delete process.env.MAIL_FROM;
  mailService.reset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ messageId: '<x@brevo>' }), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('parseSender', () => {
  it('lit « Nom <adresse> » et une adresse seule', () => {
    expect(parseSender('Skipper <skipper@toolso.io>')).toEqual({ name: 'Skipper', email: 'skipper@toolso.io' });
    expect(parseSender('"Équipe Skipper" <skipper@toolso.io>')).toEqual({ name: 'Équipe Skipper', email: 'skipper@toolso.io' });
    expect(parseSender('skipper@toolso.io')).toEqual({ email: 'skipper@toolso.io' });
    expect(parseSender('pas une adresse')).toBeNull();
  });
});

describe('brevoPayload', () => {
  it('construit le corps de /v3/smtp/email', () => {
    expect(brevoPayload(DEFAULT_FROM, { to: 'a@b.fr', subject: 'S', text: 'T', html: '<p>T</p>' })).toEqual({
      sender: { name: 'Skipper', email: 'skipper@toolso.io' },
      to: [{ email: 'a@b.fr' }],
      subject: 'S',
      textContent: 'T',
      htmlContent: '<p>T</p>',
    });
  });
});

describe('mailService', () => {
  it("n'est pas configuré sans clé", async () => {
    expect(await mailService.configured()).toBe(false);
    await expect(mailService.send({ to: 'a@b.fr', subject: 'S', text: 'T' })).rejects.toThrow(/non configuré/);
  });

  it('envoie par Brevo avec la clé de BREVO_API_KEY et l’expéditeur par défaut', async () => {
    process.env.BREVO_API_KEY = 'xkeysib-env-1234';
    await mailService.send({ to: 'a@b.fr', subject: 'Sujet', text: 'Texte' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('xkeysib-env-1234');
    expect(JSON.parse(init.body)).toMatchObject({ sender: { email: 'skipper@toolso.io' }, to: [{ email: 'a@b.fr' }], subject: 'Sujet', textContent: 'Texte' });
    expect(await mailService.view()).toMatchObject({ source: 'env', from: DEFAULT_FROM, apiKeyHint: '1234' });
  });

  it("remonte l'erreur de Brevo", async () => {
    process.env.BREVO_API_KEY = 'k';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 }));
    await expect(mailService.send({ to: 'a@b.fr', subject: 'S', text: 'T' })).rejects.toThrow('Brevo HTTP 401 : Key not found (unauthorized)');
  });

  it('vérifie la clé auprès de Brevo, la chiffre et la garde si elle est absente ensuite', async () => {
    const view = await mailService.update({ apiKey: 'xkeysib-abcd', from: 'Skipper <skipper@toolso.io>' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.brevo.com/v3/account');
    expect(store.get('mail')).toEqual({ apiKey: 'enc:xkeysib-abcd', from: 'Skipper <skipper@toolso.io>' });
    expect(view).toMatchObject({ source: 'settings', hasApiKey: true, apiKeyHint: 'abcd' });
    fetchMock.mockClear();
    await mailService.update({ apiKey: null, from: 'skipper@toolso.io' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get('mail')).toEqual({ apiKey: 'enc:xkeysib-abcd', from: 'skipper@toolso.io' });
    expect(await mailService.configured()).toBe(true);
  });

  it('refuse une clé rejetée par Brevo, une clé manquante et un expéditeur invalide', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Key not found"}', { status: 401 }));
    await expect(mailService.update({ apiKey: 'mauvaise', from: '' })).rejects.toThrow(/refusée par Brevo/);
    await expect(mailService.update({ from: '' })).rejects.toThrow(/requise/);
    await expect(mailService.update({ apiKey: 'k', from: 'n’importe quoi' })).rejects.toThrow(/expéditeur/);
    expect(store.has('mail')).toBe(false);
  });

  it('refuse de modifier quand la variable d’environnement fixe la clé', async () => {
    process.env.BREVO_API_KEY = 'k';
    await expect(mailService.update({ apiKey: 'autre', from: '' })).rejects.toThrow(/BREVO_API_KEY/);
  });
});
