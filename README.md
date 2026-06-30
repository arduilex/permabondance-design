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

Copie le dossier `design-app/` sur le serveur (par ex. dans `/opt/`).

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
openssl rand -base64 24      # -> POSTGRES_PASSWORD
openssl rand -hex 32         # -> SESSION_SECRET

# build de l'image puis génération du hash bcrypt :
docker compose build
docker compose run --rm design-app node scripts/hash-password.js 'TonMotDePasseAdmin'
# -> colle la ligne $2a$... dans ADMIN_PASSWORD_HASH
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
3. Dans l'éditeur : **Importer une image satellite**, pose tes plantes, dessine tes zones.
   Tout est **enregistré automatiquement** (indicateur « ✓ Enregistré » en haut).
4. **Copier le lien** → partage l'URL avec le client (édition complète via ce lien).

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

---

## Sécurité (mise en place)
- Mot de passe admin **haché bcrypt** (jamais en clair), cookie de session
  `httpOnly` + `Secure` + `SameSite=Strict`, rate-limiting sur le login, en-têtes `helmet`.
- Postgres non exposé publiquement.
- HTTPS forcé (redirection 80→443 par Traefik).
- IDs de projet imprévisibles.

À considérer plus tard si besoin : limiter aussi l'accès aux liens de projet
(actuellement « quiconque a le lien peut éditer », conformément au choix retenu).

## Structure
```
design-app/
├── docker-compose.yml          # app + postgres (+ labels Traefik)
├── .env.example
├── traefik/
│   ├── docker-compose.yml       # Traefik (HTTPS / Let's Encrypt)
│   └── .env.example
└── backend/
    ├── Dockerfile
    ├── package.json
    ├── scripts/hash-password.js
    ├── src/{server.js, db.js}
    └── public/{index.html (admin), editor.html (éditeur)}
```
