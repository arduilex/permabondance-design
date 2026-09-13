"use strict";
// Importe un fichier « .permab.json » (export de l'ancienne version autonome
// de l'éditeur, image incluse en base64) comme nouveau projet en base.
//
// Usage : node scripts/import-permab.js <fichier.permab.json> [--name "Nom du projet"]
//
// Dans Docker (le fichier doit être monté dans le conteneur) :
//   docker compose run --rm \
//     -v "$PWD/backend/scripts:/app/scripts:ro" \
//     -v "$PWD/MonProjet.permab.json:/import/MonProjet.permab.json:ro" \
//     design-app node scripts/import-permab.js /import/MonProjet.permab.json
//
// Ancien format : { client, planDate, imgData (data URL), plants[], zones[] }.
// plants/zones ont la même structure que dans la version serveur ; l'image
// est extraite vers UPLOAD_DIR/<id>/ et le projet reçoit un nouvel id.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pool, init } = require("../src/db");

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
const EXT = { jpeg: ".jpg", jpg: ".jpg", png: ".png", webp: ".webp", gif: ".gif" };

// Fiche v2 : « variete » → 1re ligne de « description », « libre » → fin (même règle que src/db.js)
function migratePlant(p) {
  if (!p || typeof p !== "object" || (!("variete" in p) && !("libre" in p))) return p;
  const v = String(p.variete || "").trim(), d = String(p.description || "").trim(), l = String(p.libre || "").trim();
  const head = [v, d].filter(Boolean).join("\n");
  const out = Object.assign({}, p, { description: [head, l].filter(Boolean).join("\n\n") });
  delete out.variete; delete out.libre;
  return out;
}

function usage(msg) {
  if (msg) console.error("Erreur :", msg);
  console.error('Usage: node scripts/import-permab.js <fichier.permab.json> [--name "Nom"]');
  process.exit(1);
}

const args = process.argv.slice(2);
let file = null, nameOverride = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--name") nameOverride = args[++i];
  else if (!file) file = args[i];
  else usage("argument inattendu : " + args[i]);
}
if (!file) usage();

async function main() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    usage("fichier illisible ou JSON invalide (" + err.message + ")");
  }
  const plants = (Array.isArray(d.plants) ? d.plants : []).map(migratePlant);
  const zones = Array.isArray(d.zones) ? d.zones : [];
  const name = String(nameOverride ?? d.client ?? "").slice(0, 200);
  const planDate = String(d.planDate || "").slice(0, 40);
  // Échelle : absente de l'ancien format, conservée si un export plus récent la fournit
  const scale = d.scale && typeof d.scale === "object" && d.scale.mPerPx > 0 ? d.scale : null;

  const id = crypto.randomBytes(16).toString("base64url");

  // Image : data URL base64 -> fichier dans le volume des uploads
  let imagePath = null;
  if (typeof d.imgData === "string" && d.imgData.startsWith("data:")) {
    const m = /^data:image\/([a-z0-9+.-]+);base64,(.*)$/is.exec(d.imgData);
    if (!m) usage("imgData n'est pas une image base64 reconnue");
    const ext = EXT[m[1].toLowerCase()] || ".jpg";
    const buf = Buffer.from(m[2], "base64");
    const dir = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const filename = "plan_" + Date.now() + ext;
    fs.writeFileSync(path.join(dir, filename), buf);
    imagePath = path.posix.join(id, filename);
    console.log(`[import] image écrite : ${imagePath} (${(buf.length / 1024 / 1024).toFixed(1)} Mo)`);
  } else {
    console.log("[import] pas d'image dans le fichier");
  }

  await init();
  await pool.query(
    `INSERT INTO projects (id, name, plan_date, image_path, plants, zones, scale)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
    [id, name, planDate, imagePath, JSON.stringify(plants), JSON.stringify(zones), scale ? JSON.stringify(scale) : null]
  );
  console.log(`[import] projet « ${name || "Sans titre"} » créé : ${plants.length} plante(s), ${zones.length} zone(s)`);
  console.log(`[import] URL : /p/${id}`);
  await pool.end();
}

main().catch((err) => {
  console.error("[import] échec :", err);
  process.exit(1);
});
