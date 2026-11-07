# Mise en production — skipper.toolso.io

Skipper tourne sur la **cellule `skipper-1`** : un serveur dédié Scaleway Elastic Metal (EM-A116X-SSD, zone
`fr-par-2`, adresse `51.158.36.16`, Ubuntu 24.04 x86_64, 4 cœurs / 8 threads, 32 Go, 2 × 1 To en RAID 1), avec
PostgreSQL local, Docker pour les conteneurs des projets, nginx et sauvegardes vers Object Storage. Installation,
disposition, mise à jour sans interruption (bleu/vert), sauvegardes et restauration : **`deploy/cellule/README.md`**,
qui fait référence. Ce fichier rassemble ce qui ne dépend pas de la machine (Google, GitHub, conteneurs, nginx,
journaux, aperçus). Il n'y a pas de CD : la CI GitHub Actions (`.github/workflows/ci.yml`) vérifie typecheck, build
et tests à chaque push, le déploiement se lance à la main (`deploy.sh`).

## Accès

- **SSH** : `ssh ubuntu@51.158.36.16` (sudo sans mot de passe), puis `sudo -iu skipper` pour l'utilisateur
  applicatif. Depuis une session d'agent : élément `skipper-1` du coffre (voir la bibliothèque de contexte,
  `dev/deploiement` et `dev/cellule-skipper-1`).
- **Web** : https://skipper.toolso.io, connexion par **Google OAuth**, Microsoft, GitHub ou mot de passe (voir « Connexion des utilisateurs »).
- **Base** : PostgreSQL 17 local, base et rôle `skipper`, `DATABASE_URL` dans `/etc/skipper/db.env` (lisible par
  `skipper` seulement). Interroger : `sudo -u postgres psql -d skipper`.
- **DNS** : enregistrements A `skipper.toolso.io` et `*.apercu.skipper.toolso.io` vers `51.158.36.16` dans la zone
  Route 53 de toolso.io. Certificats Let's Encrypt : `skipper.toolso.io` (greffon nginx, renouvellement automatique)
  et `*.apercu.skipper.toolso.io` (défi DNS-01, voir « Aperçus des branches »).

## Disposition sur le serveur

Voir le tableau « Disposition » de `deploy/cellule/README.md`. L'essentiel : clone et `.env` dans
`/home/skipper/skipper`, instances `skipper@blue` (port 4101) et `skipper@green` (4102) dans
`/home/skipper/skipper-blue` et `skipper-green`, workspaces (avec la clé maîtresse `.secret-key` et les pièces
jointes) dans `/home/skipper/skipper-workspaces`, front dans `/var/www/skipper`, site nginx
`/etc/nginx/sites-available/skipper` (modèle `deploy/cellule/templates/nginx-site.conf`), CLI Claude Code de
l'utilisateur `skipper` dans `~/.local/bin/claude`. Le `.env` fixe notamment `SHELL=/bin/bash`,
`VITE_GRAPHQL_URL=https://skipper.toolso.io/graphql` (lu par Vite au build), `APP_URL`, `API_URL` et les
identifiants Google.

## Connexion des utilisateurs

Les utilisateurs se connectent avec Google. La configuration existe dans la console Google Cloud,
projet **Skipper** (`skipper-510112`, organisation toolso.io, compte de facturation Toolso) :

- **Google Auth Platform → Audience** : « Externe », statut « En production », depuis le 2026-09-29
  (auparavant « Interne », ce qui bloquait le rattachement de comptes gmail.com à un projet, erreur
  `org_internal`). L'application n'est pas validée par Google : l'écran de consentement affiche un
  avertissement « Google n'a pas validé cette application », à passer par « Paramètres avancés » puis
  « Accéder à Skipper » ; les jetons n'expirent pas et la limite est de 100 utilisateurs ayant accordé
  des portées sensibles (compteur sur la page Audience). Ne pas revenir en « Test » : dans ce mode les
  jetons de rafraîchissement expirent au bout de 7 jours. La connexion à Skipper reste réservée aux
  adresses invitées sur un projet, quelle que soit l'audience Google.
- **Google Auth Platform → Branding** : page d'accueil `https://skipper.toolso.io` et politique de
  confidentialité `https://skipper.toolso.io/privacy.html` (`frontend/public/privacy.html`, servie sans
  authentification et exclue du repli du service worker), exigées pour le statut « En production ».
