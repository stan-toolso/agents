import { describe, expect, it } from 'vitest';
import { injectDataScript, injectEmbed, widgetClientScript } from '../sharedPages/inject.js';
import { EMBED_THEMES, embedStyle, parseEmbedRegion, parseEmbedTheme } from './embedTheme.js';

describe('thème des blocs', () => {
  it('a les mêmes variables en clair et en sombre', () => {
    expect(Object.keys(EMBED_THEMES.dark).sort()).toEqual(Object.keys(EMBED_THEMES.light).sort());
    expect(parseEmbedTheme('dark')).toBe('dark');
    expect(parseEmbedTheme('autre')).toBe('light');
    expect(embedStyle('dark')).toContain('--cc-accent:#e5865f');
    expect(embedStyle('light')).toContain('color-scheme:light');
  });

  it('transmet la région du bloc si elle est connue', () => {
    expect(parseEmbedRegion('tiles')).toBe('tiles');
    expect(parseEmbedRegion('side')).toBe('side');
    expect(parseEmbedRegion('ailleurs')).toBeNull();
    expect(parseEmbedRegion(null)).toBeNull();
  });
});

describe('injectEmbed', () => {
  const ctx = { scope: 'project:x', params: { a: 1 }, viewer: { id: 'u', name: 'A' }, project: null, theme: 'light' };
  it('met le style et le contexte en tête, le script avant </body>, une seule fois', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>';
    const out = injectEmbed(html, { style: 'body{margin:0}', context: ctx }, 'console.log(1)');
    expect(out.indexOf('data-skipper-embed')).toBeLessThan(out.indexOf('<title>'));
    expect(out).toContain('window.Skipper.context={"scope":"project:x"');
    expect(out).toContain('<script data-skipper-widget>console.log(1)</script></body>');
    expect(injectEmbed(out, { style: '', context: ctx }, 'x')).toBe(out);
  });
  it('pose data-region sur <html> pour qu’une page en tuile se dessine compacte', () => {
    const out = injectEmbed('<html><head></head><body></body></html>', { style: '', context: { ...ctx, region: 'tiles' } }, 'x');
    expect(out).toContain('"region":"tiles"');
    expect(out).toContain('document.documentElement.setAttribute("data-region"');
  });
  it('se place après le script des données, qui crée window.Skipper', () => {
    const html = injectDataScript('<html><head></head><body></body></html>', { data: { n: 1 }, meta: {} });
    const out = injectEmbed(html, { style: '', context: ctx }, 'x');
    expect(out.indexOf('data-skipper-data')).toBeLessThan(out.indexOf('data-skipper-embed'));
    expect(out).toContain('window.Skipper=window.Skipper||');
  });
  it('échappe le contexte pour un script en ligne', () => {
    const out = injectEmbed('<html><head></head><body></body></html>', { style: '', context: { ...ctx, params: { t: '</script><b>' } } }, 'x');
    expect(out).not.toContain('</script><b>');
  });
  it('le script d’intégration est en ASCII et sans fin de balise script', () => {
    const js = widgetClientScript();
    expect(/^[\x00-\x7f]*$/.test(js)).toBe(true);
    expect(js.includes('</script')).toBe(false);
    expect(js).toContain('skipperWidget');
  });
});
