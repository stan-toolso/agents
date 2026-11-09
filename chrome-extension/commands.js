// Commandes envoyées par les sessions Skipper. Chaque commande vise un onglet auquel la session a droit : ceux du
// groupe de la session (ouverts par elle) et ceux que la personne a confiés à Skipper (groupe « Skipper »).
import { focusedIsPassword, locateRef, pageHasText, scrollPage, snapshotPage } from './page.js';

export const SHARED_GROUP_TITLE = 'Skipper';
const SESSION_GROUP_PREFIX = 'Skipper · ';
const LOAD_TIMEOUT_MS = 15_000;
const CONSOLE_MAX = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ——— Groupes d'onglets ———

async function groupsState() {
  const { groups = {} } = await chrome.storage.session.get('groups');
  return groups;
}

async function groupExists(id) {
  if (typeof id !== 'number') return false;
  try {
    await chrome.tabGroups.get(id);
    return true;
  } catch {
    return false;
  }
}

/** Groupe partagé « Skipper » (onglets confiés par la personne), s'il existe. */
export async function sharedGroupId() {
  const groups = await groupsState();
  if (await groupExists(groups.shared)) return groups.shared;
  const found = (await chrome.tabGroups.query({ title: SHARED_GROUP_TITLE }))[0];
  if (found) {
    await chrome.storage.session.set({ groups: { ...groups, shared: found.id } });
    return found.id;
  }
  return null;
}

/** Confie un onglet à Skipper (popup) : il rejoint le groupe « Skipper ». */
export async function shareTab(tabId) {
  const existing = await sharedGroupId();
  const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(existing !== null ? { groupId: existing } : {}) });
  if (existing === null) {
    await chrome.tabGroups.update(groupId, { title: SHARED_GROUP_TITLE, color: 'orange' });
    const groups = await groupsState();
    await chrome.storage.session.set({ groups: { ...groups, shared: groupId } });
  }
}

async function sessionGroupId(session) {
  const groups = await groupsState();
  const id = groups.sessions?.[session.id];
  return (await groupExists(id)) ? id : null;
}

/** Range un onglet dans le groupe de la session (créé au besoin, au nom de la session). */
async function addToSessionGroup(tabId, session) {
  const existing = await sessionGroupId(session);
  const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(existing !== null ? { groupId: existing } : {}) });
  if (existing === null) {
    await chrome.tabGroups.update(groupId, { title: `${SESSION_GROUP_PREFIX}${String(session.name || 'session').slice(0, 30)}`, color: 'blue' });
    const groups = await groupsState();
    await chrome.storage.session.set({ groups: { ...groups, sessions: { ...(groups.sessions ?? {}), [session.id]: groupId } } });
  }
}

/** Onglets auxquels la session a droit. */
async function allowedTabs(session) {
  const ids = [await sessionGroupId(session), await sharedGroupId()].filter((id) => id !== null);
  const tabs = [];
  for (const groupId of ids) tabs.push(...(await chrome.tabs.query({ groupId })));
  return tabs;
}

async function tabFor(args, session, { own = false } = {}) {
  const id = Number(args.tab);
  if (!Number.isInteger(id)) throw new Error('Paramètre tab manquant : identifiant donné par tabs ou open.');
  let tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    throw new Error(`Onglet ${id} introuvable (fermé ?) : liste les onglets avec tabs.`);
  }
  const sessionGroup = await sessionGroupId(session);
  const shared = await sharedGroupId();
  const allowed = own ? tab.groupId === sessionGroup && sessionGroup !== null : (tab.groupId === sessionGroup && sessionGroup !== null) || (tab.groupId === shared && shared !== null);
  if (!allowed)
    throw new Error(
      own
        ? `L'onglet ${id} n'a pas été ouvert par cette session : seule la personne peut le fermer.`
        : `L'onglet ${id} n'est pas confié à Skipper : demande à la personne de l'y ajouter (icône Skipper › « Confier cet onglet »), ou ouvre une page avec open.`,
    );
  return tab;
}

function describeTab(tab) {
  return `${tab.title || '(sans titre)'} — ${tab.url || tab.pendingUrl || ''}`;
}

// ——— Débogueur (CDP) ———

