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
