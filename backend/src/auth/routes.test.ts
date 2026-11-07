import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';

// Service de connexion et sessions simulés : on vérifie le contrat HTTP des routes, pas la base.
const signIn = vi.hoisted(() => ({
  availableMethods: vi.fn(async () => ({ google: true, microsoft: false, github: true, password: true, passwordReset: false })),
  loginWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(async () => undefined),
  userOfToken: vi.fn(async () => null),
  resetPassword: vi.fn(),
}));
vi.mock('./signInService.js', () => ({ signInService: signIn }));
vi.mock('./session.js', () => ({
  SESSION_COOKIE: 'skipper_session',
  readCookie: () => null,
  authSession: { create: async () => 'jeton', resolve: async () => null, destroy: async () => undefined, cookie: (t: string | null) => `skipper_session=${t ?? ''}; Path=/; HttpOnly` },
}));

const { handleAuthRoute } = await import('./routes.js');

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handleAuthRoute(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });

describe("routes d'authentification", () => {
  it('liste les modes de connexion offerts', async () => {
    expect(await (await fetch(`${base}/auth/methods`)).json()).toEqual({ google: true, microsoft: false, github: true, password: true, passwordReset: false });
  });

  it('connexion par mot de passe : pose le cookie de session', async () => {
    signIn.loginWithPassword.mockResolvedValueOnce({ id: 'u1', email: 'a@x.fr' });
    const res = await post('/auth/password/login', { email: 'a@x.fr', password: 'secret secret' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('skipper_session=jeton');
  });

  it('mauvais mot de passe : 401 sans cookie ; trop d’essais : 429', async () => {
    signIn.loginWithPassword.mockRejectedValueOnce(new AppError('Adresse e-mail ou mot de passe incorrect', 'INVALID_CREDENTIALS'));
    const res = await post('/auth/password/login', { email: 'a@x.fr', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    signIn.loginWithPassword.mockRejectedValueOnce(new AppError('Trop', 'TOO_MANY_ATTEMPTS'));
    expect((await post('/auth/password/login', { email: 'a@x.fr', password: 'x' })).status).toBe(429);
  });

  it("refuse un formulaire « simple » et une origine étrangère (connexion forcée depuis un autre site)", async () => {
    signIn.loginWithPassword.mockClear();
    const form = await fetch(`${base}/auth/password/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
    expect(form.status).toBe(400);
    expect((await post('/auth/password/login', { email: 'a', password: 'b' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(signIn.loginWithPassword).not.toHaveBeenCalled();
  });

  it('« mot de passe oublié » répond 204 dans tous les cas', async () => {
    expect((await post('/auth/password/forgot', { email: 'inconnu@x.fr' })).status).toBe(204);
    expect(signIn.requestPasswordReset).toHaveBeenCalledWith('inconnu@x.fr');
  });

  it('fournisseur non configuré : retour à la page de connexion avec une erreur', async () => {
    const res = await fetch(`${base}/auth/microsoft?next=/projects`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('authError=not_configured');
  });
});
