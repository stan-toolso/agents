// Serveur factice pour vérifier l'interface sans backend ni base : sert le build du frontend et répond à
// /graphql avec des données générées depuis le vrai schéma (textes longs, listes de 3 éléments, dates…).
//
//   cd frontend && VITE_GRAPHQL_URL=http://127.0.0.1:4555/graphql NODE_OPTIONS=--max-old-space-size=900 \
//     npx vite build --outDir /tmp/skipper-mobile-dist
//   DIST=/tmp/skipper-mobile-dist node scripts/mobile-audit/mock-server.mjs     # PORT=4555 par défaut
//
// Les données sont inventées : les écrans servent à juger la mise en page, pas le contenu.
// MOCK_DEMO=1 (aperçu de Skipper, .skipper/preview.json) : données de démonstration cohérentes (demo-data.mjs) — une
// personne connectée, son espace personnel, des projets d'équipe, leurs sessions, tâches, demandes et agents.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const { buildSchema, parse, execute, isNonNullType, isListType, isObjectType, isInterfaceType, isUnionType, isEnumType, isScalarType } = require('graphql');

const DIST = process.env.DIST || '/tmp/skipper-mobile-dist';
const PORT = Number(process.env.PORT || 4555);
const DEMO = process.env.MOCK_DEMO ? await import('./demo-data.mjs') : null;
const schema = buildSchema(fs.readFileSync(path.join(repo, 'backend/src/graphql/schema.graphql'), 'utf8'));

let counter = 0;
const LONG = "Je voudrais que tu me prépares un rapport détaillé sur la trésorerie du groupe pour l'année 2026-2027, avec les camps et les cotisations";
const PARA = `${LONG}. Deuxième phrase assez longue pour vérifier le retour à la ligne sur un écran étroit, avec un chemin /home/skipper/skipper-workspaces/projet/sous-dossier/fichier-au-nom-tres-long.html et une URL https://example.com/un/chemin/assez/long/pour/deborder.`;

