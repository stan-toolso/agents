#!/usr/bin/env bash
# Mise à jour de Skipper dans une cellule, sans interruption (bleu/vert). À lancer en tant que skipper :
#   ~/skipper/deploy/cellule/deploy.sh [--ref origin/main] [--max-wait 900] [--force]
# Deux instances du backend, skipper@blue (port 4101) et skipper@green (4102), chacune dans son dossier
# /home/skipper/skipper-<couleur> (worktree du clone ~/skipper). nginx envoie le trafic à l'instance active
# (/etc/nginx/skipper-upstream.conf). Une mise à jour :
# 1. récupère la référence, la construit dans le dossier de l'autre couleur (l'instance active n'est pas touchée) ;
# 2. si seul le front a changé : le publie, rien d'autre ;
# 3. sinon : démarre la nouvelle instance, vérifie sa santé (échec : elle est arrêtée, rien n'a changé pour les
#    utilisateurs), bascule nginx dessus, publie le front, puis envoie SIGUSR2 à l'ancienne : elle finit les tours en
#    cours, gare les sessions (reprises par la nouvelle à leur prochaine instruction), cède les planificateurs et sort
#    d'elle-même. Les instructions, interruptions et réponses aux demandes de ses sessions lui sont transmises par la
#    nouvelle ; l'interface voit ce qu'elle fait (bus PostgreSQL). Voir la tâche e1803f30 et backend/src/instances/.
# Cellule pas encore préparée (pas de /etc/nginx/skipper-upstream.conf : lancer bluegreen-setup.sh en root) : ancien
# mode, attente de la fin des tours puis redémarrage du service `skipper` (quelques secondes d'interruption).
# Transition depuis l'ancien service (upstream sur 4100) : même attente, arrêt de `skipper`, puis démarrage de blue.
# Journal : ~/deploy-logs/<date>-<heure>.log (lien latest.log), écrit par le script lui-même, en plus de la sortie : un
# second lancement ne l'écrase pas. Un seul déploiement à la fois (verrou ~/.skipper-deploy.lock). Après la
# récupération, le script se relance depuis une copie de la version à déployer : la mise à jour du clone ne réécrit
# pas le fichier en cours de lecture, et c'est la nouvelle logique de déploiement qui s'applique.
set -euo pipefail
[ "$(id -un)" = skipper ] || { echo "à lancer en tant que skipper" >&2; exit 2; }
ARGS=("$@")
if [ -z "${SKIPPER_DEPLOY_NEW:-}" ]; then
  mkdir -p /home/skipper/deploy-logs
  LOG="/home/skipper/deploy-logs/$(date +%Y%m%d-%H%M%S).log"
  ln -sfn "$LOG" /home/skipper/deploy-logs/latest.log
  exec > >(tee -a "$LOG") 2>&1
  ls -1t /home/skipper/deploy-logs/2*.log 2>/dev/null | tail -n +31 | xargs -r rm -f
  exec 9>/home/skipper/.skipper-deploy.lock
  if ! flock -n 9; then
    echo "un déploiement est déjà en cours (journal : ~/deploy-logs/, processus : pgrep -af deploy.sh) ; rien n'est fait" >&2
    exit 1
  fi
  export SKIPPER_DEPLOY_T0="$(date +%s)"
fi
REF="origin/main"; MAX_WAIT=900; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --max-wait) MAX_WAIT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
step() { printf '\n\033[1;34m== [%ss] %s\033[0m\n' "$(( $(date +%s) - SKIPPER_DEPLOY_T0 ))" "$*"; }
APP=/home/skipper/skipper
UPSTREAM=/etc/nginx/skipper-upstream.conf
cd "$APP"
. /etc/skipper/db.env

