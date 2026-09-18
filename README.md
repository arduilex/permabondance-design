# Permabondance — Éditeur de plans (serveur)

Application web full-Docker pour créer des plans de terrain par projet client.
Accueil = liste des projets (protégée par login admin). Chaque projet a une URL
partageable (`/p/<id>`) en édition complète. Tout est stocké côté serveur
(Postgres + volume d'images).

- Domaine visé : `design.pepinieres-permabondance.fr`
- Reverse proxy + HTTPS : **Traefik** (Let's Encrypt)

---

## Architecture

```
Internet ──443──> Traefik ──(réseau "web")──> design-app (Node/Express :3000)
                                                   │
                                          (réseau "internal")
                                                   ▼
                                            design-db (Postgres)
```

- `design-app` : API + sert l'interface (page admin + éditeur). Images sur le volume `design-uploads`.
- `design-db` : Postgres, **non exposé** à l'extérieur (réseau interne uniquement).
- Les IDs de projet sont des tokens aléatoires (non devinables) : un lien partagé ne peut pas être deviné.

---

## Déploiement sur le VPS

### 0. Prérequis
- Docker + Docker Compose installés (déjà fait ✅)
- DNS : un enregistrement **A** `design.pepinieres-permabondance.fr` → `179.237.80.212`
  (ajoute aussi `@` et `www` si tu veux le site principal plus tard).
  Vérifie : `dig +short design.pepinieres-permabondance.fr` doit renvoyer ton IP.

Clone le dépôt sur le serveur :
```bash
git clone https://github.com/arduilex/permabondance-design ~/design-app
cd ~/design-app
```

### 1. Réseau Docker partagé (une seule fois)
```bash
docker network create web
```

### 2. Lancer Traefik
```bash
cd traefik
cp .env.example .env
nano .env            # mets ton email Let's Encrypt
docker compose up -d
docker compose logs -f   # vérifie qu'il démarre sans erreur
```

### 3. Configurer l'application
```bash
cd ..                # retour dans design-app/
cp .env.example .env
```

Génère les secrets et le hash du mot de passe admin :
```bash
openssl rand -hex 24         # -> POSTGRES_PASSWORD (hex : pas de caractère qui casse l'URL de connexion)
openssl rand -hex 32         # -> SESSION_SECRET

# build de l'image puis génération du hash bcrypt :
docker compose build
docker compose run --rm --no-deps design-app node scripts/hash-password.js 'TonMotDePasseAdmin'
# -> colle la ligne $2a$... dans ADMIN_PASSWORD_HASH, ENTRE GUILLEMETS SIMPLES :
#    ADMIN_PASSWORD_HASH='$2a$12$....'
#    (sans les guillemets, Docker Compose prend les « $ » du hash pour des variables et le tronque :
#     WARN "The "xxx" variable is not set" au démarrage, et connexion impossible)
```

Édite `.env` : `POSTGRES_PASSWORD`, `ADMIN_USER`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`.

### 4. Lancer l'application
```bash
docker compose up -d
docker compose logs -f design-app
```

Au premier démarrage, Traefik obtient le certificat (quelques secondes). Ouvre :
**https://design.pepinieres-permabondance.fr**

---

## Utilisation

1. Connecte-toi (identifiant + mot de passe admin).
2. **+ Nouveau projet** → donne un nom (client / terrain).
3. Dans l'éditeur : **Importer une image satellite**, puis définir l'**échelle** (outil `E`,
   deux points + distance réelle) pour travailler en mètres.
4. Les outils (barre de gauche, un seul actif à la fois, `Échap` = sélection) :
   Plante `P`, Zone `Z`, Mare `M`, Fossé `F`, Chemin au crayon `C` (route / tracteur / à pied, trait continu),
   Item `I` (image PNG importée dans la bibliothèque du projet), Règle `R`, Échelle `E`.
   Le panneau de droite liste les éléments par catégorie (œil = masquer sur le plan,
   `+` = outil correspondant) au-dessus de la fiche de l'élément sélectionné.
   Tout est **enregistré automatiquement** (indicateur « Enregistré » en haut).
5. **Partager** → deux liens :
   - **lecture seule** (`/v/<jeton>`) pour les clients : consultation, fiches et règle, sans modification ;
   - **édition** (`/p/<id>`) : quiconque l'a peut modifier le plan.
6. **Fichier** → **Exporter le plan** : fichier `Nom_AAAA-MM-JJ_HHhMM.permab.json` autonome
   (image du terrain et images d'items incluses) pour une sauvegarde ou une copie hors ligne ;
   **Importer un fichier…** remplace tout le contenu du plan par celui du fichier (après
   confirmation dans l'étiquette d'aide). Seuls les fichiers exportés par l'application
   actuelle sont lus. En lecture seule, l'export reste possible, l'import non.

## Mode hors ligne

L'application fonctionne **sans connexion**, sans rien installer d'autre qu'un navigateur
(Chrome ou Edge). Un *service worker* (`backend/public/sw.js`) se met en place tout seul à
la première visite et s'intercale entre l'éditeur et le réseau.

**Usage.** Ouvrir le plan une fois **en ligne** : la pastille « Disponible hors ligne »
confirme qu'il est enregistré sur le poste. Ensuite, même sans réseau, la même adresse
ouvre l'éditeur au lieu de l'erreur du navigateur. Les modifications sont conservées
localement et l'en-tête affiche « N modifications en attente » ; elles partent seules dès
que le serveur répond. L'icône d'installation de la barre d'adresse (facultative) donne une
fenêtre et une icône dédiées, pratique pour quelqu'un qui n'a pas à taper une URL.

- **Conflit** : si le plan a été modifié en ligne pendant l'édition hors ligne, un bandeau
  demande laquelle des deux versions garder, en les résumant. Rien n'est écrasé avant la
  réponse, et « Sauvegarder ma version » télécharge la version locale avant de l'abandonner.
- **`/hors-ligne`** liste les plans disponibles sans réseau et permet d'en créer un nouveau.
  C'est ce que le service worker affiche à la place de la liste des projets quand le serveur
  est injoignable. Un plan créé hors ligne porte un identifiant provisoire (`local_…`) et
  n'est créé en base qu'au retour du réseau — ce qui **demande d'être connecté en admin**.
- **Limites** : la première visite doit être en ligne ; tout est lié à ce navigateur sur ce
  poste ; effacer les données du site efface aussi les modifications pas encore envoyées.

### Désactiver le mode hors ligne (secours)

Le service worker s'installe chez tous les visiteurs. En cas de problème, remplacer le
contenu de `backend/public/sw.js` par ces quelques lignes et pousser sur `main` : il se
désinstalle de lui-même à la visite suivante, chez tout le monde.

```js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    await self.registration.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
  })());
});
```

Les modifications encore en attente (IndexedDB) ne sont **pas** effacées par cette manœuvre.
`/sw.js` est servi avec `Cache-Control: no-cache`, donc le remplacement est pris en compte
dès la visite suivante.

## Développement local

```bash
docker compose -f docker-compose.local.yml up -d --build    # http://localhost:3000, admin / admin
```
Pas de Traefik ni de `.env` ; `backend/public` et `backend/src` sont montés depuis le poste
(HTML/CSS/JS visibles au rechargement, `restart design-app` après une modif de `src/`).

---

## Exploitation

```bash
# Logs
docker compose logs -f design-app

