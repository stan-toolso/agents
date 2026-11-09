# Skipper pour Chrome

Extension Chrome (Manifest V3, sans build) qui laisse les sessions Skipper agir dans les onglets que la personne leur
confie : lire la page, cliquer, saisir, faire défiler, capturer, lire la console. La documentation complète est dans la
section « Navigateur Chrome de la personne » du README du dépôt.

- `background.js` : service worker. Il gère la connexion WebSocket au serveur (`/api/chrome/connect`, jeton `skc_…`),
  l'appairage par la page `/chrome/connect` de Skipper et les messages de la popup.
- `commands.js` : les commandes des sessions, les groupes d'onglets (« Skipper » pour les onglets confiés, « Skipper ·
  session » pour ceux qu'une session ouvre) et le pilotage par `chrome.debugger` (CDP).
- `page.js` : les fonctions évaluées dans la page (instantané avec références `data-skipper-ref`, localisation d'un
  élément, défilement). Elles doivent rester autonomes, car elles sont sérialisées avec `toString()`.
- `popup.*` : la popup (état, connexion, « Confier cet onglet à Skipper »).
- `config.json` : adresse du serveur par défaut. Le serveur la remplace dans l'archive qu'il sert
  (`/api/chrome/extension.zip`).
- `test/e2e.mjs` : essai de bout en bout dans un vrai Chromium (mode d'emploi en tête du fichier). Il n'est pas inclus
  dans l'archive.

Pour développer, chargez ce dossier « non empaqueté » dans `chrome://extensions`. Ensuite, cliquez sur « Recharger »
après chaque modification.
