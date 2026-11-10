import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asciiOnly, commentClientScript, injectCommentScript, injectSlidesScript, slidesClientScript } from './inject.js';

// Script des commentaires ancrés, injecté en ligne dans les pages partagées servies dans l'application.
describe('injection du script des commentaires', () => {
  it('ajoute le script avant </body>, sinon </html>, sinon à la fin, une seule fois', () => {
    expect(injectCommentScript('<html><body><p>a</p></body></html>', 'S')).toBe('<html><body><p>a</p><script data-skipper-comments>S</script></body></html>');
    expect(injectCommentScript('<html><p>a</HTML>', 'S')).toBe('<html><p>a<script data-skipper-comments>S</script></HTML>');
    expect(injectCommentScript('<p>a', 'S')).toBe('<p>a<script data-skipper-comments>S</script>');
    const once = injectCommentScript('<body></body>', 'S');
    expect(injectCommentScript(once, 'S')).toBe(once);
  });

  it('le script client est du JavaScript valide, servi en ASCII, sans fin de balise script, inactif hors cadre', () => {
    const file = fileURLToPath(new URL('./comment-client.js', import.meta.url));
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('__skipperComments');
    expect(source).toContain('window.parent === window');
    expect(source).not.toMatch(/<\/script/i);
    execFileSync(process.execPath, ['--check', file]);
    const served = commentClientScript();
    expect(served).toMatch(/^[\x00-\x7f]*$/);
    expect(served).not.toMatch(/<\/script/i);
    expect(asciiOnly('é')).toBe('\\u00e9');
  });
});

// Lecteur de diapositives (artefacts « slides »), injecté avant </body> avec son mode.
describe('injection du lecteur de diapositives', () => {
  it('ajoute le lecteur avant </body> avec le mode, une seule fois', () => {
    const out = injectSlidesScript('<html><body><section class="slide">a</section></body></html>', 'thumb', 'S');
    expect(out).toBe('<html><body><section class="slide">a</section><script data-skipper-slides data-mode="thumb">S</script></body></html>');
    expect(injectSlidesScript(out, 'view', 'S')).toBe(out);
  });

  it('le lecteur est du JavaScript valide, en ASCII, sans fin de balise script', () => {
    const file = fileURLToPath(new URL('./slides-client.js', import.meta.url));
    execFileSync(process.execPath, ['--check', file]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/<\/script/i);
    expect(slidesClientScript()).toMatch(/^[\x00-\x7f]*$/);
  });
});
