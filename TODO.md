# Feuille de route — évolutions de l'éditeur

Ordre choisi pour que chaque étape s'appuie sur la précédente : d'abord la
refonte (qui pose l'architecture « un outil actif à la fois » et le panneau
par catégories), puis les mécanismes transversaux (opacité, calques), puis
les nouvelles catégories d'éléments qui en héritent, et enfin le partage en
lecture seule, qui doit connaître tous les outils pour savoir quoi masquer.

- [x] **1. Refonte ergonomique** — nouvelle mise en page (barre d'outils
      verticale, panneau « Éléments » par catégorie + « Fiche » toujours
      visible, étiquette d'aide contextuelle), outils exclusifs (un seul
      actif, `Échap` = sélection), raccourcis clavier, filtre de liste,
      séparation `editor.html` / `editor.css` / `editor.js`.
      Aucun changement de données ni de fonctionnalité à cette étape.
- [x] **2. Fiche plante** — migration : `variete` copié en 1ʳᵉ ligne de la
      description, `libre` ajouté à la fin de la description (pour ne rien
      perdre), puis suppression des deux champs ; « Nom commun » → « Nom »,
      « Description de la variété » → « Description ». Script de migration
      SQL rejouable + formulaire mis à jour.
- [x] **3. Règle de mesure** — outil `R` exclusif : deux points, distance en
      m (ou px si non calibré), plusieurs segments à la suite. Plantes et
      zones **non cliquables** tant que l'outil est actif.
- [x] **4. Étiquettes intelligentes** — au dézoom, une étiquette qui
      chevaucherait une autre est masquée ; elle réapparaît quand il y a la
      place ; le survol d'une plante force l'affichage de son étiquette.
- [x] **5. Opacité par élément + masquage par catégorie** — curseur
      d'opacité sur chaque élément (plantes, zones, puis tout ce qui suit),
      œil « afficher / masquer » sur chaque catégorie du panneau ; mécanisme
      générique dont hériteront les nouvelles catégories.
- [x] **6. Onglet Eau** — *mares* (polygone bleu, même éditeur que les
      zones) et *fossés* (ligne point par point, épaisseur et couleur).
      Généralisation de l'éditeur polygone → polyligne ouverte/fermée.
- [x] **7. Chemins au crayon** — tracé à main levée (simplifié à la volée),
      type route / passage tracteur / passage à pied (préréglages),
      épaisseur et couleur libres, déplacement / suppression.
- [x] **8. Items personnalisés** — bibliothèque d'items du projet (nom +
      image PNG importée, stockée côté serveur), pose sur le plan, taille,
      opacité, étiquette.
- [x] **9. Partage** — lien **lecture seule** (`/v/<jeton>`) et lien
      **édition** (`/p/<id>`, inchangé pour ne pas casser les liens déjà
      envoyés) ; mode lecture seule dans l'éditeur (outils et fiches
      masqués, navigation/zoom conservés) ; deux boutons « Copier » dans la
      liste admin et dans l'éditeur.
- [x] **10. Passe finale** — harmonisation des nouveaux outils dans la mise
      en page, raccourcis, aide contextuelle, vérification sur petit écran,
      mise à jour de `CLAUDE.md` / `README.md`.

- [x] **11. Plus de numéros** — retirer les « #12 » partout : étiquettes du
      plan, listes du panneau, titres de fiche (plante, zone, mare, fossé,
      chemin, item). Le numéro reste dans les données pour l'ordre de création.
- [x] **12. Suppression sans popup** — le bouton Supprimer demande la
      confirmation **sur lui-même** (il devient « Confirmer ? ») ; `Échap`
      ou un clic ailleurs annule. Même chose pour la touche `Suppr`, la
      bibliothèque d'items et la liste des projets (admin).

- [x] **13. Palette de couleurs éditable** — chaque pastille se modifie via le
      sélecteur de couleur de l'OS (crayon), bouton rond « + » pour ajouter une
      couleur ; palette enregistrée dans le projet.
- [x] **14. Chemins sans étiquette sur la carte** (nom visible dans la liste et la fiche).

- [x] **15. Export / import** — menu « Projet » en haut : export en fichier
      `.permab.json` autonome (image du terrain et images d'items incluses,
      nom daté `Nom_AAAA-MM-JJ_HHhMM`), import qui remplace le projet (confirmation
      dans l'étiquette d'aide) ; « Importer un fichier… » dans la liste admin
      crée un nouveau projet.
- [x] **16. Champ date supprimé** de l'en-tête (la colonne `plan_date` reste en
      base, non affichée, exportée pour l'ancien format).

Décisions prises (validées le 13/09/2026) :
- 13 : palette **par projet** (comme la bibliothèque d'items) ; modifier une pastille
  ne recolore pas les éléments qui l'utilisaient déjà (seul l'élément sélectionné change).
- 2 : `libre` fusionné à la fin de la description plutôt que supprimé à sec.
- 8 : bibliothèque d'items **par projet** (simple, cohérent avec le lien
  d'édition public) plutôt qu'un catalogue global réservé à l'admin.

Idées non retenues pour l'instant (à reprendre si besoin) :
- Catalogue d'items global (partagé entre projets), réservé à l'admin.
- Remettre l'échelle à zéro (l'API `PATCH` ne sait pas effacer `scale`).
- Visibilité des catégories enregistrée dans le projet (aujourd'hui : préférence locale du navigateur).
