#!/bin/sh
# ------------------------------------------------------------------
# Deployer Permabondance : surveille la branche git et redéploie
# l'application quand une nouvelle version est poussée.
# ------------------------------------------------------------------
set -u

REPO_DIR="${REPO_DIR:-/repo}"
BRANCH="${BRANCH:-main}"
INTERVAL="${INTERVAL:-60}"

# git refuse d'opérer sur un dépôt appartenant à un autre utilisateur sans ceci
git config --global --add safe.directory "$REPO_DIR"

log() { echo "[deployer] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

log "Surveillance de '$BRANCH' dans $REPO_DIR toutes les ${INTERVAL}s"

# Se placer sur la bonne branche (sans casser si déjà dessus)
git -C "$REPO_DIR" checkout "$BRANCH" 2>/dev/null || true

while true; do
  if git -C "$REPO_DIR" fetch --quiet origin "$BRANCH" 2>/dev/null; then
    LOCAL="$(git -C "$REPO_DIR" rev-parse HEAD)"
    REMOTE="$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH")"

    if [ "$LOCAL" != "$REMOTE" ]; then
      log "Nouvelle version détectée : ${REMOTE} (précédente : ${LOCAL})"
      git -C "$REPO_DIR" reset --hard "origin/$BRANCH"

      log "Lancement de : docker compose up -d --build"
      if ( cd "$REPO_DIR" && docker compose up -d --build ); then
        log "Déploiement terminé avec succès."
      else
        log "ÉCHEC du déploiement (voir les erreurs ci-dessus). Un prochain commit relancera un essai."
      fi
    fi
  else
    log "git fetch a échoué (réseau ?). Nouvel essai dans ${INTERVAL}s."
  fi

  sleep "$INTERVAL"
done
