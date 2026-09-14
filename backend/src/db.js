"use strict";
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  // Attente que Postgres soit prêt (le conteneur db peut démarrer après l'app)
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query("SELECT 1");
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.log(`[db] Postgres pas encore prêt (tentative ${i + 1}/30)…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      plan_date   TEXT NOT NULL DEFAULT '',
      image_path  TEXT,
      plants      JSONB NOT NULL DEFAULT '[]'::jsonb,
      zones       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Échelle de calibration (m/px + points de référence), ajoutée après coup
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS scale JSONB`);
  // Nouvelles catégories d'éléments (mares, fossés, chemins, items + bibliothèque d'items du projet)
  for (const col of ["ponds", "ditches", "paths", "items", "item_types"]) {
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ${col} JSONB NOT NULL DEFAULT '[]'::jsonb`);
  }
  // Palette de couleurs du projet (null = palette par défaut de l'éditeur)
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS palette JSONB`);
  // Jeton de lecture seule (lien client) ; l'id reste le jeton d'édition. Rempli pour les projets existants.
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS view_token TEXT UNIQUE`);
  const { rows: noToken } = await pool.query(`SELECT id FROM projects WHERE view_token IS NULL`);
  for (const r of noToken) {
    await pool.query(`UPDATE projects SET view_token = $2 WHERE id = $1`, [r.id, crypto.randomBytes(16).toString("base64url")]);
  }
  if (noToken.length) console.log(`[db] jetons de lecture seule générés : ${noToken.length} projet(s)`);

  // Fiche plante v2 : « variete » devient la 1re ligne de « description », « libre » est
  // ajouté à la fin ; les deux clés disparaissent. Rejouable : ne touche que les plantes
  // qui portent encore l'une de ces clés.
  const mig = await pool.query(`
    UPDATE projects SET plants = sub.new_plants
      FROM (
        SELECT id, jsonb_agg(
          CASE WHEN p ? 'variete' OR p ? 'libre' THEN
            (p - 'variete' - 'libre') || jsonb_build_object('description',
              COALESCE(concat_ws(E'\\n\\n',
                NULLIF(concat_ws(E'\\n', NULLIF(btrim(p->>'variete'), ''), NULLIF(btrim(p->>'description'), '')), ''),
                NULLIF(btrim(p->>'libre'), '')), ''))
          ELSE p END ORDER BY ord) AS new_plants
          FROM projects, jsonb_array_elements(plants) WITH ORDINALITY AS t(p, ord)
         WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(projects.plants) q WHERE q ? 'variete' OR q ? 'libre')
         GROUP BY id
      ) sub
     WHERE projects.id = sub.id
  `);
  if (mig.rowCount) console.log(`[db] fiches plantes migrées (variete/libre → description) : ${mig.rowCount} projet(s)`);

  // Date de plantation réduite à l'année : « datePres » (AAAA-MM-JJ) devient « annee » (AAAA).
  // Rejouable : ne touche que les plantes qui portent encore « datePres » ; si la date ne
  // contient pas d'année, une « annee » déjà présente est conservée.
  const migYear = await pool.query(`
    UPDATE projects SET plants = sub.new_plants
      FROM (
        SELECT id, jsonb_agg(
          CASE WHEN p ? 'datePres' THEN
            (p - 'datePres') || jsonb_build_object('annee',
              COALESCE(substring(p->>'datePres' from '[0-9]{4}'), NULLIF(btrim(p->>'annee'), ''), ''))
          ELSE p END ORDER BY ord) AS new_plants
          FROM projects, jsonb_array_elements(plants) WITH ORDINALITY AS t(p, ord)
         WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(projects.plants) q WHERE q ? 'datePres')
         GROUP BY id
      ) sub
     WHERE projects.id = sub.id
  `);
  if (migYear.rowCount) console.log(`[db] dates de plantation réduites à l'année (datePres → annee) : ${migYear.rowCount} projet(s)`);
  console.log("[db] prêt");
}

module.exports = { pool, init };
