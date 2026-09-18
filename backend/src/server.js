"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { pool, init } = require("./db");

const {
  ADMIN_USER = "admin",
  ADMIN_PASSWORD_HASH = "",
  SESSION_SECRET = "",
  UPLOAD_DIR = "/data/uploads",
  PORT = 3000,
  NODE_ENV = "production",
  PREPROD = "0",
} = process.env;

// Pré-production : site de test servi sur un autre domaine, avec la même image que la prod.
// Deux garde-fous : jamais référencé par les moteurs de recherche, et un bandeau visible
// pour qu'on ne confonde jamais les deux sites.
const IS_PREPROD = PREPROD === "1";

if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
  console.error(
    "[config] ADMIN_PASSWORD_HASH et SESSION_SECRET sont obligatoires (voir .env.example)."
  );
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // derrière Traefik

// En-têtes de sécurité. CSP désactivée car l'éditeur utilise des styles/scripts inline.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
if (IS_PREPROD) {
  app.use((req, res, next) => {
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
}
app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());

/* ---------------- Auth admin ---------------- */
const COOKIE = "pb_session";

function signSession(user) {
  return jwt.sign({ u: user, role: "admin" }, SESSION_SECRET, { expiresIn: "7d" });
}

function requireAdmin(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: "non autorisé" });
  try {
    req.admin = jwt.verify(token, SESSION_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "non autorisé" });
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "trop de tentatives, réessayez plus tard" },
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const user = String((req.body && req.body.user) || "");
  const password = String((req.body && req.body.password) || "");
  let ok = false;
  try {
    ok = user === ADMIN_USER && (await bcrypt.compare(password, ADMIN_PASSWORD_HASH));
  } catch {
    ok = false;
  }
  if (!ok) return res.status(401).json({ error: "identifiants invalides" });
  res.cookie(COOKIE, signSession(user), {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", requireAdmin, (req, res) => res.json({ user: req.admin.u }));

/* ---------------- Projets ---------------- */
function newId() {
  return crypto.randomBytes(16).toString("base64url"); // 22 caractères non devinables
}
// L'id sert de nom de dossier sous UPLOAD_DIR : on refuse tout ce qui n'a pas la forme d'un jeton
app.param("id", (req, res, next, id) => {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return res.status(404).json({ error: "projet introuvable" });
  next();
});

// Liste de tous les projets — ADMIN uniquement
app.get("/api/projects", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, view_token, name, image_path, created_at, updated_at,
            jsonb_array_length(plants) AS n_plants,
            jsonb_array_length(zones)  AS n_zones
       FROM projects
   ORDER BY updated_at DESC`
  );
  res.json(rows);
});

// Création d'un projet — ADMIN uniquement
app.post("/api/projects", requireAdmin, async (req, res) => {
  const id = newId();
  const name = String((req.body && req.body.name) || "").slice(0, 200);
  await pool.query("INSERT INTO projects (id, view_token, name) VALUES ($1, $2, $3)", [id, newId(), name]);
  res.json({ id });
});

// Lecture d'un projet — public (nécessite l'id non devinable = jeton d'édition)
app.get("/api/projects/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "projet introuvable" });
  res.json(rows[0]);
});

// Lecture seule via le jeton client : même contenu, SANS l'id (qui donnerait le droit d'éditer)
app.get("/api/view/:token", async (req, res) => {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(req.params.token)) return res.status(404).json({ error: "projet introuvable" });
  const { rows } = await pool.query("SELECT * FROM projects WHERE view_token = $1", [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: "projet introuvable" });
  const { id, ...rest } = rows[0];
  res.json({ ...rest, readonly: true });
});

// Mise à jour d'un projet — public (édition complète via lien partagé).
// Chaque champ absent du corps est laissé tel quel (COALESCE).
const JSON_COLS = ["plants", "zones", "scale", "ponds", "ditches", "paths", "items", "item_types", "palette"];
async function updateProject(req, res) {
  const b = req.body || {};
  const name = b.name === undefined ? null : String(b.name).slice(0, 200);
  const jsonVals = JSON_COLS.map((c) => (b[c] === undefined ? null : JSON.stringify(b[c])));
  const sets = JSON_COLS.map((c, i) => `${c} = COALESCE($${i + 3}::jsonb, ${c})`).join(",\n        ");
  // updated_at est renvoyé : le mode hors ligne s'en sert comme repère pour détecter
  // qu'un plan a été modifié ailleurs pendant qu'il était édité sans réseau.
  const { rows } = await pool.query(
    `UPDATE projects SET
        name      = COALESCE($2, name),
        ${sets},
        updated_at = now()
      WHERE id = $1
      RETURNING updated_at`,
    [req.params.id, name, ...jsonVals]
  );
  if (!rows.length) return res.status(404).json({ error: "projet introuvable" });
  res.json({ ok: true, updated_at: rows[0].updated_at });
}
app.patch("/api/projects/:id", updateProject);
// Même mise à jour en POST : utilisée par navigator.sendBeacon à la fermeture de la page (PATCH impossible)
app.post("/api/projects/:id/beacon", updateProject);

// Suppression d'un projet — ADMIN uniquement
app.delete("/api/projects/:id", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT image_path FROM projects WHERE id = $1", [
    req.params.id,
  ]);
  await pool.query("DELETE FROM projects WHERE id = $1", [req.params.id]);
  // nettoyage du dossier d'images du projet
  try {
    fs.rmSync(path.join(UPLOAD_DIR, req.params.id), { recursive: true, force: true });
  } catch {}
  res.json({ ok: true, had_image: Boolean(rows[0] && rows[0].image_path) });
});

/* ---------------- Upload image ---------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      let ext = path.extname(file.originalname || "").toLowerCase();
      if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = ".jpg";
      cb(null, "plan_" + Date.now() + ext);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 }, // 40 Mo
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Remplacement de l'image — public (nécessite l'id)
app.post("/api/projects/:id/image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "aucune image valide" });
  const rel = path.posix.join(req.params.id, req.file.filename);
  const { rows } = await pool.query("SELECT image_path FROM projects WHERE id = $1", [
    req.params.id,
  ]);
  if (!rows.length) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ error: "projet introuvable" });
  }
  await pool.query("UPDATE projects SET image_path = $2, updated_at = now() WHERE id = $1", [
    req.params.id,
    rel,
  ]);
  // suppression de l'ancienne image si différente
  const old = rows[0].image_path;
  if (old && old !== rel) {
    try {
      fs.rmSync(path.join(UPLOAD_DIR, old), { force: true });
    } catch {}
  }
  res.json({ image_url: "/uploads/" + rel });
});

/* ---------------- Images d'items (bibliothèque du projet) ---------------- */
const ASSET_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }; // raster uniquement (pas de SVG : scripts)
const assetUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.id, "items");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) =>
      cb(null, "item_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex") + (ASSET_EXT[file.mimetype] || ".png")),
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
  fileFilter: (req, file, cb) => cb(null, Boolean(ASSET_EXT[file.mimetype])),
});

// Ajout d'une image d'item — public (nécessite l'id)
app.post("/api/projects/:id/assets", assetUpload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "image PNG, JPEG ou WebP attendue (5 Mo max)" });
  const { rows } = await pool.query("SELECT 1 FROM projects WHERE id = $1", [req.params.id]);
  if (!rows.length) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ error: "projet introuvable" });
  }
  const rel = path.posix.join(req.params.id, "items", req.file.filename);
  res.json({ image_path: rel, image_url: "/uploads/" + rel });
});

// Suppression d'une image d'item — public (nécessite l'id)
app.delete("/api/projects/:id/assets/:file", (req, res) => {
  if (!/^item_\d+_[a-f0-9]+\.(png|jpg|webp)$/.test(req.params.file)) return res.status(400).json({ error: "fichier invalide" });
  try {
    fs.rmSync(path.join(UPLOAD_DIR, req.params.id, "items", req.params.file), { force: true });
  } catch {}
  res.json({ ok: true });
});

/* ---------------- Fichiers statiques ---------------- */
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, { index: false, dotfiles: "deny", maxAge: "1h" })
);
app.use("/static", express.static(PUBLIC_DIR, { index: false }));

/* ---------------- Mode hors ligne (PWA) ----------------
   Le service worker doit être servi depuis la racine pour contrôler /p/<id>,
   et sans cache : c'est par ce fichier que passe la désactivation d'urgence
   (voir « Désactiver le mode hors ligne » dans le README). */
app.get("/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache, max-age=0");
  res.type("application/javascript").sendFile(path.join(PUBLIC_DIR, "sw.js"));
});
app.get("/manifest.webmanifest", (req, res) =>
  res.type("application/manifest+json").sendFile(path.join(PUBLIC_DIR, "manifest.webmanifest"))
);
// Accueil hors ligne : liste des plans disponibles sans réseau. Le service worker
// le sert aussi à la place de « / » quand le serveur est injoignable.
app.get("/hors-ligne", (req, res) => sendPage(res, "offline-home.html"));

/* ---------------- Pages ---------------- */
// En pré-production, les pages portent un bandeau fixe : impossible de croire qu'on est en prod.
const PREPROD_BANNER =
  '<div style="position:fixed;left:0;bottom:0;z-index:99999;pointer-events:none;background:#b13a3a;' +
  'color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
  'padding:6px 10px;border-top-right-radius:8px;letter-spacing:.4px">PRÉ-PRODUCTION</div>';
function sendPage(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!IS_PREPROD) return res.sendFile(full);
  fs.readFile(full, "utf8", (err, html) => {
    if (err) return res.sendStatus(404);
    res.type("html").send(html.replace("</body>", PREPROD_BANNER + "</body>"));
  });
}

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "favicon.ico")));
app.get("/", (req, res) => sendPage(res, "index.html"));
app.get("/p/:id", (req, res) => sendPage(res, "editor.html"));
app.get("/v/:token", (req, res) => sendPage(res, "editor.html")); // lecture seule

/* ---------------- Erreurs ---------------- */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || "erreur serveur" });
});

init()
  .then(() => app.listen(PORT, () => console.log(`[app] en écoute sur :${PORT}`)))
  .catch((err) => {
    console.error("[app] échec de l'initialisation:", err);
    process.exit(1);
  });
