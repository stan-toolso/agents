/*
 * Skipper : artefact affiché comme bloc d'un tableau de bord (mode `embed=1` de /api/shared/<id>, voir inject.ts).
 * La page tourne dans un cadre en bac à sable (origine opaque, sans stockage ni cookie) : le script ne parle qu'au
 * cadre parent (l'application Skipper) par postMessage. Il ne fait rien quand la page est ouverte directement.
 *   page → parent : { skipperWidget: 1, type: 'ready' } | { type: 'size', height } | { type: 'action', action, ... }
 *   parent → page : { skipperWidget: 1, type: 'context', context }
 * L'API vue par la page (Skipper.context, Skipper.onContext, Skipper.navigate, Skipper.openSession, Skipper.summon)
 * est définie par le script injecté en tête (inject.ts, `injectEmbed`), avant tout script de la page ; celui-ci,
 * injecté avant </body>, mesure la hauteur du contenu et relaie les mises à jour du contexte.
 */
(function () {
  'use strict';
  if (window.__skipperWidget || window.parent === window) return;
  window.__skipperWidget = true;
  var S = (window.Skipper = window.Skipper || {});
  S.context = S.context || {};
  var listeners = (S._ctxListeners = S._ctxListeners || []);
  if (!S.onContext) {
    S.onContext = function (fn) {
      listeners.push(fn);
    };
  }
  function send(msg) {
    msg.skipperWidget = 1;
    window.parent.postMessage(msg, '*');
  }

  var last = -1;
  function measure() {
    var d = document.documentElement;
    var b = document.body;
    var h = Math.max(b ? b.scrollHeight : 0, b ? b.offsetHeight : 0, d ? d.scrollHeight : 0);
    if (h > 0 && Math.abs(h - last) > 1) {
      last = h;
      send({ type: 'size', height: h });
    }
  }
  function start() {
    send({ type: 'ready' });
    measure();
    if (window.ResizeObserver && document.body) {
      var ro = new ResizeObserver(function () {
        measure();
      });
      ro.observe(document.body);
      ro.observe(document.documentElement);
    } else {
      setInterval(measure, 1000);
    }
    window.addEventListener('load', measure);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.skipperWidget !== 1 || ev.source !== window.parent) return;
    if (m.type === 'context' && m.context && typeof m.context === 'object') {
      S.context = m.context;
      if (m.context.theme) document.documentElement.setAttribute('data-theme', m.context.theme);
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](S.context);
        } catch (e) {
          /* ignore */
        }
      }
      measure();
    }
  });
})();
