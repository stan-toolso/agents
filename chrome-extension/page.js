// Fonctions exécutées DANS la page (Runtime.evaluate par le débogueur) : elles sont sérialisées avec toString(),
// donc autonomes (aucune variable extérieure). Les éléments repérés portent l'attribut data-skipper-ref.

/** Instantané lisible de la page : éléments interactifs visibles (avec leur ref), puis texte. */
export function snapshotPage(mode, maxChars) {
  const ATTR = 'data-skipper-ref';
  const out = [`URL : ${location.href}`, `Titre : ${document.title}`];
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const short = (t, n = 100) => {
    const c = clean(t);
    return c.length > n ? `${c.slice(0, n - 1)}…` : c;
  };
  if (mode !== 'text') {
    document.querySelectorAll(`[${ATTR}]`).forEach((e) => e.removeAttribute(ATTR));
    const selector = [
      'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
      '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]', '[role=option]',
      '[role=switch]', '[role=combobox]', '[role=textbox]', '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]',
      '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
    };
    const labelOf = (el) =>
      el.getAttribute('aria-label') ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA' ? el.innerText : '') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      (el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').getAttribute('alt')) ||
      '';
    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const label = short(labelOf(el));
      if (tag === 'a') return `lien « ${label} » → ${short(el.getAttribute('href'), 120)}`;
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return `${type === 'checkbox' ? 'case' : 'bouton radio'} « ${label} » ${el.checked ? '(cochée)' : '(non cochée)'}`;
        if (type === 'submit' || type === 'button' || type === 'reset') return `bouton « ${short(el.value || label)} »`;
        const value = type === 'password' ? (el.value ? '••••' : '') : short(el.value, 80);
        return `champ ${type} « ${label} »${value ? ` = « ${value} »` : ''}${el.disabled ? ' (désactivé)' : ''}`;
      }
      if (tag === 'textarea') return `zone de texte « ${label} »${el.value ? ` = « ${short(el.value, 80)} »` : ''}`;
      if (tag === 'select') {
        const opt = el.selectedOptions && el.selectedOptions[0];
        const options = Array.from(el.options || []).slice(0, 15).map((o) => short(o.text, 40)).join(' | ');
        return `liste « ${label} » = « ${opt ? short(opt.text, 60) : ''} » (options : ${options})`;
      }
      if (el.isContentEditable) return `zone éditable « ${label} »`;
      if (tag === 'button' || role === 'button') return `bouton « ${label} »${el.disabled ? ' (désactivé)' : ''}`;
      if (role) return `${role} « ${label} »${el.getAttribute('aria-checked') ? ` (${el.getAttribute('aria-checked')})` : ''}`;
      return `élément ${tag} « ${label} »`;
    };
    const seen = new Set();
    const lines = [];
    let n = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (n >= 400) break;
      if (!visible(el)) continue;
      // Un élément cliquable imbriqué dans un autre déjà listé (bouton dans un lien…) : on garde le plus extérieur.
      let parent = el.parentElement;
      let nested = false;
      while (parent) {
        if (seen.has(parent)) {
          nested = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (nested && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') continue;
      seen.add(el);
      n += 1;
      const ref = `e${n}`;
      el.setAttribute(ATTR, ref);
      const r = el.getBoundingClientRect();
      const offscreen = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
      lines.push(`[${ref}] ${describe(el)}${offscreen ? ' (hors écran)' : ''}`);
    }
    out.push('', `Éléments interactifs (${n}${n >= 400 ? ', liste tronquée' : ''}) :`, ...(lines.length ? lines : ['(aucun)']));
  }
  if (mode !== 'interactive') {
    const text = (document.body ? document.body.innerText : '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    out.push('', 'Texte de la page :', text || '(vide)');
  }
  const all = out.join('\n');
  return all.length > maxChars ? `${all.slice(0, maxChars)}\n… (tronqué à ${maxChars} caractères)` : all;
}

/** Amène l'élément `ref` au centre de l'écran et renvoie son centre (pixels CSS de la fenêtre). */
export function locateRef(ref, focus, select) {
  const el = document.querySelector(`[data-skipper-ref="${CSS.escape(ref)}"]`);
  if (!el) return { error: `Référence ${ref} introuvable : la page a changé, relis-la avec read_page.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (focus) {
    el.focus();
    if (select) {
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
      else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }
  const r = el.getBoundingClientRect();
  const label = String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 80);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label, password: el.tagName === 'INPUT' && el.type === 'password' };
}

/** Fait défiler la fenêtre (ou amène un élément à l'écran). */
export function scrollPage(direction, ref) {
  if (ref) {
    const el = document.querySelector(`[data-skipper-ref="${CSS.escape(ref)}"]`);
    if (!el) return { error: `Référence ${ref} introuvable : relis la page avec read_page.` };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  } else if (direction === 'top') scrollTo(0, 0);
  else if (direction === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
  else scrollBy(0, (direction === 'up' ? -1 : 1) * Math.round(innerHeight * 0.8));
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return { y: Math.round(scrollY), max: Math.round(max) };
}

/** Le texte est-il présent dans la page ? */
export function pageHasText(text) {
  return Boolean(document.body && document.body.innerText.includes(text));
}

/** Élément qui a le focus : est-ce un champ mot de passe ? */
export function focusedIsPassword() {
  const el = document.activeElement;
  return Boolean(el && el.tagName === 'INPUT' && el.type === 'password');
}

/**
 * Indicateur « piloté par Skipper » : bandeau en haut de la page (shadow DOM fermé, hors de read_page et du texte de
 * la page, transparent aux clics sauf sur ses boutons) et préfixe 🤖 du titre de l'onglet, rétabli si la page le change.
 * Installé à chaque nouveau document (Page.addScriptToEvaluateOnNewDocument) tant que Skipper pilote l'onglet ;
 * `info.busy` anime le bandeau pendant une action. Le bouton « Reprendre la main » appelle la liaison CDP
 * `__skipperRelease` (l'extension retire alors l'onglet à Skipper).
 */
export function installIndicator(info) {
  const PREFIX = '🤖 ';
  const w = window;
  if (w.__skipperIndicator) return w.__skipperIndicator.update(info);
  // Au repos, le bandeau se réduit en languette (il ne cache plus l'en-tête du site) ; pendant une action, ou si la
  // personne l'a déplié, il est complet.
  const state = { info, host: null, root: null, observer: null, expanded: false };
  const applyTitle = () => {
    if (!document.title.startsWith(PREFIX)) document.title = PREFIX + document.title;
  };
  const render = () => {
    if (!state.root) return;
    const i = state.info;
    const bar = state.root.getElementById('bar');
    const collapsed = !i.busy && !state.expanded;
    bar.className = `${i.busy ? 'busy' : ''} ${collapsed ? 'collapsed' : ''}`;
    state.root.getElementById('toggle').textContent = collapsed ? '▾' : '▴';
    state.root.getElementById('toggle').title = collapsed ? 'Afficher le bandeau' : 'Réduire le bandeau';
    state.root.getElementById('label').textContent = i.busy ? 'Skipper agit dans cet onglet' : collapsed ? 'Skipper' : 'Onglet piloté par Skipper';
    const link = state.root.getElementById('session');
    link.textContent = i.sessionName ? `· ${i.sessionName}` : '';
    if (i.sessionUrl) link.setAttribute('href', i.sessionUrl);
    else link.removeAttribute('href');
  };
  const mount = () => {
    if (state.host || !document.documentElement) return;
    const host = document.createElement('skipper-indicator');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        #bar { display: flex; align-items: center; gap: 8px; justify-content: center; height: 26px; padding: 0 10px;
          font: 600 12px/26px system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff; background: #c2552d;
          box-shadow: 0 1px 4px rgba(0,0,0,.25); }
        #bar.busy { background: linear-gradient(90deg, #c2552d, #e07a4f, #c2552d); background-size: 200% 100%; animation: move 1.2s linear infinite; }
        #bar.collapsed { width: max-content; margin: 0 auto; border-radius: 0 0 10px 10px; padding: 0 10px; }
        #bar.collapsed .full { display: none; }
        #bar.collapsed #label { font-weight: 500; }
        @keyframes move { from { background-position: 0 0; } to { background-position: 200% 0; } }
        a { color: #fff; opacity: .9; text-decoration: underline; pointer-events: auto; }
        a:not([href]) { text-decoration: none; }
        button { pointer-events: auto; font: inherit; font-weight: 500; color: #c2552d; background: #fff; border: 0;
          border-radius: 4px; padding: 0 8px; height: 18px; line-height: 18px; cursor: pointer; }
        button.ghost { color: #fff; background: transparent; padding: 0 4px; }
      </style>
      <div id="bar" role="status">
        <span>🤖</span><span id="label"></span><a id="session" class="full" target="_blank" rel="noopener"></a>
        <button id="release" class="full" title="Retirer cet onglet à Skipper">Reprendre la main</button>
        <button id="toggle" class="ghost" title="Réduire ou agrandir le bandeau">▴</button>
      </div>`;
    root.getElementById('release').addEventListener('click', () => {
      if (typeof w.__skipperRelease === 'function') w.__skipperRelease('release');
    });
    root.getElementById('toggle').addEventListener('click', () => {
      state.expanded = !state.expanded;
      render();
    });
    state.host = host;
    state.root = root;
    document.documentElement.appendChild(host);
    render();
  };
  const watchTitle = () => {
    applyTitle();
    state.observer = new MutationObserver(() => {
      if (!document.documentElement.contains(state.host)) {
        state.host = null;
        mount();
      }
      applyTitle();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  const start = () => {
    mount();
    watchTitle();
  };
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
  w.__skipperIndicator = {
    update(next) {
      state.info = { ...state.info, ...next };
      render();
    },
    remove() {
      state.observer?.disconnect();
      state.host?.remove();
      if (document.title.startsWith(PREFIX)) document.title = document.title.slice(PREFIX.length);
      delete w.__skipperIndicator;
    },
  };
}

/** Retire l'indicateur (onglet rendu à la personne). */
export function removeIndicator() {
  if (window.__skipperIndicator) window.__skipperIndicator.remove();
}
