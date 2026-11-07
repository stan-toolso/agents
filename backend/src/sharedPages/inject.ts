import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Script des commentaires ancrés, injecté en ligne dans chaque page partagée servie dans l'application (voir
 * `comment-client.js`). En ASCII seulement (accents échappés en \uXXXX) : il s'exécute correctement même dans une
 * page sans encodage déclaré, que le navigateur lirait en Latin-1. Pas de `</script>` possible dans le script lui-même
 * (vérifié par le test) : il peut donc être inséré en ligne sans échappement.
 */
const MARKER = 'data-skipper-comments';
/** Page plus grosse que ça : servie telle quelle, sans script (on ne la met pas en mémoire pour la réécrire). */
export const INJECT_MAX_BYTES = 5 * 1024 * 1024;

export const asciiOnly = (js: string) => js.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

let clientScript: string | null = null;
export function commentClientScript(): string {
  clientScript ??= asciiOnly(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'comment-client.js'), 'utf8'));
  return clientScript;
}

/** Ajoute le script en ligne à une page HTML (avant `</body>`, sinon `</html>`, sinon à la fin), une seule fois. */
export function injectCommentScript(html: string, script = commentClientScript()): string {
  if (html.includes(MARKER)) return html;
  const tag = `<script ${MARKER}>${script}</script>`;
  for (const close of [/<\/body\s*>/i, /<\/html\s*>/i]) {
    const m = close.exec(html);
    if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
  }
  return html + tag;
}