- **Google Auth Platform → Clients** : client « Skipper web » (application Web) avec les URI de
  redirection `https://skipper.toolso.io/auth/google/callback` et
  `http://localhost:4000/auth/google/callback` (développement). Le même client et le même callback
  servent à relier un compte Google à un projet (Gmail, Drive) : pour cela, activer les API **Gmail
  API** et **Google Drive API** dans « API et services » du projet Google Cloud (fait le 2026-09-29).
  Portées demandées : `gmail.readonly` (lecture) ; en écriture, `gmail.send`, `gmail.compose`
  (brouillons) et `gmail.modify` (corbeille, archivage, libellés, lu / non lu) ; `drive.readonly` ou `drive`. Si l'écran « Accès aux données »
  de Google Auth Platform les déclare, y ajouter `gmail.compose` et `gmail.modify` (portées restreintes,
  comme `gmail.readonly`). Un compte relié en écriture avant leur ajout doit être reconnecté.
- Le secret du client n'est visible qu'à sa création : il est dans le `.env` du poste de
  développement (jamais versionné). Le reporter dans `~/skipper/.env` sur le serveur
  (`GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...`), puis `deploy.sh --force` (nouvelle instance).
  S'il est perdu : dans le client, « Add secret » en génère un nouveau.

**Autres modes de connexion** (voir README, « Utilisateurs et droits ») :

- **E-mail et mot de passe** : actif sans rien configurer (`PASSWORD_LOGIN=off` pour le couper). Le lien « Mot de
  passe oublié » n'est envoyé que si un serveur SMTP est configuré (Paramètres › Serveur, ou `SMTP_URL`) ; sinon un
  administrateur crée le lien depuis la page Utilisateurs (icône lien) et le transmet. nginx doit transmettre
  `X-Real-IP` ou `X-Forwarded-For` (freinage des essais par IP).
- **Microsoft** : portail Azure → Microsoft Entra ID → Inscriptions d'applications → Nouvelle inscription « Skipper »,
  types de comptes « Comptes dans un annuaire organisationnel et comptes Microsoft personnels » (ou un seul annuaire),
  URI de redirection plateforme **Web** `https://skipper.toolso.io/auth/microsoft/callback` (et
  `http://localhost:4000/auth/microsoft/callback`). Certificats et secrets → nouveau secret client. Dans `.env` :
  `MICROSOFT_CLIENT_ID` (ID d'application), `MICROSOFT_CLIENT_SECRET` (valeur du secret, à renouveler avant son
  échéance), `MICROSOFT_TENANT` (`common`, ou l'ID de l'annuaire pour le réserver à ses comptes). Facultatif : dans
  Configuration de jetons, ajouter la revendication facultative `xms_edov` (id_token) pour que les adresses des
  annuaires au domaine vérifié soient reconnues sans liaison manuelle.
