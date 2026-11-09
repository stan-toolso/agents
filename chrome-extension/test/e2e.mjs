// Essai de bout en bout de l'extension « Skipper pour Chrome » : un faux serveur Skipper (protocole WebSocket de
// backend/src/chrome) envoie des commandes à l'extension chargée dans un vrai Chromium.
// Usage (Playwright et ws installés dans un dossier jetable, hors du dépôt) :
//   mkdir /tmp/cxt && cd /tmp/cxt && npm i playwright@1 ws@8 && PLAYWRIGHT_BROWSERS_PATH=/tmp/cxt/browsers npx playwright install chromium
//   cp <dépôt>/chrome-extension/test/e2e.mjs . && PLAYWRIGHT_BROWSERS_PATH=/tmp/cxt/browsers node e2e.mjs <dépôt>/chrome-extension
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const extDir = process.argv[2];
const TOKEN = 'skc_essai';

// Page de test servie en local.
const page = `<!doctype html><html><head><title>Formulaire</title></head><body>
<h1>Bonjour</h1><p>Texte de la page.</p>
<label for="n">Nom</label><input id="n" value="ancien">
<input type="password" id="p" aria-label="Mot de passe">
<button onclick="document.getElementById('out').textContent='Envoyé : '+document.getElementById('n').value;console.error('erreur de test')">Envoyer</button>
<div id="out"></div><a href="/deux">Page deux</a>
</body></html>`;
const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/deux' ? '<title>Deux</title><p>Seconde page</p>' : page);
});
const wss = new WebSocketServer({ server: http, path: '/api/chrome/connect' });
let socket;
const pending = new Map();
let seq = 0;
const ready = new Promise((resolve) => {
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        if (msg.token !== TOKEN) return ws.close(4401, 'jeton');
        socket = ws;
        ws.send(JSON.stringify({ type: 'ready', name: 'Essai' }));
        resolve();
      } else if (msg.type === 'result') {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
  });
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${http.address().port}`;

const session = { id: 'sess-1', name: 'Essai e2e', url: null };
function command(name, args = {}, s = session) {
  const id = String(++seq);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ type: 'command', id, name, args, session: s }));
  });
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
await sw.evaluate(async ({ url, token }) => {
  await chrome.storage.local.set({ serverUrl: url, token });
}, { url: base, token: TOKEN });
// Le service worker se reconnecte au prochain réveil : on déclenche l'alarme à la main via un message de la popup.
const popup = await context.newPage();
const extId = sw.url().split('/')[2];
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'reconnect' }));
await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('pas de connexion')), 10000))]);
console.log('connecté');

const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(detail).slice(0, 600)}`}`);
};

// Page Playwright d'un onglet piloté (pour regarder l'indicateur depuis la page).
const pageWith = async (pred) => {
  for (let i = 0; i < 20; i++) {
    for (const p of context.pages()) if (await pred(p).catch(() => false)) return p;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};
const indicator = (p) => p.evaluate(() => ({ title: document.title, host: Boolean(document.querySelector('skipper-indicator')) }));

let r = await command('tabs');
check('tabs vide', r.ok && /Aucun onglet/.test(r.result.text), r);

// Fenêtre au premier plan qui refuse les groupes (popup, application installée comme Skipper) : l'onglet doit
// s'ouvrir dans une fenêtre ordinaire.
await sw.evaluate(async () => {
  await chrome.windows.create({ type: 'popup', url: 'about:blank', focused: true });
});
r = await command('open', { url: `${base}/` });
const tabId = Number(r.result?.text.match(/Onglet (\d+)/)?.[1]);
check('open (malgré une fenêtre popup au premier plan)', r.ok && tabId > 0, r);
const winType = await sw.evaluate(async (id) => (await chrome.windows.get((await chrome.tabs.get(id)).windowId)).type, tabId);
check('onglet ouvert dans une fenêtre ordinaire', winType === 'normal', winType);

r = await command('tabs');
check('tabs liste l’onglet', r.ok && r.result.text.includes(`[${tabId}]`) && r.result.text.includes('ouvert par cette session'), r);

r = await command('read_page', { tab: tabId });
check('read_page ignore le bandeau', r.ok && !r.result.text.includes('piloté par Skipper') && !r.result.text.includes('Reprendre la main'), r);
const formPage = await pageWith(async (p) => p.url() === `${base}/`);
let ind = formPage ? await indicator(formPage) : null;
check('bandeau et titre 🤖 sur l’onglet piloté', ind?.host && ind.title === '🤖 Formulaire', ind);
check('read_page', r.ok && r.result.text.includes('Texte de la page') && /\[e\d+\] bouton « Envoyer »/.test(r.result.text) && /champ text « Nom » = « ancien »/.test(r.result.text), r);
const text = r.result?.text ?? '';
const refOf = (re) => text.match(re)?.[1];
const nameRef = refOf(/\[(e\d+)\] champ text « Nom »/);
const passRef = refOf(/\[(e\d+)\] champ password/);
const btnRef = refOf(/\[(e\d+)\] bouton « Envoyer »/);
const linkRef = refOf(/\[(e\d+)\] lien « Page deux »/);

r = await command('type', { tab: tabId, ref: nameRef, text: 'Skipper' });
check('type (remplace la valeur)', r.ok, r);
r = await command('type', { tab: tabId, ref: passRef, text: 'secret' });
check('type refusé dans un mot de passe', !r.ok && /mot de passe/.test(r.error), r);

r = await command('click', { tab: tabId, ref: btnRef });
check('click', r.ok, r);
r = await command('wait', { tab: tabId, text: 'Envoyé : Skipper', seconds: 5 });
check('wait + effet du clic et de la saisie', r.ok && /présent/.test(r.result.text), r);

r = await command('console', { tab: tabId, errors_only: true });
check('console', r.ok && r.result.text.includes('erreur de test'), r);

r = await command('screenshot', { tab: tabId });
check('screenshot', r.ok && r.result.image?.mimeType === 'image/jpeg' && r.result.image.data.length > 1000, { ok: r.ok, error: r.error, text: r.result?.text });

r = await command('scroll', { tab: tabId, direction: 'bottom' });
check('scroll', r.ok, r);

r = await command('click', { tab: tabId, ref: linkRef });
check('click sur un lien → navigation', r.ok && /Deux/.test(r.result.text), r);
await new Promise((res) => setTimeout(res, 500));
ind = await indicator(formPage);
check('indicateur conservé après navigation', ind.host && ind.title === '🤖 Deux', ind);

r = await command('navigate', { tab: tabId, url: 'back' });
check('navigate back', r.ok && /Formulaire/.test(r.result.text), r);

r = await command('press_key', { tab: tabId, key: 'Tab' });
check('press_key', r.ok, r);

// Une autre session n'a pas accès à cet onglet.
r = await command('read_page', { tab: tabId }, { id: 'sess-2', name: 'Autre', url: null });
check('onglet refusé à une autre session', !r.ok && /pas confié/.test(r.error), r);

// Onglet ouvert par la personne, hors groupe : refusé ; confié (popup) : accessible.
const own = await context.newPage();
await own.goto(`${base}/deux`);
const ownId = await sw.evaluate(async () => (await chrome.tabs.query({ title: 'Deux' }))[0].id);
r = await command('read_page', { tab: ownId });
check('onglet de la personne refusé', !r.ok, r);
await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'share', tabId: id }), ownId);
r = await command('read_page', { tab: ownId }, { id: 'sess-2', name: 'Autre', url: null });
check('onglet confié accessible à toute session', r.ok && r.result.text.includes('Seconde page'), r);
r = await command('close_tab', { tab: ownId });
check('close_tab refusé sur un onglet confié', !r.ok, r);

r = await command('navigate', { tab: tabId, url: 'file:///etc/passwd' });
check('URL non http refusée', !r.ok, r);

// « Reprendre la main » (bouton du bandeau → liaison __skipperRelease) : Skipper lâche l'onglet.
// Après « back », Chrome peut avoir changé de cible (cache de navigation) : on reprend la page de l'onglet.
const backPage = await pageWith(async (p) => p.url() === `${base}/` && !p.isClosed() && (await p.title()).startsWith('🤖'));
await backPage.evaluate(() => window.__skipperRelease('release'));
await new Promise((res) => setTimeout(res, 800));
ind = await indicator(backPage);
check('reprendre la main retire bandeau et titre', !ind.host && !ind.title.startsWith('🤖'), ind);
r = await command('read_page', { tab: tabId });
check('onglet repris inaccessible à la session', !r.ok && /pas confié/.test(r.error), r);
r = await command('open', { url: `${base}/` });
const tab2 = Number(r.result?.text.match(/Onglet (\d+)/)?.[1]);
r = await command('close_tab', { tab: tab2 });

check('close_tab', r.ok, r);

r = await command('inconnue');
check('commande inconnue', !r.ok, r);

const groups = await sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
check('groupes', groups.includes('Skipper'), groups);

await context.close();
http.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `${failed} échec(s)` : 'tout est vert');
process.exit(failed ? 1 : 0);
