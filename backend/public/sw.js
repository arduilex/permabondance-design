/* ==========================================================================
   Permabondance — service worker : édition hors ligne
   ==========================================================================
   Il s'intercale entre l'éditeur et le réseau. Trois rôles :

   1. servir l'interface sans réseau (cache de « coquille ») ;
   2. servir le plan et ses images depuis IndexedDB / Cache Storage quand le
      serveur est injoignable ;
   3. capter les écritures (PATCH, beacon, envois d'images) dans une file
      d'attente, rejouée au retour du réseau par la page (offline.js), qui est
      la seule à pouvoir poser la question en cas de conflit.

   Stratégie volontairement « réseau d'abord » partout sauf pour les images
   (dont le nom de fichier est unique, donc immuable) : en ligne, le service
   worker ne peut jamais servir une version périmée du code. C'est ce qui rend
   son déploiement sûr sur le site de production.

   Interrupteur de secours : remplacer le contenu de ce fichier par le bloc
   documenté dans le README (« Désactiver le mode hors ligne ») désinstalle le
   service worker chez tous les visiteurs, en une visite.
   ========================================================================== */
"use strict";

const VERSION = "1";
const SHELL_CACHE = "pb-shell-" + VERSION;
const IMG_CACHE = "pb-img-" + VERSION;

// Interface : tout ce qu'il faut pour afficher l'éditeur sans réseau.
// editor.html est servi par Express sur /p/<id> ET sur /static/editor.html ;
// c'est la seconde adresse qu'on met en cache, et qu'on renvoie pour /p/<id>.
const SHELL = [
  "/static/editor.html",
  "/static/editor.css",
  "/static/editor.js",
  "/static/offline.js",
  "/static/offline-home.html",
  "/static/favicon-32.png",
  "/static/icon-192.png",
  "/manifest.webmanifest",
];

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "pb-offline", DB_VERSION = 1;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects", { keyPath: "key" });
      if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", { keyPath: "n", autoIncrement: true });
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "path" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
// fn(store) peut renvoyer une IDBRequest : sa valeur est résolue à la fin de la transaction
function call(store, mode, fn) {
  return openDB().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out && typeof out === "object" && "result" in out ? out.result : out);
    t.onerror = t.onabort = () => rej(t.error);
  }));
}
const getRow = key => call("projects", "readonly", s => s.get(key));
const putRow = row => call("projects", "readwrite", s => s.put(row));
const delRow = key => call("projects", "readwrite", s => s.delete(key));
const allQueue = () => call("queue", "readonly", s => s.getAll());
const addQueue = e => call("queue", "readwrite", s => s.add(e));
const delQueue = n => call("queue", "readwrite", s => s.delete(n));
const getBlob = path => call("blobs", "readonly", s => s.get(path)).then(r => r && r.blob);
const putBlob = (path, blob) => call("blobs", "readwrite", s => s.put({ path, blob }));
const delBlob = path => call("blobs", "readwrite", s => s.delete(path));

/* ---------------- Cycle de vie ---------------- */
self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------------- Routage ---------------- */
const RE_API = /^\/api\/(?:projects|view)\/([^/]+)$/;         // GET (lecture du plan) · PATCH (enregistrement)
const RE_BEACON = /^\/api\/projects\/([^/]+)\/beacon$/;       // POST à la fermeture de la page
const RE_IMAGE = /^\/api\/projects\/([^/]+)\/image$/;         // POST image du terrain
const RE_ASSETS = /^\/api\/projects\/([^/]+)\/assets$/;       // POST image d'item
const RE_ASSET1 = /^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/; // DELETE image d'item
const RE_UPLOAD = /^\/uploads\/(.+)$/;
const RE_CREATE = /^\/api\/projects$/;                        // POST : nouveau projet