/** Onglets auxquels le débogueur est attaché, avec les messages de console relevés depuis. */
const attached = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  const state = attached.get(source.tabId);
  if (!state) return;
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ');
    state.console.push({ level: params.type, text });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails || {};
    state.console.push({ level: 'error', text: `Exception : ${d.exception?.description || d.text || ''}`.split('\n').slice(0, 4).join('\n') });
  } else if (method === 'Log.entryAdded') {
    state.console.push({ level: params.entry.level, text: `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}` });
  }
  if (state.console.length > CONSOLE_MAX) state.console.splice(0, state.console.length - CONSOLE_MAX);
});
chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    if (!String(err.message).includes('Another debugger')) throw new Error(`Impossible de piloter cet onglet (${err.message}) : les pages internes de Chrome et du Web Store sont exclues.`);
  }
  attached.set(tabId, { console: [] });
  await cdp(tabId, 'Runtime.enable');
  await cdp(tabId, 'Log.enable').catch(() => {});
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, fn, ...args) {
  await attach(tabId);
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`Erreur dans la page : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

async function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  await sleep(300);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("L'onglet a été fermé.");
    if (tab.status === 'complete') return tab;
    await sleep(250);
  }
  return chrome.tabs.get(tabId);
}

async function mouseClick(tabId, x, y, clickCount = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
};

async function pressKey(tabId, name) {
  const k = KEYS[name];
  if (!k) throw new Error(`Touche inconnue : ${name} (connues : ${Object.keys(KEYS).join(', ')}).`);
  const base = { key: k.key ?? name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function afterAction(tabId, beforeUrl) {
  await sleep(400);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return " L'onglet a été fermé.";
  if (tab.status === 'loading' || tab.url !== beforeUrl) {
    const loaded = await waitForLoad(tabId);
    return ` La page a changé : ${describeTab(loaded)} (relis-la avec read_page).`;
  }
  return '';
}

function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL invalide : ${url}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Seules les adresses http(s) peuvent être ouvertes.');
  return u.href;
}

// ——— Commandes ———

export const commands = {
  async tabs(_args, session) {
    const tabs = await allowedTabs(session);
    const own = await sessionGroupId(session);
    if (!tabs.length) return { text: "Aucun onglet accessible : ouvre une page avec open, ou demande à la personne de confier un onglet à Skipper (icône Skipper › « Confier cet onglet »)." };
    return { text: tabs.map((t) => `[${t.id}] ${describeTab(t)}${t.active ? ' (actif)' : ''} · ${t.groupId === own ? 'ouvert par cette session' : 'confié par la personne'}`).join('\n') };
  },

  async open(args, session) {
    const url = checkUrl(String(args.url ?? ''));
    const tab = await chrome.tabs.create({ url, active: true });
    await addToSessionGroup(tab.id, session);
    const loaded = await waitForLoad(tab.id);
    return { text: `Onglet ${tab.id} ouvert : ${describeTab(loaded)}` };
  },

  async navigate(args, session) {
    const tab = await tabFor(args, session);
    const target = String(args.url ?? '');
    if (target === 'back') await chrome.tabs.goBack(tab.id);
    else if (target === 'forward') await chrome.tabs.goForward(tab.id);
    else if (target === 'reload') await chrome.tabs.reload(tab.id);
    else await chrome.tabs.update(tab.id, { url: checkUrl(target) });
    const loaded = await waitForLoad(tab.id);
    return { text: `Onglet ${tab.id} : ${describeTab(loaded)}` };
  },

  async read_page(args, session) {
    const tab = await tabFor(args, session);
    const mode = ['all', 'interactive', 'text'].includes(args.mode) ? args.mode : 'all';
    const max = Math.min(Math.max(Number(args.max_chars) || 20000, 1000), 100000);
    return { text: await evaluate(tab.id, snapshotPage, mode, max) };
  },

  async click(args, session) {
    const tab = await tabFor(args, session);
    let x = Number(args.x);
    let y = Number(args.y);
    let what = `en ${x}, ${y}`;
    if (args.ref) {
      const loc = await evaluate(tab.id, locateRef, String(args.ref), false, false);
      if (loc.error) throw new Error(loc.error);
      ({ x, y } = loc);
      what = `sur ${args.ref} « ${loc.label} »`;
    } else if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Donne ref (de read_page) ou x et y.');
    await attach(tab.id);
    await mouseClick(tab.id, x, y, args.double ? 2 : 1);
    return { text: `Clic ${what}.${await afterAction(tab.id, tab.url)}` };
  },

  async type(args, session) {
    const tab = await tabFor(args, session);
    const text = String(args.text ?? '');
    if (args.ref) {
      const loc = await evaluate(tab.id, locateRef, String(args.ref), true, args.clear !== false);
      if (loc.error) throw new Error(loc.error);
      if (loc.password) throw new Error('Champ mot de passe : Skipper ne saisit pas de mot de passe dans votre navigateur. Demande à la personne de le faire.');
    } else {
      if (await evaluate(tab.id, focusedIsPassword)) throw new Error('Champ mot de passe : Skipper ne saisit pas de mot de passe dans votre navigateur. Demande à la personne de le faire.');
      if (args.clear) {
        // « Tout sélectionner » dans le champ qui a le focus : la saisie remplace la sélection.
        await cdp(tab.id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
        await cdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      }
    }
    await attach(tab.id);
    await cdp(tab.id, 'Input.insertText', { text });
    if (args.submit) await pressKey(tab.id, 'Enter');
    return { text: `Saisi ${text.length} caractère(s)${args.ref ? ` dans ${args.ref}` : ''}${args.submit ? ', puis Entrée' : ''}.${await afterAction(tab.id, tab.url)}` };
  },

  async press_key(args, session) {
    const tab = await tabFor(args, session);
    await attach(tab.id);
    await pressKey(tab.id, String(args.key ?? ''));
    return { text: `Touche ${args.key}.${await afterAction(tab.id, tab.url)}` };
  },

  async scroll(args, session) {
    const tab = await tabFor(args, session);
    const r = await evaluate(tab.id, scrollPage, args.direction || 'down', args.ref || null);
    if (r.error) throw new Error(r.error);
    return { text: `Position : ${r.y} px sur ${r.max} px.` };
  },

  async screenshot(args, session) {
    const tab = await tabFor(args, session);
    await attach(tab.id);
    // Image en pixels CSS : ses coordonnées servent telles quelles à click (x, y).
    const metrics = await cdp(tab.id, 'Page.getLayoutMetrics');
    const vp = metrics.cssVisualViewport || metrics.visualViewport;
    const dpr = await evaluate(tab.id, () => window.devicePixelRatio || 1);
    const params = { format: 'jpeg', quality: 70, clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr } };
    let shot;
    try {
      shot = await Promise.race([cdp(tab.id, 'Page.captureScreenshot', params), sleep(6000).then(() => null)]);
    } catch {
      shot = null;
    }
    if (!shot) {
      // Onglet en arrière-plan : Chrome ne le dessine pas ; on l'affiche puis on recommence.
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(500);
      shot = await cdp(tab.id, 'Page.captureScreenshot', params);
    }
    return { image: { data: shot.data, mimeType: 'image/jpeg' }, text: `Capture de l'onglet ${tab.id} (${Math.round(vp.clientWidth)}×${Math.round(vp.clientHeight)} px CSS) : ${describeTab(tab)}` };
  },

  async console(args, session) {
    const tab = await tabFor(args, session);
    const wasAttached = attached.has(tab.id);
    await attach(tab.id);
    const entries = attached.get(tab.id).console.filter((e) => !args.errors_only || e.level === 'error' || e.level === 'warning');
    if (!entries.length) return { text: wasAttached ? 'Aucun message.' : "Aucun message : Skipper vient de s'attacher à l'onglet, les messages seront relevés à partir de maintenant (recharge la page avec navigate reload pour les voir dès le chargement)." };
    return { text: entries.slice(-80).map((e) => `[${e.level}] ${e.text}`).join('\n') };
  },

  async wait(args, session) {
    const tab = await tabFor(args, session);
    const seconds = Math.min(Math.max(Number(args.seconds ?? 10), 0), 20);
    if (!args.text) {
      await sleep(seconds * 1000);
      return { text: `Attendu ${seconds} s.` };
    }
    const deadline = Date.now() + seconds * 1000;
    do {
      if (await evaluate(tab.id, pageHasText, String(args.text))) return { text: `Texte « ${args.text} » présent.` };
      await sleep(500);
    } while (Date.now() < deadline);
    return { text: `Texte « ${args.text} » toujours absent après ${seconds} s.` };
  },

  async close_tab(args, session) {
    const tab = await tabFor(args, session, { own: true });
    await chrome.tabs.remove(tab.id);
    return { text: `Onglet ${tab.id} fermé.` };
  },
};