# Mise à jour du code (après modification)
docker compose up -d --build design-app

# Sauvegarde de la base
docker compose exec design-db pg_dump -U design design > backup_$(date +%F).sql

# Restauration
cat backup.sql | docker compose exec -T design-db psql -U design design
```

Les images sont dans le volume Docker `design-app_design-uploads`.
Pour une sauvegarde complète, sauvegarde **le dump SQL + ce volume**.

`POSTGRES_PASSWORD` n'est appliqué qu'à la création du volume Postgres. Si `.env` change ensuite
(« password authentication failed for user "design" » au démarrage), aligne la base sur `.env`
sans perdre de données :
```bash
docker compose exec design-db psql -U design -d design \
  -c "ALTER USER design WITH PASSWORD '$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)';"
docker compose up -d
```
Pour repartir de zéro (efface base et images) : `docker compose down -v --rmi all && docker compose up -d --build`.

---

## Sécurité (mise en place)
- Mot de passe admin **haché bcrypt** (jamais en clair), cookie de session
  `httpOnly` + `Secure` + `SameSite=Strict`, rate-limiting sur le login, en-têtes `helmet`.
- Postgres non exposé publiquement.
- HTTPS forcé (redirection 80→443 par Traefik).
- IDs de projet imprévisibles ; le lien de lecture seule ne permet jamais de retrouver le lien d'édition.
- Images d'items : PNG / JPEG / WebP uniquement (pas de SVG), 5 Mo max.

## Structure
```
design-app/
├── docker-compose.yml           # app + postgres (+ labels Traefik) — production
├── docker-compose.local.yml     # app + postgres sans Traefik — test sur le poste
├── auto-deploy/                 # deployer (polling git de main sur le VPS)
├── .env.example
├── TODO.md                      # feuille de route des évolutions
├── traefik/
│   ├── docker-compose.yml       # Traefik (HTTPS / Let's Encrypt)
│   └── .env.example
└── backend/
    ├── Dockerfile
    ├── package.json
    ├── scripts/hash-password.js
    ├── src/{server.js, db.js}   # API + migrations de schéma au démarrage
    └── public/
        ├── index.html (admin), editor.html + editor.css + editor.js (éditeur)
        └── sw.js + offline.js + offline-home.html + manifest.webmanifest   # mode hors ligne
```
