// Service worker de « Skipper pour Chrome » : connexion WebSocket au serveur Skipper (jeton du navigateur),
// exécution des commandes des sessions, appairage par la page /chrome/connect de Skipper.
import { commands, releaseTab, shareTab, skipperGroupIds } from './commands.js';

const PING_MS = 20_000; // garde le service worker éveillé (Chrome 116+) et la connexion ouverte
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

let ws = null;
let pingTimer = null;
let retryTimer = null;
let retries = 0;
/** État affiché par la popup. */
let state = { status: 'idle', message: '', name: '' };

function setState(next) {
  state = { ...state, ...next };
  const badge = { connected: '', connecting: '…', error: '!', unpaired: '', revoked: '!' }[state.status] ?? '';
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: state.status === 'connected' ? '#198754' : '#dc3545' });
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

async function settings() {
  const stored = await chrome.storage.local.get(['serverUrl', 'token']);
  let serverUrl = stored.serverUrl;
  if (!serverUrl) {
    // Adresse fournie par l'archive téléchargée depuis Skipper (config.json).
    serverUrl = await fetch(chrome.runtime.getURL('config.json'))
      .then((r) => r.json())
      .then((c) => c.serverUrl)
      .catch(() => '');
  }
  return { serverUrl: (serverUrl || '').replace(/\/+$/, ''), token: stored.token || '' };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries += 1;
  retryTimer = setTimeout(connect, delay);
}

async function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { serverUrl, token } = await settings();
  if (!serverUrl || !token) return setState({ status: 'unpaired', message: '' });
  setState({ status: 'connecting', message: '' });
  const socket = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/api/chrome/connect`);
  ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token, version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent }));
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      retries = 0;
      setState({ status: 'connected', name: msg.name || '', message: '' });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'ping' })), PING_MS);
    } else if (msg.type === 'command') void runCommand(socket, msg);
  };
  socket.onclose = (event) => {
    clearInterval(pingTimer);
    if (ws === socket) ws = null;
    if (event.code === 4401) {
      // Jeton refusé (navigateur retiré dans Skipper) : on n'insiste pas.
      setState({ status: 'revoked', message: event.reason || 'Ce navigateur a été retiré de Skipper : reconnectez-le.' });
      return;
    }
    if (event.code === 4000) return; // remplacée par une connexion plus récente
    setState({ status: 'connecting', message: event.code === 1012 ? 'Mise à jour du serveur, reconnexion…' : 'Connexion perdue, nouvelle tentative…' });
    scheduleRetry();
  };
  socket.onerror = () => {};
}

async function runCommand(socket, msg) {
  const reply = (body) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'result', id: msg.id, ...body }));
  const fn = commands[msg.name];
  if (!fn) return reply({ ok: false, error: `Commande inconnue de l'extension : ${msg.name} (mettez l'extension à jour).` });
  try {
    reply({ ok: true, result: await fn(msg.args || {}, msg.session || {}) });
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err) });
  }
}

function disconnect() {
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) {
    const socket = ws;
    ws = null;
    socket.onclose = null;
    socket.close(1000);
  }
}

// ——— Appairage : la page /chrome/connect de Skipper revient avec #state=…&token=… ———

async function startPairing(serverUrl) {
  const url = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error('Adresse invalide (https://…)');
  const pairState = crypto.randomUUID();
  const name = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
  const tab = await chrome.tabs.create({ url: `${url}/chrome/connect?state=${pairState}&name=${encodeURIComponent(name)}` });
  await chrome.storage.session.set({ pairing: { state: pairState, serverUrl: url, tabId: tab.id } });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url || !changeInfo.url.includes('/chrome/connect')) return;
  const { pairing } = await chrome.storage.session.get('pairing');
  if (!pairing || pairing.tabId !== tabId) return;
  const url = new URL(changeInfo.url);
  if (`${url.origin}` !== new URL(pairing.serverUrl).origin) return;
  const params = new URLSearchParams(url.hash.slice(1));
  if (params.get('state') !== pairing.state || !params.get('token')) return;
  await chrome.storage.session.remove('pairing');
  await chrome.storage.local.set({ serverUrl: pairing.serverUrl, token: params.get('token') });
  disconnect();
  retries = 0;
  await connect();
  setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 2500);
});

// ——— Popup ———

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getState': {
        const { serverUrl } = await settings();
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        // « Reprendre cet onglet » pour tout onglet d'un groupe Skipper (confié ou ouvert par une session).
        const groups = await skipperGroupIds();
        return { state, serverUrl, activeTab: active ? { id: active.id, title: active.title, url: active.url, shared: groups.has(active.groupId) } : null };
      }
      case 'pair':
        await startPairing(msg.serverUrl);
        return { ok: true };
      case 'setToken':
        await chrome.storage.local.set({ serverUrl: msg.serverUrl.trim().replace(/\/+$/, ''), token: msg.token.trim() });
        disconnect();
        retries = 0;
        await connect();
        return { ok: true };
      case 'forget':
        disconnect();
        await chrome.storage.local.remove('token');
        setState({ status: 'unpaired', name: '', message: '' });
        return { ok: true };
      case 'reconnect':
        disconnect();
        retries = 0;
        await connect();
        return { ok: true };
      case 'share':
        await shareTab(msg.tabId);
        return { ok: true };
      case 'unshare':
        await releaseTab(msg.tabId);
        return { ok: true };
      default:
        return { ok: false };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// Réveil périodique : rouvre la connexion si le service worker a été arrêté entre-temps.
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
