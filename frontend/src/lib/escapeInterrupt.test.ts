import { describe, expect, it } from 'vitest';
import { DOUBLE_ESCAPE_MS, OVERLAY_SELECTOR, nextEscape, overlayOpen } from './escapeInterrupt';

describe('nextEscape', () => {
  it('le premier Échap arme sans interrompre', () => {
    expect(nextEscape(null, 1000)).toEqual({ fire: false, armedAt: 1000 });
  });

  it('un second Échap rapproché interrompt et désarme', () => {
    expect(nextEscape(1000, 1000 + DOUBLE_ESCAPE_MS)).toEqual({ fire: true, armedAt: null });
  });

  it('un second Échap trop tardif ré-arme seulement', () => {
    expect(nextEscape(1000, 1001 + DOUBLE_ESCAPE_MS)).toEqual({ fire: false, armedAt: 1001 + DOUBLE_ESCAPE_MS });
  });

  it('trois Échap rapprochés n’interrompent qu’une fois', () => {
    let s = nextEscape(null, 0);
    s = nextEscape(s.armedAt, 100);
    expect(s.fire).toBe(true);
    s = nextEscape(s.armedAt, 200);
    expect(s.fire).toBe(false);
  });
});

describe('overlayOpen', () => {
  const root = (match: boolean) => ({ querySelector: (sel: string) => (sel === OVERLAY_SELECTOR && match ? ({} as Element) : null) });

  it('détecte un panneau ouvert', () => {
    expect(overlayOpen(root(true))).toBe(true);
    expect(overlayOpen(root(false))).toBe(false);
  });

  it('couvre fenêtres, menus, recherche, notifications et autocomplétion', () => {
    for (const s of ['.modal', '[role="dialog"]', '[role="menu"]', '[role="listbox"]', '.wb-pop', '.wb-notif-panel']) expect(OVERLAY_SELECTOR).toContain(s);
  });
});