// Un plan créé sans réseau porte un identifiant provisoire : il n'existe pas encore
// côté serveur, donc on ne tente jamais le réseau pour lui — c'est la synchronisation
// qui le créera et lui donnera son vrai identifiant.
const isLocal = id => /^local_/.test(String(id || ""));
const newLocalId = () => "local_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200, headers: { "Content-Type": "application/json" },
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // ressources externes : rien à faire

  if (req.mode === "navigate") return event.respondWith(handleNavigate(req, url));

  const p = url.pathname;
  if (RE_UPLOAD.test(p) && req.method === "GET") return event.respondWith(handleUpload(req, p));
  if (RE_API.test(p) && req.method === "GET") return event.respondWith(handleRead(req, p));
  if (RE_CREATE.test(p) && req.method === "POST") return event.respondWith(handleCreate(req));
  if (RE_CREATE.test(p) && req.method === "GET") return event.respondWith(handleList(req));
  if (isWrite(req, p)) return event.respondWith(handleWrite(req, url));
  if (p.startsWith("/static/") || p === "/manifest.webmanifest") return event.respondWith(networkFirst(req, SHELL_CACHE));
});

function isWrite(req, p) {
  if (req.method === "PATCH" && RE_API.test(p)) return true;
  if (req.method === "POST" && (RE_BEACON.test(p) || RE_IMAGE.test(p) || RE_ASSETS.test(p))) return true;
  if (req.method === "DELETE" && RE_ASSET1.test(p)) return true;
  return false;
}

/* ---------------- Lectures ---------------- */
// Réseau d'abord ; hors ligne, on sert la copie en cache
async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res && res.ok) (await caches.open(cacheName)).put(req, res.clone());
    return res;
  } catch (_) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw new Error("hors ligne et rien en cache : " + req.url);
  }
}