/** Valeur d'un scalaire d'après son type et le nom du champ. */
function scalar(type, field, parentType) {
  const f = field.toLowerCase();
  counter++;
  const demo = DEMO?.demoScalar(type, field, parentType, counter);
  if (demo !== undefined) return demo;
  switch (type.name) {
    case 'ID':
      // Dossiers parents absents : les éléments apparaissent à la racine des arbres (contexte, explorateur).
      return /folderid$|^parentid$/.test(f) ? null : `${parentType}-${field}-${counter}`;
    case 'Int':
      return f.includes('count') || f.includes('total') ? 12 : f.includes('percent') ? 75 : 3;
    case 'Float':
      return f.includes('cost') || f.includes('usd') ? 12.3456 : 0.5;
    case 'Boolean':
      // Invité des pages partagées : l'interface complète est celle à auditer.
      if (f === 'isguest') return false;
      return /exists|enabled|active|configured|connected|^is|^has|^can|visible|^ok|healthy|available|^staged/.test(f);
    case 'DateTime':
      return new Date(Date.now() - counter * 3600_000).toISOString();
    case 'JSON':
      return f === 'definition' ? { nodes: [], edges: [] } : {};
    default:
      if (f === 'email' || f.endsWith('email')) return 'prenom.nom@exemple.fr';
      if (f.includes('avatar')) return null;
      if (f.includes('url') || f.includes('link')) return 'https://github.com/stan-toolso/skipper/pull/123';
      if (f === 'path' || f.endsWith('path') || f === 'cwd' || f.includes('dir')) return '/home/skipper/skipper-workspaces/projet/sous-dossier/fichier-au-nom-tres-long.html';
      if (f.includes('branch')) return 'feature/une-branche-au-nom-assez-long';
      if (f.includes('slug')) return 'projet-slug';
      if (f === 'hash' || f.includes('sha') || f.includes('commit')) return 'abc1234def5678';
      if (f === 'name' && /^File/.test(parentType)) return counter % 2 ? 'Previsionnel_2026-2027.html' : 'index.ts';
      if (f === 'name' || f === 'label' || f === 'title' || f === 'subject') return `${LONG.slice(0, 48)} ${counter}`;
      if (f.includes('model')) return 'claude-opus-4-1';
      if (f.includes('version')) return '1.2.3';
      if (f.includes('color')) return '#d97757';
      if (/content|text|body|description|message|prompt|instruction|summary|output|error|reason|question|answer|command|stdout|stderr|markdown|transcript|notes|html/.test(f)) return PARA;
      if (f.includes('kind') || f.includes('type') || f.includes('status') || f.includes('state') || f.includes('role')) return 'claude';
      return `Texte ${counter}`;
  }
}
function value(type, field, parentType, depth) {
  if (isNonNullType(type)) return value(type.ofType, field, parentType, depth);
  if (isListType(type)) return Array.from({ length: depth > 6 ? 0 : DEMO ? 2 : 3 }, () => value(type.ofType, field, parentType, depth + 1));
  if (isEnumType(type)) {
    const vals = type.getValues().map((v) => v.name);
    return vals[counter++ % vals.length];
  }
  if (isScalarType(type)) return scalar(type, field, parentType);
  if (isObjectType(type)) return { __typename: type.name, __depth: depth };
  if (isInterfaceType(type) || isUnionType(type)) {
    const impls = schema.getPossibleTypes(type);
    return { __typename: impls[counter++ % impls.length].name, __depth: depth };
  }
  return null;
}
const fieldResolver = (source, _args, _ctx, info) => {
  // Données de démonstration : un champ peut être une fonction des arguments (relations, filtres).
  if (source && typeof source === 'object' && info.fieldName in source) {
    const v = source[info.fieldName];
    return typeof v === 'function' ? v(_args, info) : v;
  }
  // Fichier ouvert dans l'éditeur : son nom suit le chemin demandé (l'aperçu HTML et le bouton « Code » n'existent
  // que pour un .html), au lieu d'alterner au gré du compteur.
  if (info.fieldName === 'name' && /^File/.test(info.parentType.name)) {
    const p = Object.values(info.variableValues ?? {}).find((v) => typeof v === 'string' && /\.[a-z0-9]+$/i.test(v));
    if (p) return path.basename(p);
  }
  return value(info.returnType, info.fieldName, info.parentType.name, ((source && source.__depth) || 0) + 1);
};
const typeResolver = (v) => v.__typename;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (url.pathname === '/graphql' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      try {
        const { query, variables } = JSON.parse(body);
        // MOCK_STABLE=1 (aperçu de Skipper) : mêmes données d'un sondage à l'autre, sinon les listes changent toutes les secondes.
        if (process.env.MOCK_STABLE || DEMO) counter = 0;
        return res.end(JSON.stringify(await execute({ schema, document: parse(query), variableValues: variables, fieldResolver, typeResolver, rootValue: DEMO?.demoRoot ?? {} })));
      } catch (e) {
        return res.end(JSON.stringify({ errors: [{ message: String(e) }] }));
      }
    }
    // Lien public d'une session (page /share/<token>) : le transcript de démo pour le jeton de démo, 404 sinon.
    const share = url.pathname.match(/^\/api\/share\/([^/]+)$/);
    if (share) {
      const view = DEMO?.demoSharedSession?.(decodeURIComponent(share[1])) ?? null;
      res.writeHead(view ? 200 : 404, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify(view ?? { error: "Ce lien de partage n'existe pas, a expiré ou a été révoqué." }));
    }
    // Artefact de diapositives de démo : un petit deck avec le vrai lecteur injecté (backend/src/sharedPages/slides-client.js).
    if (/^\/api\/shared\/page-slides-/.test(url.pathname)) {
      const mode = url.searchParams.get('print') === '1' ? 'print' : url.searchParams.get('thumb') === '1' ? 'thumb' : 'view';
      const player = fs.readFileSync(path.join(here, '../../../backend/src/sharedPages/slides-client.js'), 'utf8');
      const slide = (cls, body) => `<section class="slide ${cls}">${body}</section>`;
      const deck = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Les trois offres</title><style>
        body{font-family:system-ui,sans-serif;color:#1b1b1a}section.slide{padding:72px 88px;background:#fff;position:relative}section.slide.dark{background:#1f2a44;color:#fff}
        h1{font-size:64px;margin:0 0 16px}h2{font-size:46px;margin:0 0 28px}p,li{font-size:28px;line-height:1.4}.kicker{font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:#c8773a;margin-bottom:18px}
        ul{padding-left:36px;margin:0}li{margin-bottom:14px}.cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:28px}.card{border:1px solid #e3e1da;border-radius:16px;padding:28px}.card h3{font-size:30px;margin:0 0 8px}.price{font-size:44px;font-weight:700;color:#2a78d6}
      </style></head><body>
        ${slide('dark', '<div class="kicker">Toolso · novembre 2026</div><h1>Les trois offres</h1><p>Une grille simple pour choisir en deux minutes.</p>')}
        ${slide('', '<h2>Pourquoi trois offres ?</h2><ul><li>Des besoins très différents selon la taille de l’équipe</li><li>Un prix lisible, sans option cachée</li><li>Passer de l’une à l’autre en un clic</li></ul>')}
        ${slide('', '<h2>Comparatif</h2><div class="cols"><div class="card"><h3>Solo</h3><div class="price">19 €</div><p>1 projet, 1 agent</p></div><div class="card"><h3>Équipe</h3><div class="price">79 €</div><p>10 projets, agents illimités</p></div><div class="card"><h3>Entreprise</h3><div class="price">Sur devis</div><p>Cellule dédiée, SSO</p></div></div>')}
        ${slide('dark', '<div class="kicker">Section 02</div><h1>Et ensuite ?</h1>')}
        ${slide('', '<h2>Prochaines étapes</h2><ul><li>Valider la grille avec les ventes</li><li>Mettre la page tarifs à jour</li><li>Annoncer la nouvelle offre le 1er décembre</li></ul>')}
        <script data-skipper-slides data-mode="${mode}">${player}</script></body></html>`;
      res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals' });
      return res.end(deck);
    }
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
      res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:sans-serif;padding:16px"><h1>Aperçu</h1><p>Contenu de la page servie par le backend.</p></body></html>');
    }
    let p = path.join(DIST, decodeURIComponent(url.pathname));
    if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Serveur factice sur http://127.0.0.1:${PORT} (build : ${DIST})`));
