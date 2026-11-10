// Chargé de façon bloquante dans <head> (fichier à part et non script en ligne : la Content-Security-Policy
// n'autorise que les scripts servis par l'application).
// Thème appliqué avant le premier rendu (pas de flash) : réglage de ce navigateur, sinon clair
// (thème par défaut) ; « system » suit le système.
try {
  var pref = localStorage.getItem('skipper.theme');
  var theme = pref === 'dark' ? 'dark' : pref === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f2ea' : '#14110e');
  var cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', theme);
} catch (e) {}