// Navigation vers /p/<id> ou /v/<jeton> : sans réseau, on rend la coquille de l'éditeur
async function handleNavigate(req, url) {
  // Un plan provisoire n'existe pas côté serveur : on sert directement la coquille
  if (/^\/p\/local_/.test(url.pathname)) {
    const hit = await caches.match("/static/editor.html");
    if (hit) return hit;
  }
  try {
    return await fetch(req);
  } catch (_) {
    const p = url.pathname;
    // sans réseau, la racine (liste admin) laisse la place à l'accueil hors ligne
    const shell = (p.startsWith("/p/") || p.startsWith("/v/")) ? "/static/editor.html" : "/static/offline-home.html";
    const hit = await caches.match(shell);
    return hit || new Response(
      "<!doctype html><meta charset=utf-8><title>Hors ligne</title>" +
      "<body style='font:14px system-ui;padding:40px;color:#1f2a1f'>" +
      "<h1 style='font-weight:400'>Hors ligne</h1><p>Cette page n'a pas encore été enregistrée pour une utilisation hors ligne. " +
      "Ouvrez-la une fois avec une connexion, elle restera ensuite disponible.</p>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

// Images : le nom de fichier porte un horodatage, le contenu ne change jamais → cache d'abord.
// Les images posées hors ligne vivent dans IndexedDB sous un chemin « _local_ ».
async function handleUpload(req, p) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const rel = decodeURIComponent(p.replace(/^\/uploads\//, ""));
  const blob = await getBlob(rel);
  if (blob) return new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg", "Content-Length": String(blob.size) } });
  try {
    const res = await fetch(req);
    if (res && res.ok) (await caches.open(IMG_CACHE)).put(req, res.clone());
    return res;
  } catch (_) {
    return new Response("", { status: 504, statusText: "hors ligne" });
  }
}

// Lecture du plan : réseau d'abord (et on mémorise), copie locale sinon
async function handleRead(req, p) {
  const key = p.match(RE_API)[1];
  if (isLocal(key)) {                                          // plan pas encore créé en base
    const row = await getRow(key);
    return row && row.data ? json(row.data) : json({ error: "plan local introuvable" }, 404);
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const data = await res.clone().json();
      const row = (await getRow(key)) || { key };
      // une écriture locale en attente prime sur ce que renvoie le serveur
      row.data = row.pending ? mergeInto(data, row.data) : data;
      row.serverUpdatedAt = data.updated_at || null;
      await putRow(row);
    }
    return res;
  } catch (_) {
    const row = await getRow(key);
    if (row && row.data) return json(row.data);
    return json({ error: "Ce plan n'a pas encore été enregistré pour une utilisation hors ligne." }, 503);
  }
}
// Les champs modifiés localement sont conservés par-dessus la version serveur
function mergeInto(server, local) {
  if (!local) return server;
  const out = Object.assign({}, server);
  for (const k of ["name", "plants", "zones", "ponds", "ditches", "paths", "items", "item_types", "scale", "palette", "image_path"])
    if (k in local) out[k] = local[k];
  return out;
}

// Création : le serveur s'en charge quand il répond ; sinon on crée un plan provisoire
async function handleCreate(req) {
  const body = await req.clone().text();
  let name = "";
  try { name = (JSON.parse(body) || {}).name || ""; } catch (_) {}
  try {
    const res = await fetch(req);
    if (res && res.ok) return res;
    if (res && res.status !== 401) return res;                 // refus explicite du serveur : à remonter
  } catch (_) {}
  return json(await createLocal(name));
}
async function createLocal(name) {
  const pid = newLocalId();
  const data = {
    id: pid, name: String(name || "Nouveau plan"), image_path: null, view_token: null,
    plants: [], zones: [], ponds: [], ditches: [], paths: [], items: [], item_types: [],
    scale: null, palette: null, updated_at: new Date().toISOString(),
  };
  await putRow({ key: pid, data, pending: true, local: true, localUpdatedAt: data.updated_at });
  await addQueue({ kind: "create", pid, name: data.name, at: Date.now() });
  await notifyClients();
  return { id: pid, local: true };
}

// Liste des projets : celle du serveur, ou à défaut les plans disponibles hors ligne
async function handleList(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) return res;
    if (res && res.status === 401) return res;
    throw new Error("HTTP " + (res && res.status));
  } catch (_) {
    return json(await localProjects());
  }
}
async function localProjects() {
  const rows = await call("projects", "readonly", s => s.getAll());
  const q = await allQueue();
  return rows.filter(r => r && r.data).map(r => ({
    id: r.key,
    name: r.data.name || "Plan sans nom",
    image_path: r.data.image_path || null,
    updated_at: r.localUpdatedAt || r.serverUpdatedAt || null,
    local: !!r.local,
    pending: q.filter(e => e.pid === r.key).length,
  }));
}

/* ---------------- Écritures ---------------- */
async function handleWrite(req, url) {
  const p = url.pathname;
  const pid = (p.match(RE_BEACON) || p.match(RE_IMAGE) || p.match(RE_ASSETS) || p.match(RE_ASSET1) || p.match(RE_API))[1];
  const clone = req.clone();
  if (isLocal(pid)) return queueWrite(clone, url, pid);        // inutile d'essayer : le serveur ne le connaît pas
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      // en ligne : on garde la trace de l'horodatage serveur, base de la détection de conflit
      const d = await res.clone().json().catch(() => null);
      if (d && d.updated_at) await noteServerTime(pid, d.updated_at);
      return res;
    }
    if (res && res.status >= 400 && res.status < 500) return res;  // refus du serveur : à remonter tel quel
    throw new Error("HTTP " + (res && res.status));
  } catch (_) {
    return queueWrite(clone, url, pid);                            // réseau absent : mise en file
  }
}

// Le plan provisoire prend l'identifiant que le serveur vient de lui donner
async function moveRow(from, to) {
  const row = await getRow(from);
  if (!row) return;
  row.key = to; row.local = false;
  if (row.data) row.data.id = to;
  await putRow(row);
  await delRow(from);
}