- **GitHub** : Settings → Developer settings → OAuth Apps → New OAuth App (de préférence dans l'organisation),
  Authorization callback URL `https://skipper.toolso.io/auth/github/callback` (une OAuth App n'a qu'un callback : une
  seconde pour le développement). Dans `.env` : `GITHUB_LOGIN_CLIENT_ID`, `GITHUB_LOGIN_CLIENT_SECRET`. Ne pas
  réutiliser `GITHUB_CLIENT_ID` (connexion par code des comptes git, souvent l'identifiant public du CLI GitHub).

Après modification du `.env` : `deploy.sh --force` (nouvelle instance). Le démarrage journalise les modes actifs
(`[auth] connexion : Google, Microsoft, …`).

Seules les adresses invitées sur un projet peuvent se connecter. La migration `011_users.sql` crée
`stan@toolso.io` administrateur de l'application et de tous les projets existants ; les autres
utilisateurs sont invités depuis la page d'un projet (bloc « Membres »). Le site nginx doit
proxifier `/auth/` vers le backend (bloc présent dans `deploy/cellule/templates/nginx-site.conf`).

## Authentification Claude

Chaque personne connecte **son** abonnement ou sa clé API : Paramètres → Claude → **Se connecter
avec Claude** (le backend pilote `claude setup-token` avec le CLI installé pour l'utilisateur
`skipper`, `~/.local/bin/claude` ; le jeton obtenu est rangé dans le coffre personnel de la personne
comme jeton applicatif, chiffré avec la clé `/home/skipper/skipper-workspaces/.secret-key`, à
sauvegarder avec la base), ou une clé API Anthropic déposée dans son coffre et choisie dans la même
page. Il n'y a plus de compte du serveur partagé : une session n'utilise que les identifiants de son
propriétaire, et les identifiants du compte `skipper` (`/home/skipper/.claude/`) ne sont plus montés
dans les conteneurs. Les réglages Claude et GitHub de l'ancienne version sont repris au premier
démarrage dans le coffre et les réglages du premier administrateur.

## Dépôts git privés des projets

Deux possibilités.

**Connexion GitHub depuis l'interface (recommandé)** : Paramètres → GitHub, **par personne**, un ou
plusieurs comptes. Le plus simple est la **connexion par code** (device flow ; par défaut avec
l'identifiant public du CLI GitHub, ou avec une OAuth App à vous — Settings → Developer settings →
OAuth Apps, « Enable Device Flow » coché — dont le client id va dans `GITHUB_CLIENT_ID` du `.env` ;
`GITHUB_CLIENT_ID=none` désactive ce mode). Sinon, un **jeton d'accès personnel** déposé dans le coffre
(élément « jeton applicatif », service GitHub ; Settings → Developer settings → Personal access tokens ;
« fine-grained » limité aux dépôts voulus avec *Contents : Read and write* et, pour les pull requests
du panneau git, *Pull requests : Read and write* plus *Commit statuses* et *Checks* en lecture ; ou
« classic » avec la portée `repo`) puis choisi dans la page. Le jeton est chiffré dans le coffre (même
clé que les autres secrets) et injecté dans les commandes git de la personne et de ses sessions pour
les URL https de github.com ; pour chaque dépôt, le compte retenu est celui qui le possède (identifiant
ou organisation), sinon le compte par défaut. Les projets utilisent alors l'URL https du dépôt, et le
formulaire de projet propose la liste des dépôts des comptes connectés.

Les agents reçoivent ce jeton via un credential helper git (variables `GIT_CONFIG_*`) ainsi qu'une
identité de commit (config git globale de l'utilisateur `skipper`, sinon le compte GitHub connecté) :
ils peuvent donc commiter et pousser en https, y compris dans un conteneur. **Curso est passé en
https** (`https://github.com/stan-toolso/Curso.git`) ; la deploy key ci-dessous reste installée mais
n'est plus utilisée.

**GitLab** (gitlab.com ou instance auto-hébergée) : Paramètres → GitLab, par personne. Un **jeton d'accès
personnel** (Preferences → Access tokens, portées `api` et `write_repository`) déposé dans le coffre (jeton
applicatif, service GitLab) puis choisi dans la page avec l'adresse de l'instance. La **connexion par code**
n'apparaît que si une application OAuth de l'instance est configurée (Admin ou Preferences → Applications,
portées `api`, `read_repository`, `write_repository`, non confidentielle, GitLab 17.2+ pour le device flow) :
`GITLAB_CLIENT_ID` dans le `.env`, plus `GITLAB_URL` pour une instance autre que gitlab.com et
`GITLAB_CLIENT_SECRET` si l'application est confidentielle. Les agents reçoivent `GITLAB_TOKEN`, `GITLAB_HOST` et
un credential helper pour l'instance.

**Clé de déploiement par dépôt (repli)** : pour un dépôt hors du compte connecté ou sans OAuth App.
Il faut une **clé de déploiement en lecture seule** dédiée, avec un alias SSH. Attention : un projet
en **conteneur Docker** n'a pas accès aux clés SSH de l'hôte ; utiliser l'https avec le jeton. Exemple pour Curso (déjà en place : clé `~/.ssh/curso-deploy`, alias
`github-curso`) :

```bash
# Sur le serveur
ssh-keygen -t ed25519 -N "" -C "skipper-server-<projet>-deploy" -f ~/.ssh/<projet>-deploy
printf "\nHost github-<projet>\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/<projet>-deploy\n  IdentitiesOnly yes\n" >> ~/.ssh/config
cat ~/.ssh/<projet>-deploy.pub
# Depuis le poste (droits admin sur le dépôt)
gh repo deploy-key add <clé>.pub --repo <org>/<repo> --title "Skipper (skipper.toolso.io, lecture seule)"
```

Dans Skipper, l'URL git du projet doit alors être `git@github-<projet>:<org>/<repo>.git` (pas
l'URL https). Un dossier principal vide est cloné automatiquement à la prochaine préparation du
dossier ou création du dossier d'une session.

## Conteneurs des projets (Docker obligatoire)

Tout projet tourne dans son conteneur Docker : sessions, terminaux et commandes n'ont aucun mode
d'exécution directe sur le serveur. Docker et l'image de base sont donc indispensables (installés
depuis le 29/09/2026 ; l'image pèse ~1 Go plus les caches des projets). Mise en place :

```bash
# Sur le serveur, en tant que skipper (sudoer)
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker skipper        # puis se reconnecter
cd ~/skipper && docker build -t skipper-runner:latest deploy/runner
```

Les limites par défaut (`SKIPPER_RUNNER_MEMORY`, 768m en production ; `SKIPPER_RUNNER_CPUS`, vide :
aucun plafond CPU, voir plus bas) se règlent dans le `.env`, et par projet dans son formulaire
(« Mémoire », « CPU »), appliqués à la création du conteneur et à chaud au conteneur existant. **Un conteneur est partagé par toutes les sessions du projet** : chaque CLI
Claude Code prend ≈ 250 Mo, et les agents y lancent aussi `npm ci` (≈ 400 Mo), `tsc`, `vite build`.
Au-delà de la limite, le noyau tue des processus du conteneur : commandes interrompues et sessions
en erreur ; Skipper l’explique alors dans le transcript (« le conteneur du projet a dépassé sa limite
mémoire »). Réglages en place depuis le 30/09/2026 :
Skipper 2g (plusieurs agents buildent en parallèle, chacun dans son dossier), SUF 1500m (navigateur),
Curso 768m (défaut). Pour vérifier et ajuster sans couper les sessions :

```bash
docker stats --no-stream                                  # mémoire utilisée / limite par conteneur
sudo journalctl -k -b | grep "Killed process"              # processus tués faute de mémoire
docker update --memory 2g --memory-swap 4g skipper-<slug>  # limite relevée à chaud, sans redémarrage
```

Modifier les limites depuis la page du projet (carte « Environnement d'exécution », « Modifier ») ou
son formulaire les enregistre **et** les applique à chaud (`docker update`, swap = 2 × mémoire). Un
`docker update` lancé à la main ne vaut que pour le conteneur en cours : reporter la même valeur dans
le projet, sinon elle est perdue à la prochaine recréation. La même carte montre la mémoire et le CPU
du conteneur, les processus `claude` par session et le nombre de processus tués faute de mémoire ;
une notification avertit quand un conteneur reste au-dessus de 90 % de sa limite plus d'une minute.

**Dimensionner la limite d'un projet** : c'est le nombre de sessions ouvertes, plus que les builds,
qui remplit le conteneur (constat du 01/10/2026 : 5 processus `claude` de 225 à 293 Mo, dont 3 de
sessions inactives). Compter :

- ≈ 250 Mo par session Claude ouverte (même inactive), plus 300 à 500 Mo avec le navigateur headless ;
- ≈ 400 Mo pour un `npm ci`, 400 à 900 Mo pour un `tsc`, ≈ 900 Mo pour un `vite build` ;
- une marge de 20 %.

Exemples : 2 sessions sans build → 768m ; 4 sessions dont une qui builde → 2g ; projet avec
navigateur et 3 sessions → 1500m à 2g. Terminer les sessions inutiles libère plus vite qu'un
relèvement de limite (la somme des limites peut dépasser la RAM du serveur).
Reconstruire l'image met à jour le CLI Claude Code des conteneurs ; « Recréer » sur la page du
projet applique la nouvelle image : les sessions en cours du projet sont interrompues (pas en erreur) puis
reprises d'elles-mêmes dès que le nouveau conteneur tourne, les terminaux ouverts sont fermés.

**CPU** : par défaut un conteneur n'a **pas de plafond CPU** : les cœurs du serveur sont partagés
équitablement (ordonnanceur CFS) entre les conteneurs et le backend, et un projet seul actif dispose
de toute la machine. Jusqu'au 24/10/2026 le défaut était `--cpus 1` : les cinq sessions du projet
Skipper et leurs `npm ci`, `tsc` et `vite build` se partageaient un seul cœur sur les deux du
serveur, bridé 94 % du temps pendant ces commandes, d'où des sessions très lentes. Un plafond (champ
« CPU » du projet, ex. `1` ou `0.5`) reste possible pour un projet qui ne doit pas gêner les autres ;
le changer s'applique à chaud (`docker update`) et marque le conteneur « à recréer » (fait dès que le
projet est inactif). Les conteneurs créés avec l'ancien défaut sont ainsi recréés sans plafond au
premier déploiement, dès qu'ils sont inactifs. La carte « Environnement d'exécution » montre la
pression CPU du conteneur (PSI `cpu.pressure` : part du temps où un processus attendait le
processeur, bridé ou en concurrence) et avertit au-delà de 25 % ; une notification
`container.cpu_saturated` part quand elle dépasse 50 % pendant plus de cinq minutes. Le vrai plafond
est alors la machine (skipper-1 : 8 threads, 32 Go) : si plusieurs sessions en parallèle sont l'usage
courant, c'est l'instance qu'il faut agrandir. Pour mesurer sur le serveur :

```bash
CG=/sys/fs/cgroup/system.slice/docker-$(docker inspect skipper-<slug> --format '{{.Id}}').scope
cat $CG/cpu.pressure                                   # some avg60 = pression CPU affichée par la carte
grep -E 'nr_periods|nr_throttled' $CG/cpu.stat         # périodes bridées par un plafond --cpus (0 sans plafond)
cat /proc/pressure/cpu                                 # pression CPU de toute la machine
```

## Procédure de déploiement

```bash
sudo -iu skipper ~/skipper/deploy/cellule/deploy.sh      # origin/main ; --ref <réf>, --force : voir deploy/cellule/README.md
```

Depuis une session d'agent, lancer le script détaché et suivre `~/deploy-logs/latest.log` (détails dans
`deploy/cellule/README.md`, « Mettre à jour »). `deploy.sh` construit la nouvelle version dans le dossier de l'autre
couleur, la démarre (elle applique les migrations SQL), bascule nginx puis laisse l'ancienne instance finir ses tours
et se vider : les sessions ne sont pas coupées. Si seul `frontend/` a changé, il publie le front sans rien
redémarrer. Les migrations doivent rester compatibles avec la version précédente, qui tourne encore pendant le
drainage.

`npm run build` et `npm run typecheck` valident le schéma GraphQL du backend et toutes les requêtes du
front contre ce schéma (`frontend/scripts/check-graphql.mjs`) : tsc ne voit pas l'intérieur des gabarits
`gql`, et une erreur de fusion y donnait une page blanche en production (30/09/2026).

## Fichiers joints aux instructions

Les fichiers joints par les utilisateurs sont écrits dans `/home/skipper/skipper-workspaces/<slug>.attachments/`
(à sauvegarder avec les workspaces si l'on tient aux pièces jointes ; supprimés avec la session). Le
transcript les charge par `GET /api/attachments/<session>/<id>` : le site nginx doit proxifier `/api/`
vers le backend (bloc présent dans `deploy/cellule/templates/nginx-site.conf`, à reporter dans
`/etc/nginx/sites-available/skipper` puis `sudo nginx -t && sudo systemctl reload nginx`). Les conteneurs
docker créés avant cette version n'ont pas le dossier monté : « Recréer » sur la page du projet.

## Application installable

Le service worker (`/sw.js`) et le manifeste sont servis avec `Cache-Control: no-cache` par nginx
(`map $uri $skipper_cache_control` du site nginx) pour que chaque déploiement soit pris en compte à la
prochaine ouverture. L'installation exige HTTPS : c'est le cas.

## Compression et HTTP/2

Le `gzip on` global de `/etc/nginx/nginx.conf` (Ubuntu) ne compresse que `text/html` tant que `gzip_types` y
reste commenté : le bundle (2,4 Mo brut, 0,7 Mo gzippé), le CSS et toutes les réponses GraphQL (JSON, dont les
pages d'événements d'une session) partaient bruts. Le site nginx (`deploy/cellule/templates/nginx-site.conf`) porte désormais ses propres directives `gzip_*` (sans
`text/event-stream` : les subscriptions SSE restent sans tampon). HTTP/2 se déclare sur les écoutes TLS que
certbot ajoute (`listen 443 ssl http2;`, nginx 1.24 n'a pas `http2 on`) : `bootstrap.sh` le fait après certbot ;
sur une cellule déjà installée, reporter les directives `gzip_*` et ajouter `http2` aux deux lignes
`listen … 443 ssl` de `/etc/nginx/sites-available/skipper`, puis `sudo nginx -t && sudo systemctl reload nginx`.
Vérification : `curl -sI --http2 -H 'Accept-Encoding: gzip' https://skipper.toolso.io/assets/<index>.js` doit
répondre `HTTP/2 200` avec `content-encoding: gzip`.

## En-têtes de sécurité

Le site nginx (`deploy/cellule/templates/nginx-site.conf`) masque sa version
(`server_tokens off`) et pose, au niveau `server`, HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy` et une `Content-Security-Policy` (`default-src 'self'`, aucun script en
ligne, `frame-ancestors 'none'` contre le clickjacking). La CSP et le `Cache-Control` dépendent du chemin par deux
`map` en tête de fichier : les réponses du backend (`/graphql`, `/api/`, `/auth/`, WebSockets) n'en reçoivent pas de
nginx (les pages partagées et aperçus de fichiers ont leur propre CSP `sandbox` et chargent des CDN).
**Piège** : un `add_header` dans une `location` annule tous ceux du bloc `server` ; n'en ajouter aucun dans une
location, passer par les `map`. Sur une cellule déjà installée, reporter les deux `map`, les lignes
`server_tokens`/`add_header` et le retrait des `add_header`/`expires` des locations dans
`/etc/nginx/sites-available/skipper` (sans toucher aux blocs certbot), puis `sudo nginx -t && sudo systemctl reload nginx`.
**Micro (dictée vocale)** : `Permissions-Policy` autorise `microphone` pour Skipper lui-même (`self`) et pour les
aperçus (`"https://*.apercu.<domaine>"`, cadre de l'onglet « Aperçu ») ; avec `microphone=()`, le bouton micro reste
sans effet. Sur une cellule déjà installée, remplacer la ligne dans `/etc/nginx/sites-available/skipper` puis
`sudo nginx -t && sudo systemctl reload nginx`.
Vérification : `curl -sI https://skipper.toolso.io/` montre `content-security-policy` et `strict-transport-security`,
et `curl -sI https://skipper.toolso.io/assets/<index>.js` `cache-control: public, max-age=31536000, immutable`.
Déployer le front (`theme-init.js`) avant ou en même temps que la CSP : l'ancien `index.html` a un script en ligne
(sans effet grave s'il est bloqué : thème sombre par défaut au premier affichage).

## Image du runner Docker

Après une modification de `deploy/runner/Dockerfile` (outils courants dont Python 3 avec pip et venv, zip et
unzip ; CLI Claude Code, CLI OpenCode pour les
sessions OpenCode, Playwright/Chromium pour l'option « navigateur headless », CLI AWS et CLI Scaleway pour les
comptes AWS et Scaleway du coffre) : `docker build -t skipper-runner deploy/runner` sur le serveur
(≈ 1 Go, l'ARM64 télécharge son propre Chromium), puis « Recréer » le conteneur sur la page de
chaque projet concerné. Une session avec navigateur prend 300 à 500 Mo de plus : prévoir au moins
1,5 Go pour le conteneur du projet. Chromium est installé par Playwright dans `/opt/ms-playwright` :
en arm64, `chromium_headless_shell-<rév>/chrome-headless-shell-linux-arm64/chrome-headless-shell` (en x86_64,
`…/chrome-headless-shell-linux64/…`), avec `chromium-<rév>/` et `ffmpeg-<rév>/` à côté ; `playwright-mcp` est dans le
PATH (`npm install -g @playwright/mcp`). Après reconstruction et « Recréer », vérifier avec « Tester » sur la carte
« Navigateur headless » des réglages du projet (version de Chromium, mémoire disponible, capture d'une page de test).
Les comptes AWS du coffre (outil `aws_run`) exigent une image
reconstruite avec le CLI AWS v2 (≈ 250 Mo de plus) : sans lui, l'outil répond « “aws” est absent de l'image » ;
chaque commande tourne dans un conteneur jetable `skipper-run-*` (512 Mo au plus, supprimé à la fin), hors du
conteneur du projet, qui n'a donc pas besoin d'être recréé. Même chose pour les comptes Scaleway (outil `scw_run`) :
l'image doit contenir le CLI `scw` (binaire de 60 Mo environ, version fixée par l'argument `SCW_CLI_VERSION` du
Dockerfile) ; l'outil `scw_api` et le test de l'élément passent par l'API HTTP et n'en ont pas besoin.

La vue en direct du navigateur passe par le WebSocket `/browsers/<session>` : reporter le bloc
`location` des WebSockets (`browsers/`) de `deploy/cellule/templates/nginx-site.conf` dans `/etc/nginx/sites-available/skipper`, puis
`sudo nginx -t && sudo systemctl reload nginx`. Les conteneurs sont désormais créés avec `--init`
(récolte des processus de Chromium arrêtés) : « Recréer » le conteneur des projets qui utilisent le
navigateur pour en bénéficier. Les sessions OpenCode exigent une image reconstruite (CLI `opencode`)
et des conteneurs recréés (`--add-host host.docker.internal`, `~/.claude` propre au projet dans
`.runners/<slug>/claude-home` à la place du dossier de l'hôte) : « Recréer » sur la page de chaque projet
après la mise à jour. Les conversations Claude Code d'avant cette version sont dans `~/.claude/projects`
de l'hôte : les copier dans le dossier du projet (`projects/-<chemin encodé>*`) pour pouvoir les reprendre.

## Vérifications

```bash
cat /etc/nginx/skipper-upstream.conf        # instance active (4101 : blue, 4102 : green)
systemctl is-active skipper@blue skipper@green
sudo journalctl -u skipper@blue -n 20 --no-pager   # « [http] GraphQL prêt sur … »
curl -s -X POST https://skipper.toolso.io/graphql \
  -H 'content-type: application/json' -d '{"query":"{ providers { type label } }"}'
curl -s https://skipper.toolso.io/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

## Journaux

Le backend écrit une ligne par message : niveau (`DEBUG`, `INFO`, `WARN`, `ERROR`) puis le message avec
son préfixe de module (`[sessions]`, `[graphql]`…). Tout passe par `backend/src/log.ts` (`log` ou
`createLogger('module')`) : pas de `console.*` dans le backend, sinon la ligne sort sans niveau.
Les instances tournent sous systemd : tout part dans journald (`journalctl -u skipper@blue`, ou `@green`),
`info` et `debug` sur la sortie standard, `warn` et `error` sur la sortie d'erreur, chaque ligne avec sa priorité
syslog : `journalctl -u skipper@blue -p warning` ne montre que les `WARN` et `ERROR`. La rotation est celle de
journald. Le niveau minimal se règle avec `LOG_LEVEL` dans le `.env` (défaut `info`, pris en compte au
déploiement suivant).

**Une seule date par ligne** : journald date déjà chaque ligne. Le logger n'ajoute donc son horodatage ISO
qu'ailleurs : `LOG_TIMESTAMP=auto` (défaut) l'omet quand la sortie d'erreur est raccordée à journald
(`JOURNAL_STREAM`, vérifiée contre le descripteur, car la variable est héritée par les terminaux et sessions lancés
depuis le service) ou quand `pm_id` est défini (pm2, ancienne installation). `LOG_TIMESTAMP=on` ou `off` force le
choix.

Une erreur métier renvoyée au client (`AppError` : refus, ressource introuvable, dépôt sans branche de
base…) tient sur une ligne `WARN [graphql] <opération> · <champ> · <utilisateur> : <message>`. Seules les
erreurs inattendues sortent en `ERROR` avec leur trace : le journal d'erreurs ne devrait contenir que de
vraies anomalies. Les avertissements de Node attendus par conception (le SDK Claude signalant que
`canUseTool` n'est pas consulté pour les serveurs MCP internes, code `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`)
sont journalisés une seule fois, en `INFO`.

## Aperçus des branches

Désactivés tant que `PREVIEW_URL` est vide (l'onglet « Aperçu » l'indique). Mise en service sur une cellule
(exemple pour `skipper.toolso.io`) :

1. **DNS** : un enregistrement générique `*.apercu.skipper.toolso.io` (A) vers l'adresse de la cellule.
2. **Certificat générique** : Let's Encrypt ne délivre un certificat `*.apercu.skipper.toolso.io` que par défi DNS-01.
   Avec le greffon certbot du fournisseur DNS du domaine (renouvellement automatique), sinon à la main :
   `sudo certbot certonly --manual --preferred-challenges dns -d '*.apercu.skipper.toolso.io' --cert-name apercu.skipper.toolso.io`
   (enregistrement TXT `_acme-challenge.apercu` à créer ; à refaire tous les 90 jours dans ce cas).
3. **nginx** : `sed "s/__DOMAIN__/skipper.toolso.io/g" deploy/cellule/templates/nginx-previews.conf | sudo tee /etc/nginx/sites-available/skipper-previews`,
   lien dans `sites-enabled`, et dans le site principal ajouter les aperçus aux cadres autorisés de la CSP
   (`frame-src 'self' https://*.apercu.$host;`, déjà dans `templates/nginx-site.conf`) ; `sudo nginx -t && sudo systemctl reload nginx`.
4. **`.env`** : `PREVIEW_URL=https://*.apercu.skipper.toolso.io`, puis déploiement (ou redémarrage) du backend.
5. **Vérifier** : onglet « Aperçu » d'une session dont le dépôt a un `.skipper/preview.json` (ou un script `dev` Vite),
   « Lancer l'aperçu », l'application s'affiche ; `curl -sI https://x.apercu.skipper.toolso.io` répond 404 « Aperçu
   introuvable » (servi par le backend).

Les conteneurs des projets sont recréés (quand ils sont inactifs) à la mise à jour qui introduit les aperçus : nouveaux
montages `~/.npm` et `~/.cache` (caches persistants des gestionnaires de paquets, dans `.runners/<projet>/cache/`). Les
instantanés de dépendances (`<projet>.worktrees/.skipper-deps/`, quatre par projet) et l'état des aperçus
(`.skipper-previews/`) sont à côté des work sessions et partent avec le projet.

## Bon à savoir

- **Mémoire** : 32 Go pour le backend, PostgreSQL et les conteneurs des projets. Les limites des conteneurs
  peuvent dépasser à elles toutes la mémoire du serveur (elles ne sont pas réservées) : surveiller `free -h` et
  `docker stats`.
- **Ne jamais lire ni copier le `.env` du serveur** (ni `/etc/skipper/*.env`) dans une conversation ou un dépôt.
- **Connexions des projets (SSH, PostgreSQL)** : le mode « outils » n'a besoin de rien de plus (client
  SSH et pg intégrés au backend). Le mode « shell de la session » utilise `ssh`, `ssh-agent`, `ssh-add`
  (paquet `openssh-client`, déjà présent) et, pour les bases, `psql` (`sudo apt install postgresql-client`).
  Les fichiers éphémères de session vont dans `/tmp/skipper-session-<id>` et sont supprimés à la fin de
  la session ou balayés au redémarrage du backend. Les identifiants sont chiffrés avec la même clé que les
  jetons des Paramètres (`SKIPPER_SECRET_KEY` ou `WORKSPACES_ROOT/.secret-key`) : sauvegarder cette clé
  avec la base, sinon les secrets deviennent illisibles.

## Ancienne installation (EC2 + RDS, retirée)

Jusqu'au 30/10/2026, Skipper tournait sous pm2 sur l'EC2 de Curso (`13.36.242.35`, compte AWS Toolso) avec sa base
sur l'instance RDS `toolso-campaign-manager` (eu-west-1). Données reprises par `deploy/cellule/migrate-from-ec2.sh`,
puis installation retirée le 03/11/2026 : processus pm2 et service `pm2-skipper`, conteneur et image du runner, site
nginx, certificat, fichiers de `/home/skipper` et base `skipper` de RDS supprimés ; domaine de transition
`skipper2.toolso.io` supprimé. Archive (dernier dump RDS et `/home/skipper` sans `node_modules`) sur skipper-1 dans
`/home/skipper/archives/ec2-20261103/` et dans le dépôt restic de la cellule (bucket `skipper-sauvegardes`,
instantané étiqueté `ec2-archive` : `sudo bash -c '. /etc/skipper/restic.env; restic snapshots --tag ec2-archive'`).