busy() { psql "$DATABASE_URL" -tAc "SELECT count(*) FROM sessions WHERE status::text IN ('running','queued') AND activity::text = 'busy'"; }
wait_idle() {
  local waited=0
  while [ "$(busy)" != "0" ] && [ "$waited" -lt "$MAX_WAIT" ]; do
    [ $((waited % 60)) = 0 ] && echo "$(busy) agent(s) au travail, attente… (${waited}s)"
    sleep 10; waited=$((waited + 10))
  done
  [ "$(busy)" = "0" ] || echo "délai dépassé : $(busy) agent(s) seront interrompus puis relancés automatiquement"
}
healthy() { curl -fsS -o /dev/null "http://127.0.0.1:$1/graphql?query=%7B__typename%7D"; }
wait_healthy() {
  local port="$1" unit="$2"
  for i in $(seq 1 90); do
    if healthy "$port"; then echo "backend prêt sur $port en ${i}s"; return 0; fi
    sleep 1
  done
  echo "le backend ne répond pas sur $port : sudo journalctl -u $unit -n 50" >&2
  sudo journalctl -u "$unit" -n 30 --no-pager || true
  return 1
}
# Fichiers changés entre deux révisions → ce qu'il faut refaire.
classify() {
  backend_changed=0; runner_changed=0; deps_changed=0
  if [ "$FORCE" = 1 ] || [ -z "$1" ]; then backend_changed=1; deps_changed=1; runner_changed=$([ "$FORCE" = 1 ] && echo 1 || echo 0); return; fi
  local changed; changed="$(git -C "$APP" diff --name-only "$1" "$2")"
  grep -qE '^(backend/|package\.json|package-lock\.json|deploy/cellule/templates/env)' <<<"$changed" && backend_changed=1
  grep -qE '^(package\.json|package-lock\.json|backend/package\.json|frontend/package\.json)' <<<"$changed" && deps_changed=1
  grep -q '^deploy/runner/' <<<"$changed" && runner_changed=1
  return 0
}

# Builds backend et front en parallèle ; le front sans son typecheck (fait par la CI) : ~15 s au lieu de ~50.
build_all() {
  ( set -o pipefail; npm run build -w backend 2>&1 | sed -u 's/^/[backend] /' ) & local b=$!
  ( set -o pipefail; cd frontend && { node scripts/check-graphql.mjs && npx vite build; } 2>&1 | sed -u -e '/^dist\//d' -e '/^$/d' -e 's/^/[front] /' ) & local f=$!
  local rc=0
  wait "$b" || rc=1
  wait "$f" || rc=1
  [ "$rc" = 0 ] || { echo "échec du build" >&2; return 1; }
}

if [ -z "${SKIPPER_DEPLOY_NEW:-}" ]; then
  step "Récupération ($REF)"
  git fetch -q origin
  NEW="$(git rev-parse "$REF")"
  COPY="$(mktemp /tmp/skipper-deploy-XXXXXX.sh)"
  if git show "$NEW:deploy/cellule/deploy.sh" > "$COPY" 2>/dev/null; then
    SKIPPER_DEPLOY_NEW="$NEW" SKIPPER_DEPLOY_COPY="$COPY" exec bash "$COPY" "${ARGS[@]}"
  fi
  rm -f "$COPY"   # révision sans deploy.sh : on continue avec celui-ci
else
  NEW="$SKIPPER_DEPLOY_NEW"
  trap 'rm -f "$SKIPPER_DEPLOY_COPY"' EXIT   # remplacé plus bas, en bleu/vert, par on_exit qui fait de même
fi

# ---------------------------------------------------------------------------------------------------------------------
# Ancien mode : une seule instance (service `skipper`, port 4100), redémarrée après la fin des tours.
# ---------------------------------------------------------------------------------------------------------------------
if [ ! -f "$UPSTREAM" ]; then
  OLD="$(git rev-parse HEAD)"
  if [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then echo "déjà à jour ($OLD)"; exit 0; fi
  git merge --ff-only -q "$NEW"
  echo "$OLD → $NEW"
  git --no-pager log --oneline -n 20 "$OLD..$NEW"
  classify "$OLD" "$NEW"
  step "Build"
  [ "$deps_changed" = 1 ] && npm ci --no-audit --no-fund
  NODE_OPTIONS=--max-old-space-size=2048 build_all
  [ "$runner_changed" = 1 ] && { echo "image du runner"; docker build -q -t skipper-runner:latest deploy/runner; }
  if [ "$backend_changed" = 0 ]; then
    step "Front seulement : publication sans redémarrage"
    rsync -a --delete frontend/dist/ /var/www/skipper/
    echo "déployé $NEW (front)"; exit 0
  fi
  step "Attente de la fin des tours d'agents (au plus ${MAX_WAIT}s)"
  wait_idle
  step "Redémarrage du backend"
  sudo systemctl restart skipper
  wait_healthy 4100 skipper || exit 1
  step "Publication du front"
  rsync -a --delete frontend/dist/ /var/www/skipper/
  echo "déployé $NEW (ancien mode : lancer bluegreen-setup.sh en root pour les mises à jour sans interruption)"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------
# Bleu/vert
# ---------------------------------------------------------------------------------------------------------------------
port_of() { case "$1" in blue) echo 4101 ;; green) echo 4102 ;; legacy) echo 4100 ;; esac; }
ACTIVE_PORT="$(grep -oE '127\.0\.0\.1:[0-9]+' "$UPSTREAM" | head -1 | cut -d: -f2)"
case "$ACTIVE_PORT" in
  4101) ACTIVE=blue; TARGET=green ;;
  4102) ACTIVE=green; TARGET=blue ;;
  *) ACTIVE=legacy; TARGET=blue ;;
