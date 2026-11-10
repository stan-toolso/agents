/*
 * Lecteur de diapositives injecte dans un artefact « slides » servi par Skipper (voir inject.ts). Le deck est un
 * fichier HTML dont chaque diapositive est une <section class="slide"> (ou [data-slide]) de 1280 x 720 ; le lecteur
 * n'en affiche qu'une a la fois, a l'echelle de la fenetre, et gere clavier, balayage, vue en grille, mode
 * presentation et impression (une page par diapositive). Dans un cadre, il dialogue avec l'application par
 * postMessage (origine opaque : pas d'autre moyen). Modes (attribut data-mode du script) : view (defaut), thumb
 * (apercu reduit : premiere diapositive, sans marge) et print (toutes les diapositives, puis window.print()).
 * ASCII seulement, et jamais la fin de balise script dans le source (voir inject.ts).
 */
(function () {
  if (window.__skipperSlides) return;
  window.__skipperSlides = true;
  var W = 1280, H = 720;
  var script = document.currentScript;
  var mode = (script && script.getAttribute('data-mode')) || 'view';
  var embedded = window.parent !== window;
  var slides = [];
  var index = 0;
  var grid = false;
  var presenting = false;
  var gridEl = null;

  function text(el) {
    var t = el.getAttribute('data-title');
    if (!t) {
      var h = el.querySelector('h1, h2, h3');
      t = h ? h.textContent : el.textContent;
    }
    return (t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function findSlides() {
    var list = document.querySelectorAll('section.slide, [data-slide]');
    if (!list.length) list = Array.prototype.filter.call(document.body.children, function (el) { return el.tagName === 'SECTION'; });
    return Array.prototype.slice.call(list);
  }

  function css() {
    var st = document.createElement('style');
    st.setAttribute('data-skipper-slides-style', '');
    var common = 'aside.notes,.notes{display:none!important}';
    if (mode === 'print') {
      st.textContent = common + '@page{size:1280px 720px;margin:0}html,body{margin:0!important;padding:0!important;background:#fff!important}' +
        'section.slide,[data-slide]{display:block!important;position:relative!important;width:1280px!important;height:720px!important;overflow:hidden!important;box-sizing:border-box!important;page-break-after:always;break-after:page;margin:0!important}' +
        'body>:not(section.slide):not([data-slide]):not(script):not(style){display:none!important}';
    } else {
      st.textContent = common + 'html,body{margin:0!important;padding:0!important;height:100%!important;overflow:hidden!important;background:' + (mode === 'thumb' ? '#fff' : '#e9e9e6') + '!important}' +
        'body>:not(section.slide):not([data-slide]):not(script):not(style):not(.skp-grid):not(skipper-comments){display:none!important}' +
        'section.slide,[data-slide]{display:none!important;box-sizing:border-box!important;width:1280px!important;height:720px!important;overflow:hidden!important;margin:0!important}' +
        ':where(section.slide,[data-slide]){background:#fff}' +
        'section.slide.skp-current,[data-slide].skp-current{display:block!important;position:fixed!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%) scale(var(--skp-scale,1))!important;transform-origin:center center!important;' + (mode === 'thumb' ? '' : 'box-shadow:0 12px 40px rgba(0,0,0,.18);') + '}' +
        '.skp-grid{position:fixed;inset:0;overflow:auto;padding:28px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:22px;align-content:start;box-sizing:border-box;background:#e9e9e6}' +
        '.skp-cell{display:flex;flex-direction:column;gap:6px;cursor:pointer}' +
        '.skp-cell .skp-cell-frame{outline:2px solid transparent;outline-offset:3px}' +
        '.skp-cell:hover .skp-cell-frame,.skp-cell.on .skp-cell-frame{outline-color:#2a78d6}' +
        '.skp-cell-frame{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#fff;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.14)}' +
        '.skp-cell-frame>section,.skp-cell-frame>[data-slide]{display:block!important;position:absolute!important;left:0!important;top:0!important;width:1280px!important;height:720px!important;transform-origin:0 0!important;pointer-events:none}' +
        '.skp-cell-n{font:12px/1.2 system-ui,sans-serif;color:#52514e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
    }
    document.head.appendChild(st);
  }

  function fit() {
    var pad = mode === 'thumb' || presenting ? 1 : 0.94;
    var s = Math.min(window.innerWidth / W, window.innerHeight / H) * pad;
    document.documentElement.style.setProperty('--skp-scale', String(s));
    if (gridEl) {
      var cells = gridEl.querySelectorAll('.skp-cell-frame');
      for (var i = 0; i < cells.length; i++) {
        var inner = cells[i].firstElementChild;
        if (inner) inner.style.transform = 'scale(' + cells[i].clientWidth / W + ')';
      }
    }
  }

  function post(msg) {
    if (!embedded) return;
    msg.skipperSlides = 1;
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* rien */ }
  }

  function show(i, silent) {
    if (!slides.length) return;
    i = Math.max(0, Math.min(slides.length - 1, i));
    for (var k = 0; k < slides.length; k++) slides[k].classList.toggle('skp-current', k === i);
    index = i;
    if (!silent) post({ type: 'slide', index: index, count: slides.length });
    if (mode === 'view') try { history.replaceState(null, '', '#' + (index + 1)); } catch (e) { /* rien */ }
  }

  function openGrid() {
    if (grid) return;
    grid = true;
    gridEl = document.createElement('div');
    gridEl.className = 'skp-grid';
    slides.forEach(function (s, i) {
      var cell = document.createElement('div');
      cell.className = 'skp-cell' + (i === index ? ' on' : '');
      cell.setAttribute('data-index', String(i));
      var frame = document.createElement('div');
      frame.className = 'skp-cell-frame';
      var clone = s.cloneNode(true);
      clone.classList.remove('skp-current');
      Array.prototype.forEach.call(clone.querySelectorAll('script'), function (x) { x.parentNode.removeChild(x); });
      frame.appendChild(clone);
      var n = document.createElement('div');
      n.className = 'skp-cell-n';
      n.textContent = String(i + 1) + (text(s) ? ' · ' + text(s) : '');
      cell.appendChild(frame);
      cell.appendChild(n);
      cell.addEventListener('click', function () { closeGrid(); show(i); });
      gridEl.appendChild(cell);
    });
    document.body.appendChild(gridEl);
    fit();
    post({ type: 'grid', on: true });
  }

  function closeGrid() {
    if (!grid) return;
    grid = false;
    if (gridEl && gridEl.parentNode) gridEl.parentNode.removeChild(gridEl);
    gridEl = null;
    post({ type: 'grid', on: false });
  }

  function onKey(e) {
    if (mode !== 'view') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    var k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Enter') { if (grid) return; e.preventDefault(); show(index + 1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') { if (grid) return; e.preventDefault(); show(index - 1); }
    else if (k === 'Home') { e.preventDefault(); show(0); }
    else if (k === 'End') { e.preventDefault(); show(slides.length - 1); }
    else if (k === 'Escape') { if (grid) closeGrid(); }
    else if (k === 'g' || k === 'G') { grid ? closeGrid() : openGrid(); }
  }

  var touchX = null, touchY = null;
  function onTouchStart(e) { var t = e.touches[0]; touchX = t.clientX; touchY = t.clientY; }
  function onTouchEnd(e) {
    if (touchX == null || grid) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
  }

  /* En presentation (plein ecran demande par l'application), un clic avance ; sinon on laisse la page recevoir les clics (liens, commentaires). */
  function onClick(e) {
    if (!presenting || grid) return;
    var a = e.target && e.target.closest ? e.target.closest('a, button, input, textarea, select, [data-no-advance]') : null;
    if (a) return;
    show(index + (e.clientX < window.innerWidth / 4 ? -1 : 1));
  }

  function onMessage(e) {
    if (!embedded || e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.skipperSlides !== 1) return;
    if (d.type === 'goto' && typeof d.index === 'number') { closeGrid(); show(d.index); }
    else if (d.type === 'next') { closeGrid(); show(index + 1); }
    else if (d.type === 'prev') { closeGrid(); show(index - 1); }
    else if (d.type === 'grid') { d.on ? openGrid() : closeGrid(); }
    else if (d.type === 'present') { presenting = !!d.on; if (presenting) closeGrid(); fit(); }
    else if (d.type === 'focus') { try { window.focus(); } catch (x) { /* rien */ } }
  }

  function init() {
    slides = findSlides();
    css();
    if (!slides.length) { post({ type: 'ready', count: 0, titles: [], index: 0 }); return; }
    if (mode === 'print') {
      setTimeout(function () { try { window.print(); } catch (e) { /* rien */ } }, 400);
      return;
    }
    var start = 0;
    if (mode === 'view') {
      var m = /^#(\d+)$/.exec(location.hash);
      if (m) start = Math.max(0, parseInt(m[1], 10) - 1);
    }
    show(start, true);
    fit();
    window.addEventListener('resize', fit);
    if (mode === 'view') {
      document.addEventListener('keydown', onKey);
      document.addEventListener('touchstart', onTouchStart, { passive: true });
      document.addEventListener('touchend', onTouchEnd, { passive: true });
      document.addEventListener('click', onClick);
      window.addEventListener('message', onMessage);
    }
    post({ type: 'ready', count: slides.length, titles: slides.map(text), index: index });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
