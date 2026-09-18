/* ==========================================================================
   Permabondance — mode hors ligne, côté page
   ==========================================================================
   Enregistre le service worker (sw.js), affiche l'état dans l'en-tête et
   pilote la synchronisation au retour du réseau. Le service worker sait
   rejouer la file d'attente, mais lui seul ne peut rien demander à personne :
   c'est ici qu'on pose la question quand le plan a changé des deux côtés.

   Ce fichier ne touche à rien dans editor.js : il ajoute ses propres éléments
   et communique avec le service worker par messages.
   ========================================================================== */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;

  const READONLY = location.pathname.startsWith("/v/");
  const PID = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  const API = (READONLY ? "/api/view/" : "/api/projects/") + encodeURIComponent(PID);
  // À la toute première visite, le service worker s'installe pendant que la page charge :
  // ses requêtes ne sont pas encore interceptées, donc rien n'est mis en cache. On le
  // détecte ici pour relire le plan et ses images une fois le worker aux commandes.
  const CONTROLLED_AT_BOOT = !!navigator.serviceWorker.controller;
  let queued = 0, syncing = false, conflict = null, armed = false;

  /* ---------- Éléments d'interface (injectés : editor.html reste inchangé) ---------- */
  const chip = document.createElement("span");
  chip.className = "pb-off";
  chip.hidden = true;
  const bar = document.createElement("div");
  bar.className = "pb-syncbar";
  bar.hidden = true;

  function mount() {
    const header = document.querySelector("header");
    const save = document.querySelector("#saveStatus");
    if (!header) return;
    if (save && save.parentNode === header) header.insertBefore(chip, save.nextSibling);
    else header.appendChild(chip);
    header.insertAdjacentElement("afterend", bar);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  function when(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso), now = new Date();
      const jour = d.toDateString() === now.toDateString() ? "aujourd'hui" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
      return jour + " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    } catch (_) { return ""; }
  }

  /* ---------- État affiché ---------- */
  // « navigator.onLine » ne dit que s'il existe une interface réseau, pas si le serveur
  // répond : il ne sert qu'à l'affichage. Ce qui fait foi, c'est la file d'attente —
  // elle ne se remplit que lorsqu'une écriture a réellement échoué.
  function render() {
    // « Enregistré » (editor.js) parle de la copie locale : le montrer à côté de
    // « en attente » se contredit à l'œil. Une seule information à la fois.
    const save = document.querySelector("#saveStatus");
    if (save) save.style.display = queued ? "none" : "";
    if (syncing) setChip("sync", "Synchronisation…");
    else if (queued) setChip("wait", queued + " modification" + (queued > 1 ? "s" : "") + " en attente");
    else if (!navigator.onLine) setChip("wait", "Hors ligne");
    else chip.hidden = true;
    renderBar();
  }
  function setChip(state, text) {
    chip.hidden = false;
    chip.className = "pb-off " + state;
    chip.innerHTML = '<i></i><span class="t">' + esc(text) + "</span>";
  }
  function flash(state, text, ms) {
    setChip(state, text);
    setTimeout(() => { if (chip.querySelector(".t") && chip.querySelector(".t").textContent === text) render(); }, ms || 3000);
  }

  function renderBar() {
    if (!conflict) { bar.hidden = true; bar.innerHTML = ""; armed = false; return; }
    const c = conflict;
    bar.hidden = false;
    bar.innerHTML =
      '<div class="pb-sb-txt"><b>Ce plan a été modifié en ligne ' + esc(when(c.serverAt)) + ".</b> " +
      "Votre version hors ligne (" + esc(c.localSummary) + ") et la version en ligne (" + esc(c.serverSummary) + ") ont divergé. " +
      "Laquelle garder ?</div>" +
      '<div class="pb-sb-act">' +
      '<a href="#" class="pb-sb-dl">Sauvegarder ma version</a>' +
      '<button type="button" class="pb-sb-b1">Garder ma version hors ligne</button>' +
      '<button type="button" class="pb-sb-b2">' + (armed ? "Confirmer ? modifications hors ligne perdues" : "Prendre la version en ligne") + "</button>" +
      "</div>";
    bar.querySelector(".pb-sb-dl").onclick = e => { e.preventDefault(); backup(c.pid); };
    bar.querySelector(".pb-sb-b1").onclick = () => { conflict = null; renderBar(); sync(true); };
    bar.querySelector(".pb-sb-b2").onclick = () => {
      if (!armed) { armed = true; renderBar(); return; }
      ask({ type: "discard", pid: c.pid }).then(() => { conflict = null; armed = false; renderBar(); location.reload(); });
    };
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && armed) { armed = false; renderBar(); } });

  // Filet de sécurité avant d'abandonner les modifications locales : un fichier JSON brut
  async function backup(pid) {
    const r = await ask({ type: "local", pid });
    const data = (r && r.data) || null;
    if (!data) { flash("err", "Rien à sauvegarder"); return; }
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sauvegarde-hors-ligne_" + (data.name || "plan").replace(/[^\w-]+/g, "_") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ---------- Dialogue avec le service worker ---------- */
  function ask(msg) {
    return navigator.serviceWorker.ready.then(reg => new Promise(res => {
      const target = reg.active || navigator.serviceWorker.controller;
      if (!target) return res(null);
      const ch = new MessageChannel();
      const done = setTimeout(() => res(null), 15000);
      ch.port1.onmessage = e => { clearTimeout(done); res(e.data); };
      target.postMessage(msg, [ch.port2]);
    }));
  }

  async function refresh() {
    const s = await ask({ type: "status" });
    if (s && typeof s.queued === "number") queued = s.queued;
    render();
  }

  /* ---------- Synchronisation ---------- */
  async function sync(force) {
    if (syncing || READONLY) return;                      // on tente même si « onLine » dit non : c'est l'envoi qui tranche
    const s = await ask({ type: "status" });
    if (!s || !s.queued) { queued = 0; render(); return; }
    queued = s.queued;
    syncing = true; render();
    const r = await ask({ type: "flush", force: !!force });
    syncing = false;
    if (r && r.conflict) { conflict = r.conflict; queued = (await ask({ type: "status" }) || {}).queued || queued; render(); return; }
    if (r && r.ok) {
      queued = 0; conflict = null;
      flash("ok", r.uploaded ? "Synchronisé — rechargez pour les images" : "Synchronisé");
      return;
    }
    if (r && r.offline) { render(); return; }
    if (r && r.needsAuth) {                                // plan créé hors ligne : la création en base demande la session admin
      await refresh();
      flash("err", "Connectez-vous pour envoyer ce nouveau plan", 8000);
      return;
    }
    await refresh();
    flash("err", "Échec de la synchronisation", 6000);
  }

  /* ---------- Préparation hors ligne ----------
     Relit le plan et télécharge ses images à travers le service worker, pour que
     tout soit en cache avant la prochaine coupure. Sans réseau : sans effet. */
  async function prime() {
    if (!PID) return;
    setChip("sync", "Préparation hors ligne…");
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const imgs = [];
      if (d.image_path) imgs.push("/uploads/" + d.image_path);
      (d.item_types || []).forEach(t => { if (t && t.image) imgs.push("/uploads/" + t.image); });
      for (const u of imgs) { try { await fetch(u); } catch (_) {} }
      ready();
      flash("ok", "Disponible hors ligne");
    } catch (_) { render(); }
  }
  // Repère pour l'utilisateur (pastille) et pour les tests : le plan survivra à une coupure
  function ready() { document.documentElement.setAttribute("data-pb-offline", "pret"); }

  // Sans réseau et sans copie locale, l'éditeur affiche « Projet introuvable » : on est plus clair.
  function explainBoot() {
    const el = document.querySelector("#bootLoader");
    if (!el || el.style.display === "none" || navigator.onLine) return;
    el.textContent = "Ce plan n'a pas encore été enregistré pour une utilisation hors ligne. Ouvrez-le une fois avec une connexion.";
  }

  navigator.serviceWorker.addEventListener("message", e => {
    const d = e.data || {};
    if (d.type === "pb-status") { queued = d.queued || 0; render(); }
    // le plan provisoire vient d'être créé en base : on suit son vrai identifiant
    if (d.type === "pb-moved" && d.from === PID && d.to) location.replace("/p/" + encodeURIComponent(d.to));
  });
  window.addEventListener("online", () => { render(); sync(false); });
  window.addEventListener("offline", render);
  // Filet : l'événement « online » peut ne jamais arriver (réseau présent mais serveur
  // injoignable, veille de l'ordinateur…). Tant qu'il reste des modifications, on retente.
  setInterval(() => { if (queued && !syncing && !conflict) sync(false); }, 30000);

  navigator.serviceWorker.register("/sw.js").then(async () => {
    await navigator.serviceWorker.ready;
    await refresh();
    if (navigator.onLine) await sync(false);
    if (CONTROLLED_AT_BOOT) ready();                     // déjà aux commandes : le chargement de la page a tout mis en cache
    else await prime();
    setTimeout(explainBoot, 1500);
    // le stockage persistant évite que le navigateur évince le plan quand le disque se remplit
    if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist(); });
  }).catch(() => {});
})();
