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

const DATA_MARKER = 'data-skipper-data';

/** JSON sûr dans un `<script>` en ligne : ni `</script>`, ni séparateurs de ligne Unicode. */
export const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));

/**
 * Artefact de données : les données des sources sont injectées **en tête** de la page (après `<head>`, sinon tout au
 * début), avant tout script de la page, comme `window.Skipper` : `Skipper.data.<source>` (résultat de la source :
 * `{ columns, rows }` pour une requête SQL, le JSON produit par un script), `Skipper.meta` (état des sources, date du
 * rafraîchissement) et `Skipper.ready(fn)` qui appelle `fn(data, meta)` une fois le DOM chargé. Le cadre est en bac à
 * sable sans origine : la page ne peut rien charger de Skipper elle-même, d'où l'injection.
 */
export function injectDataScript(html: string, payload: { data: Record<string, unknown>; meta: unknown }): string {
  if (html.includes(DATA_MARKER)) return html;
  const tag = `<script ${DATA_MARKER}>window.Skipper={data:${jsonForScript(payload.data)},meta:${jsonForScript(payload.meta)},ready:function(f){var r=function(){f(window.Skipper.data,window.Skipper.meta)};document.readyState==="loading"?document.addEventListener("DOMContentLoaded",r):r()}};</script>`;
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  return tag + html;
}

const SLIDES_MARKER = 'data-skipper-slides';
let slidesScript: string | null = null;
export function slidesClientScript(): string {
  slidesScript ??= asciiOnly(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'slides-client.js'), 'utf8'));
  return slidesScript;
}

export type SlidesMode = 'view' | 'thumb' | 'print';

/**
 * Artefact « diapositives » : le lecteur (slides-client.js) est injecté **avant `</body>`** (il attend le DOM), une seule
 * fois, avec son mode : `view` (une diapositive à la fois, navigation), `thumb` (première diapositive, pour l'aperçu
 * réduit) ou `print` (toutes, une page chacune, puis impression : l'export PDF).
 */
export function injectSlidesScript(html: string, mode: SlidesMode = 'view', script = slidesClientScript()): string {
  if (html.includes(SLIDES_MARKER)) return html;
  const tag = `<script ${SLIDES_MARKER} data-mode="${mode}">${script}</script>`;
  for (const close of [/<\/body\s*>/i, /<\/html\s*>/i]) {
    const m = close.exec(html);
    if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
  }
  return html + tag;
}

const EMBED_MARKER = 'data-skipper-embed';
const WIDGET_MARKER = 'data-skipper-widget';
let widgetScript: string | null = null;
export function widgetClientScript(): string {
  widgetScript ??= asciiOnly(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'widget-client.js'), 'utf8'));
  return widgetScript;
}

/**
 * Artefact affiché comme bloc d'un tableau de bord (`embed=1`) : une feuille de style de base (variables du thème de
 * Skipper, fond transparent, marges nulles) et le contexte du bloc (`window.Skipper.context` : personne, projet,
 * portée, paramètres du bloc, thème) sont injectés **en tête** (après `<head>`, sinon tout au début), après l'éventuel
 * script des données (qui crée `window.Skipper`) ; le script d'intégration (widget-client.js : hauteur au contenu,
 * actions vers l'hôte) est injecté **avant `</body>`**. Une seule fois chacun.
 */
export function injectEmbed(html: string, payload: { style: string; context: unknown }, script = widgetClientScript()): string {
  let out = html;
  if (!out.includes(EMBED_MARKER)) {
    // L'API du bloc (contexte, onContext, actions vers l'hôte) est définie ici, avant tout script de la page ; le script
    // d'intégration en fin de page ne fait que mesurer la hauteur et recevoir les mises à jour du contexte.
    const api = `(function(S){var L=S._ctxListeners=[];S.onContext=function(f){L.push(f)};function send(m){m.skipperWidget=1;window.parent.postMessage(m,"*")}S.navigate=function(to){send({type:"action",action:"navigate",to:String(to||"")})};S.openSession=function(o){o=o||{};send({type:"action",action:"openSession",prompt:String(o.prompt||""),projectId:o.projectId?String(o.projectId):null})};S.summon=function(o){o=o||{};send({type:"action",action:"summon",agent:String(o.agent||""),text:String(o.text||"")})}})(window.Skipper);`;
    const head = `<style ${EMBED_MARKER}>${payload.style}</style><script ${EMBED_MARKER}>window.Skipper=window.Skipper||{data:{},meta:{sources:[]},ready:function(f){var r=function(){f(window.Skipper.data,window.Skipper.meta)};document.readyState==="loading"?document.addEventListener("DOMContentLoaded",r):r()}};window.Skipper.context=${jsonForScript(payload.context)};${api}</script>`;
    // Après le script des données s'il est là (il doit créer window.Skipper avant), sinon après <head>.
    const data = new RegExp(`<script ${DATA_MARKER}>[^]*?</script>`).exec(out);
    if (data) out = out.slice(0, data.index + data[0].length) + head + out.slice(data.index + data[0].length);
    else {
      const m = /<head(\s[^>]*)?>/i.exec(out);
      out = m ? out.slice(0, m.index + m[0].length) + head + out.slice(m.index + m[0].length) : head + out;
    }
  }
  if (!out.includes(WIDGET_MARKER)) {
    const tag = `<script ${WIDGET_MARKER}>${script}</script>`;
    let placed = false;
    for (const close of [/<\/body\s*>/i, /<\/html\s*>/i]) {
      const m = close.exec(out);
      if (m) {
        out = out.slice(0, m.index) + tag + out.slice(m.index);
        placed = true;
        break;
      }
    }
    if (!placed) out += tag;
  }
  return out;
}
