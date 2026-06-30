"use strict";
// Génère un hash bcrypt pour le mot de passe admin.
// Usage : node scripts/hash-password.js 'monMotDePasse'
const bcrypt = require("bcryptjs");

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: node scripts/hash-password.js '<mot_de_passe>'");
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 12));