esac
TPORT="$(port_of "$TARGET")"
TDIR="/home/skipper/skipper-$TARGET"
ADIR="/home/skipper/skipper-$ACTIVE"
if [ "$ACTIVE" = legacy ]; then ACTIVE_REV="$(git rev-parse HEAD)"; else ACTIVE_REV="$(git -C "$ADIR" rev-parse HEAD 2>/dev/null || true)"; fi
echo "instance active : $ACTIVE (port $ACTIVE_PORT, $(git rev-parse --short "${ACTIVE_REV:-HEAD}"))  →  nouvelle : $TARGET (port $TPORT, $(git rev-parse --short "$NEW"))"
if [ "$ACTIVE_REV" = "$NEW" ] && [ "$FORCE" = 0 ]; then echo "déjà à jour ($NEW)"; exit 0; fi
[ -n "$ACTIVE_REV" ] && git --no-pager log --oneline -n 20 "$ACTIVE_REV..$NEW"   # pas de « | head » : SIGPIPE + pipefail arrêtait le script au-delà de 20 commits
# Le clone suit la référence déployée (scripts, lecture du code) ; il ne fait plus tourner de backend (l'ancien service,
# jusqu'à la transition, tourne sur son dist/, que seul un build dans le clone toucherait).
git merge --ff-only -q "$NEW" 2>/dev/null || git checkout -q --detach "$NEW"

# Instance de la couleur cible déjà démarrée. Deux cas :
# - elle se vide après la mise à jour précédente (draining_since posé dans backend_instances) : son dossier ne se
#   remplace qu'une fois sortie ;
# - elle ne se vide pas : reste d'un déploiement arrêté entre son démarrage et la bascule (nginx ne la sert pas). Si
#   elle tourne déjà la révision voulue et répond, on reprend à la bascule ; sinon on la vide (SIGUSR2).
target_draining() {
  [ "$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM backend_instances WHERE port = $TPORT AND draining_since IS NOT NULL AND heartbeat_at > now() - interval '1 minute'")" != 0 ]
}
RESUME=0
if systemctl is-active -q "skipper@$TARGET"; then
  if ! target_draining; then
    if [ "$FORCE" = 0 ] && [ "$(git -C "$TDIR" rev-parse HEAD 2>/dev/null)" = "$NEW" ] && healthy "$TPORT"; then
      step "skipper@$TARGET tourne déjà $NEW sans servir (déploiement précédent arrêté avant la bascule) : reprise à la bascule"
      RESUME=1
    else
      step "skipper@$TARGET tourne sans servir (déploiement précédent arrêté avant la bascule) : drainage"
      kill -USR2 "$(systemctl show -p MainPID --value "skipper@$TARGET")"
    fi
  fi
  if [ "$RESUME" = 0 ]; then
    step "skipper@$TARGET se vide (au plus ${MAX_WAIT}s)"
    waited=0
    while systemctl is-active -q "skipper@$TARGET" && [ "$waited" -lt "$MAX_WAIT" ]; do
      [ $((waited % 60)) = 0 ] && echo "attente de la sortie de skipper@$TARGET… (${waited}s)"
      sleep 5; waited=$((waited + 5))
    done
    if systemctl is-active -q "skipper@$TARGET"; then
      [ "$FORCE" = 1 ] || { echo "skipper@$TARGET tourne toujours : relancer plus tard, ou avec --force (ses sessions au travail seront interrompues puis relancées)" >&2; exit 1; }
      sudo systemctl stop "skipper@$TARGET"
    fi
  fi
fi

# Toute sortie entre le démarrage de la nouvelle instance et la bascule de nginx l'arrête : l'instance active sert
# toujours, et le déploiement suivant ne trouve pas une instance orpheline.
STARTED=0; SWITCHED=0
on_exit() {
  local rc=$?
  if [ "$STARTED" = 1 ] && [ "$SWITCHED" = 0 ]; then
    echo "échec avant la bascule : arrêt de skipper@$TARGET, l'instance $ACTIVE sert toujours" >&2
    sudo systemctl stop "skipper@$TARGET" || true
    if [ "$ACTIVE" = legacy ]; then sudo systemctl start skipper || true; echo "ancien service relancé" >&2; fi
  fi
  [ -n "${SKIPPER_DEPLOY_COPY:-}" ] && rm -f "$SKIPPER_DEPLOY_COPY"
  return "$rc"
}
trap on_exit EXIT

