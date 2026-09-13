# Auto-deploy (déploiement continu par polling git)

Un petit conteneur (`design-deployer`) qui surveille la branche **`main`** du dépôt
<https://github.com/arduilex/permabondance-design> et relance automatiquement `docker compose up -d --build` sur l'application dès
qu'une nouvelle version est poussée sur GitHub.

## Comment ça marche

Toutes les `INTERVAL` secondes (60 s par défaut), le conteneur :
1. fait un `git fetch` de `main` ;
2. compare le commit distant au **dernier commit déployé avec succès**
   (mémorisé dans `.git/deployer-last-ok`, hors des fichiers suivis) ;
3. s'ils diffèrent → `git reset --hard` sur ce commit, `docker compose up -d --build`,
   puis suppression des anciennes images de l'app devenues inutiles.

Si le déploiement échoue (build cassé, Docker Hub ou npm injoignable…), le commit
n'est **pas** marqué comme déployé : le deployer retente toutes les `RETRY_INTERVAL`
secondes (300 s par défaut), jusqu'à ce que ça passe ou qu'un nouveau commit arrive.

Au premier démarrage (pas encore de `.git/deployer-last-ok`), il relance un
`docker compose up -d --build` sur la version en place ; si rien n'a changé, les
conteneurs ne sont normalement pas recréés.

Il pilote le Docker de l'hôte via le socket Docker, et agit sur le **même projet**
que l'application (`COMPOSE_PROJECT_NAME=design-app`), donc il **réutilise les volumes
existants** (base de données et images conservées).

## Démarrage (une seule fois, sur le VPS)

Ces fichiers font partie du dépôt. Pour amorcer le système :

```bash
# 1. récupérer le dépôt (clone la première fois, sinon mise à jour)
git clone https://github.com/arduilex/permabondance-design ~/design-app   # si pas encore cloné
cd ~/design-app
git pull origin main

# 2. démarrer le deployer
cd auto-deploy
docker compose up -d --build

# 3. suivre les logs
docker logs -f design-deployer
```

Le dossier doit être un **clone git** : un dossier copié à la main (sans `.git`) ne
fonctionne pas. Le `.env` n'est pas dans git : après un nouveau clone, recopie celui de
l'ancien dossier **avant** de démarrer le deployer.

À partir de là, **chaque `git push` sur `main`** déclenche un redéploiement
automatique de l'app dans la minute.

## Réglages

Dans `docker-compose.yml` :
- `REPO_URL` : dépôt GitHub surveillé (`https://github.com/arduilex/permabondance-design`).
  Au démarrage, le deployer corrige l'URL `origin` du clone si elle est différente.
- `INTERVAL` : fréquence de vérification (secondes).
- `RETRY_INTERVAL` : délai avant de retenter un déploiement échoué (secondes).
- `BRANCH` : branche surveillée (`main`).

Après modification, relancer : `docker compose up -d --build` (dans `auto-deploy/`).

## Mettre à jour le deployer lui-même

Le script `deploy.sh` est **copié dans l'image** du deployer : un push qui modifie ce
dossier met bien les fichiers à jour sur le VPS, mais le deployer en marche continue
d'utiliser l'ancien script. Après un tel push, le reconstruire à la main :

```bash
cd ~/design-app/auto-deploy
docker compose up -d --build
```

## Points importants

- **Sécurité** : le conteneur monte le socket Docker (`/var/run/docker.sock`), ce qui
  équivaut à un accès root sur l'hôte. C'est inhérent à ce type d'outil. Le dépôt étant
  public, aucun secret GitHub n'est nécessaire pour le `git pull`.
- **N'édite pas les fichiers suivis directement sur le VPS** : le deployer fait
  `git reset --hard`, donc toute modif locale non commitée serait écrasée. Édite sur
  ton Mac → push → le deployer applique.
- Ton **`.env`** n'est pas suivi par git : il n'est **jamais touché** par le déploiement.
- Le deployer redéploie **uniquement l'application** (`docker-compose.yml`).
  **Traefik** (reverse proxy HTTPS + certificats Let's Encrypt) ne fait pas partie de ce
  dépôt : il se gère à part sur le VPS et n'est jamais touché par le deployer.

## Arrêter / désactiver

```bash
cd ~/design-app/auto-deploy
docker compose down
```
