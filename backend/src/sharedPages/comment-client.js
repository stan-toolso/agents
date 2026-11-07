/*
 * Skipper : commentaires ancrés sur une page partagée.
 * Injecté par le serveur dans chaque page servie à /api/shared/<id> (voir inject.ts) ; servi tel quel, sans build.
 * La page tourne dans un cadre en bac à sable (origine opaque, sans stockage ni cookie) : le script ne parle qu'au
 * cadre parent (l'application Skipper) par postMessage. Il ne fait rien quand la page est ouverte directement.
 *   parent → page : { skipperComments: 1, type: 'anchors' | 'pick' | 'cancel' | 'focus', ... }
 *   page → parent : { skipperComments: 1, type: 'ready' | 'picked' | 'cancelled' | 'pin' | 'found', ... }
 * L'interface vit dans un shadow DOM : elle ne touche ni aux styles ni au DOM de la page. Couleurs en dur : on est
 * dans la page publiée, pas dans l'application.
 */
(function () {
  'use strict';
  if (window.__skipperComments || window.parent === window) return;
  window.__skipperComments = true;

  var state = { picking: false, hovered: null, anchors: [], flash: null, flashUntil: 0, menu: null, pointer: 'mouse', menuPress: false };

  /* ---------- Sélecteurs (mêmes règles que les annotations des aperçus) ---------- */
  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }
  function goodClass(c) {
    return c && c.length < 40 && !/^(css|sc|jsx|svelte|astro)-|[0-9a-f]{6,}|__[a-zA-Z0-9]{5}$|:/.test(c);
  }
  function part(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}|^:/.test(el.id)) return '#' + esc(el.id);
    var classes = Array.prototype.filter.call(el.classList, goodClass).slice(0, 2);
    var s = tag + classes.map(function (c) { return '.' + esc(c); }).join('');
    var parent = el.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return s;
  }
  function selectorOf(el) {
    var parts = [];
    for (var cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      parts.unshift(part(cur));
      var sel = parts.join(' > ');
      if (parts[0].charAt(0) === '#' || unique(sel)) return sel;
      if (parts.length >= 8) break;
    }
    return parts.join(' > ');
  }
  function describe(el) {
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 200) text = text.slice(0, 200) + '…';
    return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: text };
  }
  function find(sel) {
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  /* ---------- Interface (shadow DOM) ---------- */
  var host = document.createElement('skipper-comments');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.box{position:fixed;pointer-events:none;border:2px solid #d97757;background:rgba(217,119,87,.12);border-radius:3px;transition:all .06s}' +
    '.box.flash{border-color:#2f81f7;background:rgba(47,129,247,.14);animation:f 1.6s ease-out}' +
    '@keyframes f{from{box-shadow:0 0 0 6px rgba(47,129,247,.35)}to{box-shadow:0 0 0 0 rgba(47,129,247,0)}}' +
    '.label{position:fixed;pointer-events:none;background:#d97757;color:#141414;font-size:11px;padding:1px 5px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}' +
    '.pin{position:fixed;pointer-events:auto;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50% 50% 50% 0;background:#d97757;color:#141414;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer;transform:rotate(-45deg)}' +
    '.pin span{transform:rotate(45deg)}' +
    '.pin.done{background:#8b949e}.pin.on{background:#2f81f7;color:#fff}' +
    '.pin:hover{filter:brightness(1.1)}' +
    '.menu{position:fixed;pointer-events:auto;background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);padding:4px;min-width:180px;max-width:calc(100vw - 16px);user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
    '.menu.touch{display:flex;min-width:0;padding:3px;border-radius:999px;background:#d97757;border-color:#d97757;color:#141414}' +
    '.item{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;color:inherit;font-size:13px;text-align:left;padding:7px 10px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.item:hover{background:#f3f4f6}.menu.touch .item{font-size:14px;font-weight:600;padding:8px 14px;border-radius:999px}.menu.touch .item:hover{background:rgba(0,0,0,.08)}' +
    '.sep{height:1px;background:#d0d7de;margin:4px 2px}' +
    '.banner{position:fixed;left:50%;transform:translateX(-50%);top:14px;pointer-events:none;background:#d97757;color:#141414;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:calc(100vw - 20px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '</style><div class="ov"></div>';
  var ov = root.querySelector('.ov');

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function send(msg) {
    msg.skipperComments = 1;
    window.parent.postMessage(msg, '*');
  }

  /* Calque : repères numérotés des commentaires ancrés, élément survolé, élément mis en avant. Redessiné au
     défilement, au redimensionnement et aux mutations (via requestAnimationFrame). */
  var raf = 0;
  function overlay() {
    raf = 0;
    ov.textContent = '';
    state.anchors.forEach(function (a) {
      var target = a.el && a.el.isConnected ? a.el : find(a.selector);
      a.el = target;
      if (!target) return;
      var r = target.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
      var pin = el('div', { class: 'pin' + (a.resolved ? ' done' : '') + (a.focused ? ' on' : ''), style: 'left:' + Math.max(12, r.left) + 'px;top:' + Math.max(12, r.top) + 'px', title: a.title || '', onclick: function (e) { e.stopPropagation(); send({ type: 'pin', id: a.id }); } }, [el('span', { text: String(a.n) })]);
      ov.appendChild(pin);
    });
    if (state.flash && state.flash.isConnected && Date.now() < state.flashUntil) {
      var fr = state.flash.getBoundingClientRect();
      ov.appendChild(el('div', { class: 'box flash', style: 'left:' + fr.left + 'px;top:' + fr.top + 'px;width:' + fr.width + 'px;height:' + fr.height + 'px' }));
    }
    if (state.menu) drawMenu();
    if (state.picking) {
      if (state.hovered && state.hovered.isConnected) {
        var hr = state.hovered.getBoundingClientRect();
        ov.appendChild(el('div', { class: 'box', style: 'left:' + hr.left + 'px;top:' + hr.top + 'px;width:' + hr.width + 'px;height:' + hr.height + 'px' }));
        ov.appendChild(el('div', { class: 'label', style: 'left:' + Math.max(4, hr.left) + 'px;top:' + Math.max(4, hr.top - 18) + 'px', text: part(state.hovered) }));
      }
      ov.appendChild(el('div', { class: 'banner', text: 'Cliquez sur l’élément à commenter · Échap pour annuler' }));
    }
  }
  /* ---------- Menu « Commenter » : texte sélectionné (appui long sur mobile) ou clic droit ---------- */
  function cleanText(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  function elementOf(node) {
    var e = node && node.nodeType === 1 ? node : node && node.parentElement;
    return e && e !== document.documentElement && e !== document.body ? e : null;
  }
  /* Sélection de texte courante dans la page (hors calque), ou null. */
  function currentSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var text = cleanText(sel.toString());
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var target = elementOf(range.commonAncestorContainer);
    if (!target || host.contains(target)) return null;
    return { range: range.cloneRange(), text: text, el: target };
  }
  /* Ancre d'une sélection : l'élément qui la contient, avec le texte sélectionné comme extrait. */
  function selectionAnchor(s) {
    var a = describe(s.el);
    a.text = s.text;
    return a;
  }
  function closeMenu() {
    if (!state.menu) return;
    state.menu = null;
    schedule();
  }
  function choose(anchor, target) {
    state.menu = null;
    state.flash = target;
    state.flashUntil = Date.now() + 1800;
    try {
      window.getSelection().removeAllRanges();
    } catch (e) {}
    schedule();
    send({ type: 'picked', anchor: anchor });
  }
  function drawMenu() {
    var m = state.menu;
    var box = el('div', { class: 'menu' + (m.touch ? ' touch' : ''), role: 'menu' });
    function item(label, fn) {
      var b = el('button', { class: 'item', type: 'button', role: 'menuitem', text: label });
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        state.menuPress = false;
        fn();
      });
      box.appendChild(b);
    }
    if (m.selection) item(m.touch ? '\uD83D\uDCAC Commenter' : '\uD83D\uDCAC Commenter la s\u00e9lection', function () { choose(selectionAnchor(m.selection), m.selection.el); });
    if (m.target && !m.touch) item('\uD83D\uDCCD Commenter cet \u00e9l\u00e9ment <' + m.target.tagName.toLowerCase() + '>', function () { choose(describe(m.target), m.target); });
    if (m.target && m.touch && !m.selection) item('\uD83D\uDCAC Commenter cet \u00e9l\u00e9ment', function () { choose(describe(m.target), m.target); });
    if (m.selection && !m.touch) {
      box.appendChild(el('div', { class: 'sep' }));
      item('Copier', function () {
        var text = m.selection.range.toString();
        closeMenu();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
          else document.execCommand('copy');
        } catch (e) {}
      });
    }
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (t) {
      box.addEventListener(t, function (e) {
        state.menuPress = true;
        // Garder la sélection : un appui dans le menu ne doit pas la défaire avant le clic (souris seulement ; pas de
        // preventDefault au toucher, il annulerait le clic).
        if (t === 'mousedown') e.preventDefault();
      });
    });
    ov.appendChild(box);
    // Position : au pointeur (clic droit), ou sous la sélection (mobile : la barre du navigateur est au-dessus).
    var w = box.offsetWidth, h = box.offsetHeight, x, y;
    if (m.touch && m.selection) {
      var rects = m.selection.range.getClientRects();
      var r = rects.length ? rects[rects.length - 1] : m.selection.range.getBoundingClientRect();
      var first = rects.length ? rects[0] : r;
      x = (first.left + r.right) / 2 - w / 2;
      y = r.bottom + 14;
      if (y + h > innerHeight - 8) y = first.top - h - 56;
    } else {
      x = m.x;
      y = m.y;
      if (x + w > innerWidth - 8) x = m.x - w;
      if (y + h > innerHeight - 8) y = m.y - h;
    }
    box.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    box.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(overlay);
  }

  /* Quels repères sont retrouvés dans cette version de la page (les autres sont signalés « introuvable »). */
  function reportFound() {
    var found = [];
    state.anchors.forEach(function (a) {
      if (find(a.selector)) found.push(a.id);
    });
    send({ type: 'found', ids: found });
  }

  /* ---------- Messages du parent ---------- */
  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.skipperComments !== 1) return;
    var m = e.data;
    if (m.type === 'anchors') {
      var list = Array.isArray(m.anchors) ? m.anchors.slice(0, 500) : [];
      state.anchors = list.map(function (a) {
        return a && typeof a === 'object' ? { id: str(a.id, 80), n: Number(a.n) || 0, selector: str(a.selector, 500), resolved: !!a.resolved, focused: !!a.focused, title: str(a.title, 200), el: null } : null;
      }).filter(Boolean);
      schedule();
      reportFound();
    } else if (m.type === 'pick') {
      state.picking = true;
      state.menu = null;
      state.hovered = null;
      schedule();
    } else if (m.type === 'cancel') {
      state.picking = false;
      state.hovered = null;
      schedule();
    } else if (m.type === 'focus') {
      var target = find(str(m.selector, 500));
      if (!target) return;
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (err) {
        target.scrollIntoView();
      }
      state.flash = target;
      state.flashUntil = Date.now() + 1800;
      schedule();
      setTimeout(schedule, 1900);
    }
  });

  /* ---------- Choix d'un élément ---------- */
  function ours(e) {
    return e.composedPath && e.composedPath().indexOf(host) >= 0;
  }
  function targetAt(x, y) {
    host.style.display = 'none';
    var t = document.elementFromPoint(x, y);
    host.style.display = '';
    return t && t !== document.documentElement && t !== document.body ? t : null;
  }
  document.addEventListener('mousemove', function (e) {
    if (!state.picking || ours(e)) return;
    var t = targetAt(e.clientX, e.clientY);
    if (t !== state.hovered) {
      state.hovered = t;
      schedule();
    }
  }, true);
  /* En mode choix, un clic choisit l'élément au lieu de l'activer (lien, bouton, formulaire). */
  function swallow(e) {
    if (!state.picking || ours(e)) return;
    // Pas de preventDefault sur le toucher : il annulerait le clic qui choisit l'élément (et le défilement de la page).
    if (e.type.slice(0, 5) !== 'touch') e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart', 'touchend', 'submit'].forEach(function (type) {
    document.addEventListener(type, swallow, { capture: true, passive: false });
  });
  document.addEventListener('click', function (e) {
    if (!state.picking || ours(e)) return;
    swallow(e);
    var t = targetAt(e.clientX, e.clientY);
    if (!t) return;
    state.picking = false;
    state.hovered = null;
    state.flash = t;
    state.flashUntil = Date.now() + 1800;
    schedule();
    send({ type: 'picked', anchor: describe(t) });
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !state.picking) return;
    state.picking = false;
    state.hovered = null;
    schedule();
    send({ type: 'cancelled' });
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.menu) closeMenu();
  }, true);

  document.addEventListener('pointerdown', function (e) {
    if (ours(e)) return;
    state.pointer = e.pointerType || 'mouse';
    state.menuPress = false;
    if (state.menu && !state.menu.touch) closeMenu();
  }, true);
  document.addEventListener('touchstart', function (e) {
    if (!ours(e)) state.pointer = 'touch';
  }, { capture: true, passive: true });

  /* Clic droit (ordinateur) : notre menu à la place de celui du navigateur ; Maj + clic droit garde le sien.
     Appui long (mobile) : on laisse le navigateur sélectionner le texte, le menu suit la sélection. */
  document.addEventListener('contextmenu', function (e) {
    if (state.picking || ours(e) || e.shiftKey) return;
    var target = targetAt(e.clientX, e.clientY);
    if (state.pointer === 'touch') {
      // Appui long sur une image ou un bloc sans texte : pas de sélection, on propose l'élément.
      var x = e.clientX, y = e.clientY;
      setTimeout(function () {
        if (currentSelection() || !target) return;
        state.menu = { touch: true, x: x - 70, y: y + 24, target: target, selection: null };
        schedule();
      }, 450);
      return;
    }
    if (!target && !currentSelection()) return;
    e.preventDefault();
    var s = currentSelection();
    // La sélection ne compte que si le clic droit tombe dessus (ou à côté, dans le même bloc).
    if (s && target && !s.el.contains(target) && !target.contains(s.el)) s = null;
    state.menu = { touch: false, x: e.clientX, y: e.clientY, target: target, selection: s };
    schedule();
  }, true);

  /* Sélection au toucher : bouton « Commenter » sous le texte sélectionné, mis à jour quand on étend la sélection. */
  var selTimer = 0;
  document.addEventListener('selectionchange', function () {
    if (state.picking) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(function () {
      var s = currentSelection();
      if (s && state.pointer === 'touch') {
        state.menu = { touch: true, target: null, selection: s };
        schedule();
      } else if (!s && state.menu && state.menu.selection && !state.menuPress) {
        closeMenu();
      }
    }, 200);
  });
  addEventListener('scroll', function () {
    if (state.menu && !state.menu.touch) closeMenu();
  }, true);
  addEventListener('blur', function () {
    if (state.menu && !state.menu.touch) closeMenu();
  });
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);

  /* ---------- Démarrage ---------- */
  function start() {
    (document.body || document.documentElement).appendChild(host);
    // Les pages qui réécrivent tout le <body> (rendu côté client) peuvent retirer le calque : on le remet.
    new MutationObserver(function () {
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      if (state.anchors.length) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    send({ type: 'ready' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
