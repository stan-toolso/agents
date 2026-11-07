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

  var state = { picking: false, hovered: null, anchors: [], flash: null, flashUntil: 0 };

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
    if (state.picking) {
      if (state.hovered && state.hovered.isConnected) {
        var hr = state.hovered.getBoundingClientRect();
        ov.appendChild(el('div', { class: 'box', style: 'left:' + hr.left + 'px;top:' + hr.top + 'px;width:' + hr.width + 'px;height:' + hr.height + 'px' }));
        ov.appendChild(el('div', { class: 'label', style: 'left:' + Math.max(4, hr.left) + 'px;top:' + Math.max(4, hr.top - 18) + 'px', text: part(state.hovered) }));
      }
      ov.appendChild(el('div', { class: 'banner', text: 'Cliquez sur l’élément à commenter · Échap pour annuler' }));
    }
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
