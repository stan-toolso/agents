import { describe, expect, it } from 'vitest';
import { detectProjectWindow, projectWindowRoute } from './projectWindow';

const P = '11111111-2222-3333-4444-555555555555';
const Q = '99999999-2222-3333-4444-555555555555';

function fakeWindow(url: string, name = '') {
  const u = new URL(url, 'https://skipper.test');
  const win = {
    name,
    location: { search: u.search, pathname: u.pathname, hash: u.hash },
    history: { state: null, replaced: '' as string, replaceState(_s: unknown, _t: string, next: string) { win.history.replaced = next; } },
  };
  return win;
}

describe('detectProjectWindow', () => {
  it('pose le nom de la fenêtre depuis le paramètre et le retire de l’adresse', () => {
    const win = fakeWindow(`/projects/${P}?tab=x&projectWindow=${P}`);
    expect(detectProjectWindow(win as never)).toBe(P);
    expect(win.name).toBe(`skipper-project:${P}`);
    expect(win.history.replaced).toBe(`/projects/${P}?tab=x`);
  });
  it('garde le projet d’un rechargement par le nom de la fenêtre', () => {
    expect(detectProjectWindow(fakeWindow('/inbox', `skipper-project:${P}`) as never)).toBe(P);
  });
  it('Skipper complet sans nom ni paramètre, ou avec un identifiant invalide', () => {
    expect(detectProjectWindow(fakeWindow('/') as never)).toBeNull();
    expect(detectProjectWindow(fakeWindow('/?projectWindow=..%2Fusers') as never)).toBeNull();
    expect(detectProjectWindow(fakeWindow('/', 'autre-fenetre') as never)).toBeNull();
  });
});

describe('projectWindowRoute', () => {
  it('remplace les pages globales par celles du projet', () => {
    expect(projectWindowRoute('/', P)).toEqual({ redirect: `/projects/${P}` });
    expect(projectWindowRoute('/tasks', P)).toEqual({ redirect: `/projects/${P}/tasks` });
    expect(projectWindowRoute('/shared/', P)).toEqual({ redirect: `/projects/${P}/artifacts` });
    expect(projectWindowRoute('/sessions', P)).toEqual({ redirect: `/projects/${P}/history` });
    expect(projectWindowRoute('/requests', P)).toEqual({ redirect: '/inbox' });
  });
  it('signale les pages d’un autre projet, des chats et de l’administration', () => {
    expect(projectWindowRoute(`/projects/${Q}/tasks`, P)).toEqual({ foreign: true });
    expect(projectWindowRoute('/projects/new', P)).toEqual({ foreign: true });
    expect(projectWindowRoute(`/chats/${Q}`, P)).toEqual({ foreign: true });
    expect(projectWindowRoute('/users', P)).toEqual({ foreign: true });
  });
  it('laisse les pages du projet et les pages communes', () => {
    for (const path of [`/projects/${P}`, `/projects/${P}/conversations/general`, `/sessions/${Q}`, `/tasks/${Q}`, '/inbox', '/settings']) expect(projectWindowRoute(path, P)).toBeNull();
  });
});