async function noteServerTime(pid, t) {
  const row = await getRow(pid);
  if (row) { row.serverUpdatedAt = t; await putRow(row); }
}

async function queueWrite(req, url, pid) {
  const p = url.pathname;

  if (RE_IMAGE.test(p) || RE_ASSETS.test(p)) {
    const fd = await req.formData();
    const file = fd.get("image");
    if (!file) return json({ error: "aucune image" }, 400);
    const item = RE_ASSETS.test(p);
    const rel = pid + (item ? "/items/item_local_" : "/plan_local_") + Date.now() + extOf(file.type);
    await putBlob(rel, file);
    await addQueue({ kind: item ? "asset" : "image", pid, path: rel, at: Date.now() });
    if (!item) await patchLocal(pid, { image_path: rel });        // l'éditeur relira ce chemin au rechargement
    await notifyClients();
    return json(item ? { image_path: rel, image_url: "/uploads/" + rel } : { image_url: "/uploads/" + rel });
  }

  if (RE_ASSET1.test(p)) {
    const file = p.match(RE_ASSET1)[2];
    if (/_local_/.test(file)) {                                   // image jamais partie : on l'oublie sur place
      await delBlob(pid + "/items/" + file);
      const items = await allQueue();
      for (const q of items) if (q.path && q.path.endsWith("/" + file)) await delQueue(q.n);
    } else {
      await addQueue({ kind: "asset-delete", pid, url: p, at: Date.now() });
    }
    await notifyClients();
    return json({ ok: true });
  }

  // PATCH ou beacon : corps JSON partiel
  const body = await req.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (_) { return json({ error: "corps illisible" }, 400); }
  await patchLocal(pid, parsed);
  await addQueue({ kind: "patch", pid, url: "/api/projects/" + encodeURIComponent(pid), body, at: Date.now() });
  await notifyClients();
  return json({ ok: true, offline: true });
}

// Applique une modification sur la copie locale, pour que le plan rouvert hors ligne soit à jour
async function patchLocal(pid, body) {
  const row = (await getRow(pid)) || { key: pid, data: null };
  row.data = Object.assign({}, row.data || {}, body);
  row.pending = true;
  row.localUpdatedAt = new Date().toISOString();
  await putRow(row);
}