if [ "$RESUME" = 0 ]; then
  step "Dossier $TDIR ($NEW)"
  PREV_TREV=""
  if [ -d "$TDIR/.git" ] || [ -f "$TDIR/.git" ]; then
    PREV_TREV="$(git -C "$TDIR" rev-parse HEAD)"
    git -C "$TDIR" checkout -q -f --detach "$NEW"
  else
    git worktree add -q --detach "$TDIR" "$NEW"
  fi
  ln -sfn "$APP/.env" "$TDIR/.env"   # lu par Vite (VITE_GRAPHQL_URL) ; le backend lit le .env du clone (unité systemd)
  classify "$ACTIVE_REV" "$NEW"
  # Dépendances du dossier : installées s'il n'en a pas, ou si le lockfile a changé depuis sa dernière installation.
  deps_changed=$FORCE
  if [ ! -d "$TDIR/node_modules" ] || [ -z "$PREV_TREV" ] || ! git -C "$APP" diff --quiet "$PREV_TREV" "$NEW" -- package-lock.json; then deps_changed=1; fi

  step "Build ($TARGET)"
  cd "$TDIR"
  [ "$deps_changed" = 1 ] && npm ci --no-audit --no-fund
  NODE_OPTIONS=--max-old-space-size=2048 build_all
  [ "$runner_changed" = 1 ] && { echo "image du runner"; docker build -q -t skipper-runner:latest deploy/runner; }

  if [ "$backend_changed" = 0 ] && [ "$ACTIVE" != legacy ]; then
    step "Front seulement : publication, l'instance $ACTIVE reste en place"
    rsync -a --delete frontend/dist/ /var/www/skipper/
    # Le dossier actif passe à la nouvelle révision (rien n'est rechargé) : la prochaine comparaison part d'ici.
    git -C "$ADIR" checkout -q -f --detach "$NEW"
    echo "déployé $NEW (front)"; exit 0
  fi

  if [ "$ACTIVE" = legacy ]; then
    # Transition depuis l'ancien service, qui ne sait pas se vider : la nouvelle instance prendrait ses sessions pour
    # orphelines. Dernier redémarrage avec interruption : attente des agents, arrêt de `skipper`, démarrage de blue.
    step "Transition depuis l'ancien service skipper : attente de la fin des tours (au plus ${MAX_WAIT}s)"
    wait_idle
    sudo systemctl stop skipper
    sudo systemctl disable skipper
  fi

  step "Démarrage de skipper@$TARGET (port $TPORT)"
  STARTED=1
  sudo systemctl start "skipper@$TARGET"
  wait_healthy "$TPORT" "skipper@$TARGET"
else
  STARTED=1
  cd "$TDIR"
fi

# Le fichier d'upstream appartient à skipper mais /etc/nginx non : il se réécrit sur place (pas de fichier à côté).
step "Bascule de nginx vers $TARGET"
PREV_UPSTREAM="$(cat "$UPSTREAM")"
printf '# Instance active du backend, réécrit par deploy/cellule/deploy.sh (4101 : blue, 4102 : green).\nserver 127.0.0.1:%s;\n' "$TPORT" > "$UPSTREAM"
if ! sudo nginx -t 2>/dev/null; then
  printf '%s\n' "$PREV_UPSTREAM" > "$UPSTREAM"
  echo "configuration nginx invalide : bascule annulée" >&2; exit 1
fi
sudo systemctl reload nginx
SWITCHED=1
sudo systemctl enable "skipper@$TARGET" 2>/dev/null || true

step "Publication du front"
rsync -a --delete frontend/dist/ /var/www/skipper/

if [ "$ACTIVE" != legacy ] && systemctl is-active -q "skipper@$ACTIVE"; then
  step "Drainage de skipper@$ACTIVE"
  sudo systemctl disable "skipper@$ACTIVE" 2>/dev/null || true
  kill -USR2 "$(systemctl show -p MainPID --value "skipper@$ACTIVE")"
  echo "SIGUSR2 envoyé : skipper@$ACTIVE finit ses tours et sort d'elle-même (suivi : sudo journalctl -u skipper@$ACTIVE -f)"
fi
sudo journalctl -u "skipper@$TARGET" -n 30 --no-pager | grep -E 'migrations|GraphQL prêt|instances|relancée' || true
step "déployé $NEW sur $TARGET"
