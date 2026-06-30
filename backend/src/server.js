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
} = process.env;

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

// Liste de tous les projets — ADMIN uniquement
app.get("/api/projects", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, plan_date, image_path, created_at, updated_at,
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
  await pool.query("INSERT INTO projects (id, name) VALUES ($1, $2)", [id, name]);
  res.json({ id });
});

// Lecture d'un projet — public (nécessite l'id non devinable)
app.get("/api/projects/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "projet introuvable" });
  res.json(rows[0]);
});

// Mise à jour d'un projet — public (édition complète via lien partagé)
app.patch("/api/projects/:id", async (req, res) => {
  const b = req.body || {};
  const name = b.name === undefined ? null : String(b.name).slice(0, 200);
  const planDate = b.plan_date === undefined ? null : String(b.plan_date).slice(0, 40);
  const plants = b.plants === undefined ? null : JSON.stringify(b.plants);
  const zones = b.zones === undefined ? null : JSON.stringify(b.zones);
  const { rowCount } = await pool.query(
    `UPDATE projects SET
        name      = COALESCE($2, name),
        plan_date = COALESCE($3, plan_date),
        plants    = COALESCE($4::jsonb, plants),
        zones     = COALESCE($5::jsonb, zones),
        updated_at = now()
      WHERE id = $1`,
    [req.params.id, name, planDate, plants, zones]
  );
  if (!rowCount) return res.status(404).json({ error: "projet introuvable" });
  res.json({ ok: true });
});

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

/* ---------------- Fichiers statiques ---------------- */
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, { index: false, dotfiles: "deny", maxAge: "1h" })
);
app.use("/static", express.static(PUBLIC_DIR, { index: false }));

/* ---------------- Pages ---------------- */
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/p/:id", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "editor.html")));

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
