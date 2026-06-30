"use strict";
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
  console.log("[db] prêt");
}

module.exports = { pool, init };