function extOf(type) {
  return { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" }[type] || ".jpg";
}

/* ---------------- Synchronisation (pilotée par la page) ---------------- */
// Compte les éléments d'un plan, pour décrire les deux versions en cas de conflit
function summarize(d) {
  const n = k => (Array.isArray(d && d[k]) ? d[k].length : 0);
  const pl = (k, s) => `${k} ${s}${k > 1 ? "s" : ""}`;
  const parts = [pl(n("plants"), "plante")];
  if (n("zones")) parts.push(pl(n("zones"), "zone"));
  const eau = n("ponds") + n("ditches"); if (eau) parts.push(`${eau} eau`);
  if (n("paths")) parts.push(pl(n("paths"), "chemin"));
  if (n("items")) parts.push(pl(n("items"), "item"));
  return parts.join(" · ");
}

async function status() {
  const q = await allQueue();
  const pids = [...new Set(q.map(e => e.pid))];
  return { queued: q.length, pids };
}

// Rejoue la file. Sans « force », s'arrête si le plan a bougé en ligne depuis la dernière synchro.
async function flush(force) {
  const items = (await allQueue()).sort((a, b) => a.n - b.n);
  if (!items.length) return { ok: true, queued: 0 };

  for (const pid of [...new Set(items.map(e => e.pid))]) {
    const row = await getRow(pid);
    let server = null;
    try {
      const r = await fetch("/api/projects/" + encodeURIComponent(pid));
      if (r.ok) server = await r.json();
    } catch (_) {
      return { ok: false, offline: true };
    }
    if (!server) continue;                                        // projet disparu : on tentera quand même
    if (!force && row && row.serverUpdatedAt && server.updated_at && server.updated_at !== row.serverUpdatedAt) {
      return {
        ok: false,
        conflict: {
          pid,
          localAt: row.localUpdatedAt || null,
          serverAt: server.updated_at,
          localSummary: summarize(row.data),
          serverSummary: summarize(server),
        },
      };
    }
  }

  const map = {};                                                 // chemin local d'image → chemin réel
  const ids = {};                                                 // identifiant provisoire → identifiant serveur
  let uploaded = false;
  for (const it of items) {
    const pid = ids[it.pid] || it.pid;
    const base = "/api/projects/" + encodeURIComponent(pid);
    try {
      if (it.kind === "create") {
        const r = await fetch("/api/projects", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: it.name || "Nouveau plan" }),
        });
        if (r.status === 401) return { ok: false, needsAuth: true };
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        ids[it.pid] = d.id;
        await moveRow(it.pid, d.id);
      } else if (it.kind === "patch") {
        let body = it.body;
        for (const k in map) body = body.split(k).join(map[k]);
        const r = await fetch(base, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json().catch(() => null);
        if (d && d.updated_at) await noteServerTime(pid, d.updated_at);
      } else if (it.kind === "image" || it.kind === "asset") {
        const blob = await getBlob(it.path);
        if (blob) {
          const fd = new FormData();
          fd.append("image", blob, "x" + extOf(blob.type));
          const r = await fetch(base + (it.kind === "asset" ? "/assets" : "/image"), { method: "POST", body: fd });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const d = await r.json().catch(() => ({}));
          if (it.kind === "asset" && d.image_path) map[it.path] = d.image_path;
          uploaded = true;
        }
      } else if (it.kind === "asset-delete") {
        await fetch(base + "/assets/" + it.url.split("/").pop(), { method: "DELETE" });
      }
      await delQueue(it.n);
    } catch (e) {
      await notifyClients();
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  // les pages ouvertes sur un plan provisoire doivent suivre son nouvel identifiant
  for (const from in ids) {
    const list = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    for (const c of list) c.postMessage({ type: "pb-moved", from, to: ids[from] });
  }

  // tout est parti : on reprend la version du serveur comme référence
  const pids = [...new Set(items.map(e => ids[e.pid] || e.pid))];
  for (const pid of pids) {
    try {
      const r = await fetch("/api/projects/" + encodeURIComponent(pid));
      if (r.ok) {
        const data = await r.json();
        await putRow({ key: pid, data, serverUpdatedAt: data.updated_at || null, pending: false });
      }
    } catch (_) {}
  }
  await notifyClients();
  return { ok: true, queued: 0, uploaded };
}

// L'utilisateur garde la version en ligne : on jette les modifications locales
async function discard(pid) {
  for (const q of await allQueue()) if (q.pid === pid) {
    if (q.path) await delBlob(q.path);
    await delQueue(q.n);
  }
  await delRow(pid);
  await notifyClients();
  return { ok: true };
}

async function notifyClients() {
  const s = await status();
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const c of list) c.postMessage({ type: "pb-status", ...s });
}

self.addEventListener("message", event => {
  const msg = event.data || {};
  const reply = r => { if (event.ports && event.ports[0]) event.ports[0].postMessage(r); };
  const run = async () => {
    if (msg.type === "status") return status();
    if (msg.type === "flush") return flush(!!msg.force);
    if (msg.type === "discard") return discard(msg.pid);
    if (msg.type === "list") return { projects: await localProjects() };
    if (msg.type === "create") return createLocal(msg.name);
    if (msg.type === "local") { const row = await getRow(msg.pid); return { data: (row && row.data) || null }; }
    return { error: "message inconnu" };
  };
  event.waitUntil(run().then(reply, e => reply({ ok: false, error: String((e && e.message) || e) })));
});
