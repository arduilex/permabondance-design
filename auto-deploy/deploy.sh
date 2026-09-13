#!/bin/sh
# ------------------------------------------------------------------
# Deployer Permabondance : surveille la branche git et redéploie
# l'application quand une nouvelle version est poussée.
# ------------------------------------------------------------------
set -u

REPO_DIR="${REPO_DIR:-/repo}"
REPO_URL="${REPO_URL:-https://github.com/arduilex/permabondance-design}"
BRANCH="${BRANCH:-main}"
INTERVAL="${INTERVAL:-60}"
RETRY_INTERVAL="${RETRY_INTERVAL:-300}"
PROJECT="${COMPOSE_PROJECT_NAME:-design-app}"

# Dernier commit déployé avec succès. Rangé dans .git : survit aux redémarrages
# du conteneur et n'est jamais touché par "git reset --hard".
STATE_FILE="$REPO_DIR/.git/deployer-last-ok"

# git refuse d'opérer sur un dépôt appartenant à un autre utilisateur sans ceci
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO_DIR" \
  || git config --global --add safe.directory "$REPO_DIR"

log() { echo "[deployer] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Place le dépôt sur le commit $1, reconstruit et relance l'app, puis mémorise le commit.
deploy() {
  git -C "$REPO_DIR" reset --quiet --hard "$1" || return 1
  log "Lancement de : docker compose up -d --build"
  ( cd "$REPO_DIR" && docker compose up -d --build ) || return 1
  echo "$1" > "$STATE_FILE"
  # Chaque build laisse l'ancienne image de l'app sans tag : on la supprime pour ne pas remplir le disque
  docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" > /dev/null 2>&1 || true
}

# Le dossier de l'app doit être un clone git (un dossier copié à la main n'a pas de .git)
if [ ! -e "$REPO_DIR/.git" ]; then
  log "ERREUR : le dossier de l'app n'est pas un clone git. Sur le serveur : git clone $REPO_URL"
  sleep "$RETRY_INTERVAL"
  exit 1
fi

# Le clone doit suivre le bon dépôt GitHub : règle l'URL "origin" si elle diffère (".git" final ignoré)
CURRENT_URL="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
if [ "${CURRENT_URL%.git}" != "${REPO_URL%.git}" ]; then
  if [ -n "$CURRENT_URL" ]; then ACTION=set-url; else ACTION=add; fi
  if git -C "$REPO_DIR" remote "$ACTION" origin "$REPO_URL"; then
    log "Dépôt origin : ${CURRENT_URL:-aucun} -> $REPO_URL"
  else
    log "ERREUR : impossible de régler origin sur $REPO_URL (voir ci-dessus)"
  fi
fi

log "Surveillance de '$BRANCH' de $REPO_URL dans $REPO_DIR toutes les ${INTERVAL}s"

# Se placer sur la bonne branche (sans casser si déjà dessus)
git -C "$REPO_DIR" checkout "$BRANCH" 2>/dev/null || true

while true; do
  if ERR="$(git -C "$REPO_DIR" fetch --quiet origin "$BRANCH" 2>&1)"; then
    REMOTE="$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH")"
    DEPLOYED="$(cat "$STATE_FILE" 2>/dev/null || true)"

    # Comparé au dernier déploiement RÉUSSI (et non à HEAD) : un échec est retenté
    if [ "$REMOTE" != "$DEPLOYED" ]; then
      log "Version à déployer : ${REMOTE} (dernière déployée : ${DEPLOYED:-inconnue})"
      if deploy "$REMOTE"; then
        log "Déploiement terminé avec succès."
      else
        log "ÉCHEC du déploiement (voir les erreurs ci-dessus). Nouvel essai dans ${RETRY_INTERVAL}s."
        sleep "$RETRY_INTERVAL"
        continue
      fi
    fi
  else
    log "git fetch a échoué : ${ERR:-erreur inconnue}. Nouvel essai dans ${INTERVAL}s."
  fi

  sleep "$INTERVAL"
done
