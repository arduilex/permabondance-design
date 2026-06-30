# Auto-deploy (déploiement continu par polling git)

Un petit conteneur (`design-deployer`) qui surveille la branche **`main`** du dépôt
et relance automatiquement `docker compose up -d --build` sur l'application dès
qu'une nouvelle version est poussée sur GitHub.

## Comment ça marche

Toutes les `INTERVAL` secondes (60 s par défaut), le conteneur :
1. fait un `git fetch` de `main` ;
2. compare le commit local au commit distant ;
3. s'ils diffèrent → `git reset --hard origin/main` puis `docker compose up -d --build`.

Il pilote le Docker de l'hôte via le socket Docker, et agit sur le **même projet**
que l'application (`COMPOSE_PROJECT_NAME=design-app`), donc il **réutilise les volumes
existants** (base de données et images conservées).

## Démarrage (une seule fois, sur le VPS)

Ces fichiers font partie du dépôt. Pour amorcer le système :

```bash
# 1. récupérer la dernière version (qui contient ce dossier auto-deploy)
cd ~/design-app
git pull origin main

# 2. démarrer le deployer
cd auto-deploy
docker compose up -d --build

# 3. suivre les logs
docker logs -f design-deployer
```

À partir de là, **chaque `git push` sur `main`** déclenche un redéploiement
automatique de l'app dans la minute.

## Réglages

Dans `docker-compose.yml` :
- `INTERVAL` : fréquence de vérification (secondes).
- `BRANCH` : branche surveillée (`main`).

Après modification, relancer : `docker compose up -d --build` (dans `auto-deploy/`).

## Points importants

- **Sécurité** : le conteneur monte le socket Docker (`/var/run/docker.sock`), ce qui
  équivaut à un accès root sur l'hôte. C'est inhérent à ce type d'outil. Le dépôt étant
  public, aucun secret GitHub n'est nécessaire pour le `git pull`.
- **N'édite pas les fichiers suivis directement sur le VPS** : le deployer fait
  `git reset --hard`, donc toute modif locale non commitée serait écrasée. Édite sur
  ton Mac → push → le deployer applique.
- Ton **`.env`** et tes **certificats Let's Encrypt** ne sont pas suivis par git :
  ils ne sont **jamais touchés** par le déploiement.
- Le deployer redéploie **l'application** (`docker-compose.yml`). Il ne touche pas à
  **Traefik**. Si tu modifies la config Traefik, relance-la à la main :
  `cd ~/design-app/traefik && docker compose up -d`.

## Arrêter / désactiver

```bash
cd ~/design-app/auto-deploy
docker compose down
```
