/* ==========================================================================
   Permabondance — éditeur de plan (client)
   Sections : état · sauvegarde · vue · outils · plantes · formes (zones, mares,
              fossés) · calibration · règle · panneau (éléments + fiche) · image ·
              partage · démarrage
   ========================================================================== */
(function(){
  "use strict";
  const COLORS=["#4f7a3a","#c75d3a","#d9a521","#7b4fa3","#3a78c7","#c73a86","#2f9e8f","#8a8a8a"];
  const FIELDS=["nom","annee","type","typeAutre","description","recolte","conservation"];
  const DEFAULT_M=4; // diamètre de plante par défaut (m) quand l'échelle est connue

  // /p/<id> : édition (l'id est le jeton d'édition) · /v/<jeton> : lecture seule (lien client)
  const READONLY=location.pathname.startsWith("/v/");
  const PID=decodeURIComponent(location.pathname.split("/").filter(Boolean).pop()||"");
  const API=(READONLY?"/api/view/":"/api/projects/")+encodeURIComponent(PID);

  const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
  const stage=$("#stage"), vp=$("#viewport"), world=$("#world"), img=$("#plan-img");
  const zoneLayer=$("#zoneLayer"), editLayer=$("#editLayer"), calibLayer=$("#calibLayer"), labelLayer=$("#labelLayer");
  const rulerLayer=$("#rulerLayer"), rulerLabels=$("#rulerLabels");

  /* Catégories du panneau : clé = classe CSS de masquage (.hide-<clé>) + préférence d'affichage.
     kinds : types de sélection appartenant à la catégorie. */
  const CATS={
    plants:{ name:"Plantes", color:"#4f7a3a", kinds:["plant"] },
    zones: { name:"Zones",   color:"#d9a521", kinds:["zone"] },
    water: { name:"Eau",     color:"#3a78c7", kinds:["pond","ditch"] },
    paths: { name:"Chemins", color:"#8a6d3b", kinds:["path"] },
    items: { name:"Items",   color:"#7b4fa3", kinds:["item"] },
  };
  let itemTypeSel=null; // type d'item proposé par l'outil « Poser un item »
  /* Types de chemin : préréglages (couleur, largeur en m) appliqués à la création ou au changement de type ; trait continu */
  const PATH_TYPES={
    route:   { label:"Route",               color:"#8a8a8a", widthM:4 },
    tracteur:{ label:"Passage de tracteur", color:"#8a6d3b", widthM:2.5 },
    pied:    { label:"Passage à pied",      color:"#d9c8a0", widthM:1 },
  };
  let pathType="pied"; // type proposé par l'outil crayon (mémorisé pendant la session)
  /* Formes : polygones fermés (zones, mares) ou polylignes ouvertes (fossés). coll = collection dans state. */
  const SHAPES={
    zone: { coll:"zones",   closed:true,  label:"Zone",  plural:"Zones",  noun:"la zone",  opacity:0.35, color:()=>{ const p=palette(); return p[(state.zones.length+1)%p.length]; }, catLabel:"Catégorie", catList:"zoneCats", catPh:"ex. Potager, Verger, Pelouse…" },
    pond: { coll:"ponds",   closed:true,  label:"Mare",  plural:"Mares",  noun:"la mare",  opacity:0.55, color:()=>"#3a78c7", catLabel:"Nom", catPh:"ex. Mare des canards" },
    ditch:{ coll:"ditches", closed:false, label:"Fossé", plural:"Fossés", noun:"le fossé", opacity:0.9,  color:()=>"#2f6fb3", catLabel:"Nom", catPh:"ex. Fossé nord", width:()=>defaultWidth(1) },
    path: { coll:"paths",   closed:false, label:"Chemin",plural:"Chemins",noun:"le chemin",opacity:0.9,  color:()=>PATH_TYPES[pathType].color, catLabel:"Nom", catPh:"ex. Allée principale", width:()=>defaultWidth(PATH_TYPES[pathType].widthM) },
  };
  function catOfKind(kind){ for(const k in CATS){ if(CATS[k].kinds.includes(kind)) return k; } return null; }
  /* Visibilité d'une catégorie, en trois crans : 0 = tout visible · 1 = étiquettes masquées
     · 2 = tout masqué. Enregistrée dans le projet (colonne « display »), pas dans le
     navigateur : on retrouve le même réglage en rouvrant le plan, d'où qu'on l'ouvre. */
  function catVis(key){ const v=Math.round(+(state.display.hidden||{})[key]||0); return v<0?0:(v>2?2:v); }
  function isHiddenCat(key){ return catVis(key)===2; }
  function isHiddenLabels(key){ return catVis(key)>=1; }

  /* ---------- État ---------- */
  // display : réglages d'affichage propres au plan (visibilité par catégorie), enregistrés en base
  let state={ client:"", imageUrl:null, plants:[], zones:[], ponds:[], ditches:[], paths:[], items:[], itemTypes:[], scale:null, palette:null, display:{hidden:{}}, viewToken:null };
  // Palette du projet (copie : les modifications passent par state.palette) ; défaut = COLORS
  const isHex=c=>/^#[0-9a-f]{6}$/i.test(String(c||""));
  function palette(){ const p=Array.isArray(state.palette)?state.palette.filter(isHex):[]; return (p.length?p:COLORS).slice(); }
  let scale=1, tx=0, ty=0, imgNatW=0, imgNatH=0;
  let sel={ kind:null, id:null };          // kind : "plant" | "zone" | "pond" | "ditch"
  let tool="select";
  let draft=[], draftCursor=null, draftKind=null; // forme en cours de tracé
  let calibPts=[], pendingCalib=false, calibConfirm=false; // calibration d'échelle
  let rulerPts=[], rulerCursor=null, rulerDone=false; // règle de mesure
  let collapsedGroups={}, filterText="";   // panneau « Éléments »
  let prefs=loadPrefs();                   // préférences d'affichage (localStorage)

  function hasImage(){ return imgNatW>0; }
  function isCal(){ return !!(state.scale && state.scale.mPerPx>0); }
  function selPlant(){ return sel.kind==="plant" ? state.plants.find(p=>p.id===sel.id) : null; }
  function selShape(){ const S=SHAPES[sel.kind]; if(!S) return null; const s=state[S.coll].find(x=>x.id===sel.id); return s?{kind:sel.kind,s,S}:null; }
  function selItem(){ return sel.kind==="item" ? state.items.find(i=>i.id===sel.id) : null; }
  function itemType(id){ return state.itemTypes.find(t=>t.id===id)||null; }
  function itemName(it){ const t=itemType(it.typeId); return it.label||(t?t.name:"Item"); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }
  function fmtNum(n,dec){ return n.toLocaleString("fr-FR",{minimumFractionDigits:dec,maximumFractionDigits:dec}); }
  function newId(){ return Date.now()+"_"+Math.random().toString(36).slice(2,6); }
  function nextNumIn(arr){ return arr.reduce((m,x)=>Math.max(m,x.num||0),0)+1; }

  // Date de plantation réduite à l'année : « datePres » (AAAA-MM-JJ) → « annee » (AAAA), même règle que src/db.js.
  // Filet de sécurité côté client : un onglet resté ouvert pendant le déploiement peut encore renvoyer « datePres ».
  function migratePlant(p){
    if(!("datePres" in p)) return false;
    p.annee=(String(p.datePres||"").match(/\d{4}/)||[])[0]||String(p.annee||"").trim();
    delete p.datePres;
    return true;
  }

  function loadPrefs(){
    const def={sheet:true,panel:true,cats:{},hidden:{}};
    try{
      const p=Object.assign(def, JSON.parse(localStorage.getItem("pb.editor")||"{}")); p.cats=p.cats||{}; p.hidden=p.hidden||{};
      // « hidden » était un booléen avant les trois crans de visibilité : true => tout masqué
      for(const k in p.hidden) p.hidden[k] = p.hidden[k]===true ? 2 : (Math.round(+p.hidden[k])||0);
      return p;
    }catch(_){ return def; }
  }
  function savePrefs(){ try{ localStorage.setItem("pb.editor",JSON.stringify(prefs)); }catch(_){} }

  /* ---------- Sauvegarde serveur (autosave) ----------
     Seuls les champs modifiés depuis le dernier enregistrement sont envoyés (le serveur laisse
     les autres intacts). L'échelle est enregistrée immédiatement ; le reste est différé de 1,1 s ;
     à la fermeture de la page, ce qui reste en attente part via sendBeacon. */
  let loaded=false, saveTimer=null, saving=false, dirtyAgain=false, lastSavedParts={};
  function payload(){ return { name:state.client, plants:state.plants, zones:state.zones, ponds:state.ponds, ditches:state.ditches, paths:state.paths, items:state.items, item_types:state.itemTypes, scale:state.scale, palette:state.palette, display:state.display }; }
  function parts(){ const p=payload(), o={}; for(const k in p) o[k]=JSON.stringify(p[k]); return o; }
  // { body: champs modifiés, parts: état complet à mémoriser si l'envoi réussit } ou null si rien à enregistrer
  function pendingDiff(){
    const cur=parts(), body={}; let any=false;
    for(const k in cur){ if(cur[k]!==lastSavedParts[k]){ body[k]=JSON.parse(cur[k]); any=true; } }
    return any?{body,parts:cur}:null;
  }
  function snapshot(){ return JSON.stringify(parts()); }
  function isDirty(){ return !!pendingDiff(); }
  function setSaveStatus(s){
    const el=$("#saveStatus"); el.className="save "+(s||"");
    el.querySelector(".txt").textContent={pending:"Modifications…",saving:"Enregistrement…",saved:"Enregistré",error:"Échec d'enregistrement"}[s]||"";
  }
  // Message temporaire dans la zone d'état (ex. « Échelle enregistrée ✓ »)
  function flashStatus(text,ms){ const el=$("#saveStatus .txt"); const old=el.textContent; el.textContent=text; setTimeout(()=>{ if(el.textContent===text) el.textContent=old; },ms||2000); }
  function scheduleSave(){
    if(!loaded || READONLY) return;
    setSaveStatus("pending");
    clearTimeout(saveTimer);
    saveTimer=setTimeout(doSave,1100);
  }
  // Enregistrement immédiat (sans attendre le délai) ; résout true si tout est enregistré
  function saveNow(){ if(!loaded || READONLY) return Promise.resolve(false); clearTimeout(saveTimer); return doSave(); }
  async function doSave(){
    if(saving){ dirtyAgain=true; return false; }
    const d=pendingDiff();
    if(!d){ setSaveStatus("saved"); return true; }
    saving=true; setSaveStatus("saving");
    let ok=false;
    try{
      const r=await fetch(API,{ method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(d.body) });
      if(r.ok){ lastSavedParts=d.parts; setSaveStatus("saved"); ok=true; }
      else setSaveStatus("error");
    }catch(_){ setSaveStatus("error"); }
    saving=false;
    if(dirtyAgain){ dirtyAgain=false; scheduleSave(); return false; }
    return ok;
  }
  // Fermeture / masquage de la page : ce qui est en attente part tout de suite
  function flushSave(){
    if(!loaded || READONLY) return;
    const d=pendingDiff(); if(!d) return;
    clearTimeout(saveTimer);
    try{
      const sent=navigator.sendBeacon(API+"/beacon", new Blob([JSON.stringify(d.body)],{type:"application/json"}));
      if(sent){ lastSavedParts=d.parts; setSaveStatus("saved"); }
    }catch(_){}
  }
  window.addEventListener("pagehide",flushSave);
  document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden") flushSave(); });
  // beforeunload précède pagehide : on envoie d'abord ; on ne retient l'utilisateur que si l'envoi n'a pas pu partir
  window.addEventListener("beforeunload",e=>{
    if(!loaded || READONLY) return;
    flushSave();
    if(isDirty()){ e.preventDefault(); e.returnValue=""; }
  });

  /* ---------- Vue : transformation, zoom, recadrage ---------- */
  let layoutScale=0; // échelle à laquelle les étiquettes ont été disposées
  function applyTransform(){
    world.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;
    world.style.setProperty("--inv",(1/scale).toFixed(4));
    updateScaleBar();
    if(scale!==layoutScale) layoutLabels(); // le chevauchement ne dépend que du zoom, pas du déplacement
  }
  function fit(){
    if(!hasImage()) return;
    const r=vp.getBoundingClientRect(), pad=40;
    scale=Math.min((r.width-pad)/imgNatW,(r.height-pad)/imgNatH,1);
    if(!isFinite(scale)||scale<=0) scale=1;
    tx=(r.width-imgNatW*scale)/2; ty=(r.height-imgNatH*scale)/2;
    applyTransform();
  }
  // Zoom maximum : profond pour tous les projets ; si calibré, permet d'atteindre ~0,1 m sur la barre d'échelle
  function maxScale(){
    let m=40;
    if(isCal()) m=Math.max(m,1200*state.scale.mPerPx);
    return Math.min(m,8000);
  }
  function zoomAt(cx,cy,factor){
    const r=vp.getBoundingClientRect();
    const px=cx-r.left, py=cy-r.top;
    const ns=Math.min(Math.max(scale*factor,0.05),maxScale());
    tx=px-(px-tx)*(ns/scale); ty=py-(py-ty)*(ns/scale);
    scale=ns; applyTransform();
  }
  // Centre la vue sur un point (% image) ; minScale : zoom minimal souhaité
  function centerOn(xPct,yPct,minScale){
    const r=vp.getBoundingClientRect();
    if(minScale && scale<minScale) scale=Math.min(minScale,maxScale());
    tx=r.width/2-xPct/100*imgNatW*scale; ty=r.height/2-yPct/100*imgNatH*scale;
    applyTransform();
  }
  vp.addEventListener("wheel",e=>{ if(!hasImage())return; e.preventDefault(); const f=Math.exp(-e.deltaY*0.0006); zoomAt(e.clientX,e.clientY,Math.max(0.5,Math.min(2,f))); },{passive:false});
  $("#zIn").onclick=()=>{ const r=vp.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,1.25); };
  $("#zOut").onclick=()=>{ const r=vp.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,1/1.25); };
  $("#zFit").onclick=fit;
  window.addEventListener("resize",()=>{ if(hasImage()) applyTransform(); });

  /* ---------- Coordonnées (stockées en % de l'image) ---------- */
  function clientToPct(cx,cy){
    const r=vp.getBoundingClientRect();
    const px=(cx-r.left-tx)/scale, py=(cy-r.top-ty)/scale;
    return { x:Math.max(0,Math.min(100,px/imgNatW*100)), y:Math.max(0,Math.min(100,py/imgNatH*100)) };
  }
  const X=p=>(p.x/100*imgNatW).toFixed(1), Y=p=>(p.y/100*imgNatH).toFixed(1);
  function distPx(a,b){ return Math.hypot((b.x-a.x)/100*imgNatW,(b.y-a.y)/100*imgNatH); }
  function fmtDist(px){
    if(!isCal()) return Math.round(px)+" px";
    const m=px*state.scale.mPerPx;
    if(m<1) return fmtNum(m*100,0)+" cm";
    if(m<10) return fmtNum(m,2)+" m";
    if(m<1000) return fmtNum(m,1)+" m";
    return fmtNum(m/1000,2)+" km";
  }
  // Largeur par défaut d'une ligne (fossé, chemin) : en mètres si calibré, sinon proportionnelle à l'image
  function defaultWidth(meters){ return isCal() ? Math.max(1,meters/state.scale.mPerPx) : Math.max(3,Math.round((imgNatW||800)*0.006)); }

  /* ==========================================================================
     Outils : un seul actif à la fois. Chaque outil décrit son raccourci, ses
     réactions au pointeur / clavier et le contenu de l'étiquette d'aide.
     Hors de « select », rien n'est cliquable sur le plan (CSS).
     ========================================================================== */
  // Outil de tracé point par point d'une forme (zone, mare, fossé)
  function polyTool(kind,shortcut){
    const S=SHAPES[kind], min=S.closed?3:2;
    return {
      shortcut,
      enter(){ draft=[]; draftCursor=null; draftKind=kind; },
      exit(){ draft=[]; draftCursor=null; draftKind=null; renderDraft(); },
      onClick(e){ addDraftVertex(e.clientX,e.clientY); },
      onMove(e){ draftCursor=clientToPct(e.clientX,e.clientY); renderDraft(); },
      onKey(e){
        if(e.key==="Enter"){ e.preventDefault(); finishDraft(); return true; }
        if(e.key==="Backspace"){ e.preventDefault(); draft.pop(); renderDraft(); updateHint(); return true; }
        return false;
      },
      hint(){
        const n=draft.length;
        let html;
        if(n<min) html=`Cliquez pour poser les points ${S.closed?"de":"du tracé de"} ${S.noun.replace(/^l[ae] /,"")} · <b>${n}</b>`;
        else if(S.closed) html=`<b>${n}</b> points — cliquez le 1ᵉʳ point ou terminez`;
        else html=`<b>${n}</b> points · ${fmtDist(pathLength(draft))} — continuez ou terminez`;
        return { html, actions:[{label:"Terminer",disabled:n<min,onClick:finishDraft,title:"Entrée"},{label:"Annuler",cancel:true,onClick:()=>setTool("select"),title:"Échap · Retour arrière = retirer le dernier point"}] };
      }
    };
  }

  const TOOLS={
    select:{ shortcut:"v" },
    plant:{
      shortcut:"p",
      onClick(e){ placeAt(e.clientX,e.clientY); },
      hint(){ return { text:"Cliquez sur le plan pour poser la plante.", actions:[{label:"Annuler",cancel:true,onClick:()=>setTool("select")}] }; }
    },
    zone: polyTool("zone","z"),
    pond: polyTool("pond","m"),
    ditch:polyTool("ditch","f"),
    // Crayon : le glisser dessine un chemin à main levée (Espace + glisser déplace la carte)
    path:{
      shortcut:"c",
      drag:true,
      enter(){ draft=[]; draftKind="path"; },
      exit(){ draft=[]; draftKind=null; renderDraft(); },
      dragStart(e){ draft=[clientToPct(e.clientX,e.clientY)]; renderDraft(); },
      dragMove(e){
        const p=clientToPct(e.clientX,e.clientY), l=draft[draft.length-1];
        if(l && Math.hypot((p.x-l.x)/100*imgNatW*scale,(p.y-l.y)/100*imgNatH*scale)<3) return; // au moins 3 px écran entre deux points
        draft.push(p); renderDraft();
      },
      dragEnd(){
        const pts=simplify(draft, 2.5/scale); draft=[]; renderDraft();
        if(pts.length<2 || pathLength(pts)<6/scale) return; // simple clic : rien
        const t=PATH_TYPES[pathType];
        const z={ id:newId(), num:nextNumIn(state.paths), cat:"", type:pathType, color:t.color, opacity:0.9, width:defaultWidth(t.widthM), points:pts };
        state.paths.push(z); sel={kind:"path",id:z.id};
        openSheet(); render(); scheduleSave(); updateHint();
      },
      hint(){
        return { html:"Dessinez le chemin au crayon (cliquer-glisser) · <span style='opacity:.65'>Espace + glisser : déplacer la carte</span>",
                 select:{ id:"pathTypeSel", value:pathType, options:Object.keys(PATH_TYPES).map(k=>[k,PATH_TYPES[k].label]), onChange:v=>{ pathType=v; } },
                 actions:[{label:"Terminer",cancel:true,onClick:()=>setTool("select"),title:"Échap"}] };
      }
    },
    // Poser un item : clic = instance du type choisi (bibliothèque du projet)
    item:{
      shortcut:"i",
      enter(){ if(!itemType(itemTypeSel)) itemTypeSel=state.itemTypes.length?state.itemTypes[0].id:null; },
      onClick(e){ if(itemType(itemTypeSel)) placeItem(e.clientX,e.clientY); },
      hint(){
        if(!state.itemTypes.length) return { text:"Aucun item dans la bibliothèque : importez d'abord une image (PNG).", actions:[{label:"Nouvel item…",onClick:()=>$("#fileItem").click()},{label:"Annuler",cancel:true,onClick:()=>setTool("select")}] };
        return { text:"Cliquez sur le plan pour poser :", select:{ id:"itemTypeSel", value:itemTypeSel, options:state.itemTypes.map(t=>[t.id,t.name]), onChange:v=>{ itemTypeSel=v; } },
                 actions:[{label:"Nouvel item…",cancel:true,onClick:()=>$("#fileItem").click(),title:"Importer une image PNG"},{label:"Terminer",cancel:true,onClick:()=>setTool("select"),title:"Échap"}] };
      }
    },
    ruler:{
      shortcut:"r",
      enter(){ rulerPts=[]; rulerCursor=null; rulerDone=false; },
      exit(){ rulerPts=[]; rulerCursor=null; rulerDone=false; renderRuler(); },
      onClick(e){
        if(rulerDone){ rulerPts=[]; rulerDone=false; }   // une mesure terminée : le clic suivant en démarre une nouvelle
        rulerPts.push(clientToPct(e.clientX,e.clientY)); rulerCursor=null;
        renderRuler(); updateHint();
      },
      onMove(e){ if(rulerDone) return; rulerCursor=clientToPct(e.clientX,e.clientY); renderRuler(); },
      onKey(e){
        if(e.key==="Backspace"){ e.preventDefault(); rulerPts.pop(); rulerDone=false; renderRuler(); updateHint(); return true; }
        if(e.key==="Enter"){ e.preventDefault(); if(rulerPts.length>=2){ rulerDone=true; rulerCursor=null; renderRuler(); updateHint(); } return true; }
        return false;
      },
      hint(){
        const n=rulerPts.length, total=pathLength(rulerPts), segs=Math.max(0,n-1);
        let html;
        if(n===0) html="Règle : cliquez le point de départ" + (isCal()?"":" <span style='opacity:.65'>(échelle non définie : mesures en pixels)</span>");
        else if(n===1) html="Cliquez le point suivant";
        else html=(rulerDone?"Mesure : ":"")+`<b>${fmtDist(total)}</b>`+(segs>1?` sur ${segs} segments`:"")+(rulerDone?"":" — cliquez pour prolonger");
        const actions=[];
        if(n>=2 && !rulerDone) actions.push({label:"Figer",onClick:()=>{ rulerDone=true; rulerCursor=null; renderRuler(); updateHint(); },title:"Entrée"});
        if(n>=1) actions.push({label:"Nouvelle mesure",cancel:true,onClick:()=>{ rulerPts=[]; rulerDone=false; renderRuler(); updateHint(); },title:"Retour arrière = retirer le dernier point"});
        actions.push({label:"Quitter",cancel:true,onClick:()=>setTool("select"),title:"Échap"});
        return { html, actions };
      }
    },
    // Import d'un fichier : confirmation puis progression dans l'étiquette d'aide (pas de popup)
    import:{
      noImage:true,
      exit(){ if(!importing) pendingImport=null; },
      hint(){
        if(importError) return { html:`<span class="err">${esc(importError)}</span>`, actions:[{label:"Fermer",cancel:true,onClick:()=>{ importError=null; setTool("select"); }}] };
        if(importing) return { html:`Import en cours — ${esc(importProgress)}` };
        const d=pendingImport; if(!d) return null;
        return { html:`« <b>${esc(d.data.client||d.file.name)}</b> » — ${esc(fileSummary(d.data))}. Remplacer <b>tout</b> le contenu de ce plan ?`,
                 actions:[{label:"Remplacer",onClick:runImport,title:"Entrée"},{label:"Annuler",cancel:true,onClick:()=>setTool("select"),title:"Échap"}] };
      },
      onKey(e){ if(e.key==="Enter" && pendingImport && !importing){ e.preventDefault(); runImport(); return true; } return false; }
    },
    calib:{
      shortcut:"e",
      enter(){ calibPts=[]; calibConfirm=isCal(); renderCalib(); },   // échelle déjà définie : demander confirmation avant de la refaire
      exit(){ calibPts=[]; calibConfirm=false; renderCalib(); },
      onClick(e){ if(calibConfirm) return; addCalibPoint(e.clientX,e.clientY); },
      onKey(e){
        if(calibConfirm){ if(e.key==="Enter"){ e.preventDefault(); calibConfirm=false; updateHint(); return true; } return false; }
        if(e.key==="Enter"&&calibPts.length>=2){ e.preventDefault(); applyCalibration(); return true; }
        return false;
      },
      hint(){
        if(calibConfirm) return { html:`L'échelle est déjà définie (<b>${fmtNum(state.scale.meters||0,1)} m</b> entre les 2 points de référence). La redéfinir ? <span style="opacity:.65">Les mesures en mètres seront recalculées.</span>`,
                                  actions:[{label:"Redéfinir",onClick:()=>{ calibConfirm=false; updateHint(); },title:"Entrée"},{label:"Annuler",cancel:true,onClick:()=>setTool("select"),title:"Échap"}] };
        const n=calibPts.length;
        if(n<2) return { text: n===0 ? "Échelle : cliquez un 1ᵉʳ point sur l'image." : "Cliquez le 2ᵉ point.", actions:[{label:"Annuler",cancel:true,onClick:()=>setTool("select")}] };
        return { text:"Distance réelle entre ces 2 points :", input:{id:"calibDist",value:(state.scale&&state.scale.meters)||"",suffix:"m"},
                 actions:[{label:"Valider",onClick:applyCalibration,title:"Entrée"},{label:"Annuler",cancel:true,onClick:()=>setTool("select")}] };
      }
    }
  };

  const RO_TOOLS=["select","ruler"]; // en lecture seule : navigation et mesures uniquement
  function setTool(name){
    if(!TOOLS[name]) return;
    if(name!=="select" && !hasImage() && !TOOLS[name].noImage) return;
    if(READONLY && !RO_TOOLS.includes(name)) return;
    if(name===tool) return;
    const prev=TOOLS[tool]; if(prev.exit) prev.exit();
    tool=name;
    const t=TOOLS[tool]; if(t.enter) t.enter();
    stage.dataset.tool=tool;
    $$(".rail .tool").forEach(b=>b.classList.toggle("on",b.dataset.tool===tool));
    render(); updateHint();
  }
  $$(".rail .tool").forEach(b=>{ b.onclick=()=>setTool(tool===b.dataset.tool?"select":b.dataset.tool); });

  // Étiquette d'aide contextuelle (en haut de la scène)
  function updateHint(){
    const t=TOOLS[tool], box=$("#tag"), inner=$("#tagIn");
    const h=t.hint ? t.hint() : null;
    if(!h){ box.classList.remove("on"); inner.innerHTML=""; return; }
    inner.innerHTML="";
    const txt=document.createElement("span"); txt.className="txt";
    if(h.html) txt.innerHTML=h.html; else txt.textContent=h.text;
    inner.appendChild(txt);
    if(h.input){
      const inp=document.createElement("input"); inp.type="number"; inp.min="0"; inp.step="0.1"; inp.id=h.input.id; inp.value=h.input.value; inp.placeholder="distance";
      inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); applyCalibration(); } else if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); setTool("select"); } });
      inner.appendChild(inp);
      if(h.input.suffix){ const s=document.createElement("span"); s.className="txt"; s.textContent=h.input.suffix; inner.appendChild(s); }
      setTimeout(()=>inp.focus(),0);
    }
    if(h.select){
      const sl=document.createElement("select"); sl.id=h.select.id;
      h.select.options.forEach(([v,l])=>{ const o=document.createElement("option"); o.value=v; o.textContent=l; if(v===h.select.value) o.selected=true; sl.appendChild(o); });
      sl.onchange=()=>{ h.select.onChange(sl.value); sl.blur(); };
      inner.appendChild(sl);
    }
    (h.actions||[]).forEach(a=>{
      const b=document.createElement("button"); b.type="button"; b.textContent=a.label; if(a.cancel) b.className="cancel";
      if(a.title) b.title=a.title; b.disabled=!!a.disabled; b.onclick=a.onClick; inner.appendChild(b);
    });
    box.classList.add("on");
  }

  /* ---------- Clavier ---------- */
  let spaceHeld=false; // Espace maintenue : glisser = déplacer la carte, même avec l'outil crayon
  window.addEventListener("keyup",e=>{ if(e.key===" "){ spaceHeld=false; vp.classList.remove("spacepan"); } });
  window.addEventListener("blur",()=>{ spaceHeld=false; vp.classList.remove("spacepan"); });
  window.addEventListener("keydown",e=>{
    const t=e.target, tag=(t&&t.tagName||"").toLowerCase();
    const typing=tag==="input"||tag==="textarea"||tag==="select"||(t&&t.isContentEditable);
    if(e.key===" " && !typing){ e.preventDefault(); if(!spaceHeld){ spaceHeld=true; vp.classList.add("spacepan"); } return; }
    if(e.key==="Escape"){
      if(armed){ disarm(); return; }
      if(importing) return;
      if(typing){ t.blur(); return; }
      if(tool!=="select") setTool("select"); else if(sel.kind) clearSel();
      return;
    }
    if(typing||e.metaKey||e.ctrlKey||e.altKey) return;
    const T=TOOLS[tool];
    if(T.onKey && T.onKey(e)) return;
    if(tool==="select" && sel.kind && (e.key==="Delete"||e.key==="Backspace")){ e.preventDefault(); if(!READONLY) requestDeleteByKey(); return; }
    const k=e.key.toLowerCase();
    for(const name in TOOLS){ if(TOOLS[name].shortcut===k){ e.preventDefault(); setTool(tool===name?"select":name); return; } }
  });

  /* ---------- Pointeur sur la scène : déplacement de la carte + clic outil ---------- */
  let panning=false, drawing=false, sx=0, sy=0, stx=0, sty=0, moved=false, downEl=null;
  vp.addEventListener("pointerdown",e=>{
    if(!hasImage()) return;
    if(e.pointerType==="mouse" && e.button!==0 && e.button!==1) return;
    const T=TOOLS[tool];
    try{ vp.setPointerCapture(e.pointerId); }catch(_){}
    // outil « à glisser » (crayon) : le bouton principal dessine, sauf Espace maintenue ou bouton du milieu
    if(T.drag && e.button===0 && !spaceHeld){ drawing=true; T.dragStart(e); return; }
    downEl = tool==="select" ? ((e.target.closest&&(e.target.closest(".marker")||e.target.closest(".shape")))||null) : null;
    panning=true; moved=false; sx=e.clientX; sy=e.clientY; stx=tx; sty=ty;
    vp.classList.add("panning");
    if(T.onMove) T.onMove(e);
  });
  vp.addEventListener("pointermove",e=>{
    const T=TOOLS[tool];
    if(drawing){ T.dragMove(e); return; }
    if(panning){
      tx=stx+(e.clientX-sx); ty=sty+(e.clientY-sy);
      if(Math.abs(e.clientX-sx)+Math.abs(e.clientY-sy)>3) moved=true;
      applyTransform();
    } else setHover(markerAt(e.clientX,e.clientY));
    if(T.onMove) T.onMove(e);
  });
  vp.addEventListener("pointerleave",()=>setHover(null));
  function endPan(e){
    try{ vp.releasePointerCapture(e.pointerId); }catch(_){}
    if(drawing){ drawing=false; TOOLS[tool].dragEnd(e); return false; }
    if(!panning) return false;
    panning=false; vp.classList.remove("panning");
    return true;
  }
  vp.addEventListener("pointerup",e=>{
    if(!endPan(e)) return;
    const wasMoved=moved, el=downEl; downEl=null;
    if(wasMoved) return;
    if(tool==="select"){
      if(el && el.classList.contains("marker")){ if(el.dataset.kind==="item") selectItem(el.dataset.id); else selectPlant(el.dataset.id); }
      else if(el) selectShape(el.dataset.kind, el.dataset.id);
      else if(sel.kind) clearSel();
    } else if(TOOLS[tool].onClick) TOOLS[tool].onClick(e);
  });
  vp.addEventListener("pointercancel",e=>{ if(drawing){ drawing=false; draft=[]; renderDraft(); } endPan(e); downEl=null; });

  /* ---------- Visibilité par catégorie ---------- */
  function applyVisibility(){
    for(const k in CATS){
      const v=catVis(k);
      stage.classList.toggle("hide-"+k, v===2);   // tout masqué
      stage.classList.toggle("lbl-"+k, v===1);    // étiquettes seules
    }
    const c=catOfKind(sel.kind);
    if(c && isHiddenCat(c)) sel={kind:null,id:null};
  }
  function setCatVis(key,v){
    state.display.hidden=Object.assign({},state.display.hidden,{[key]:v});
    applyVisibility(); scheduleSave();
  }
  // L'œil parcourt les crans : tout visible -> étiquettes masquées -> tout masqué -> …
  function toggleCat(key){ setCatVis(key,(catVis(key)+1)%3); render(); }
  // Sélectionner un élément d'une catégorie masquée la réaffiche entièrement
  function ensureVisible(kind){ const c=catOfKind(kind); if(c && isHiddenCat(c)) setCatVis(c,0); }

  /* ---------- Sélection ---------- */
  function selectPlant(id){ ensureVisible("plant"); sel={kind:"plant",id}; openSheet(); render(); revealRow(); }
  function selectShape(kind,id){ if(!SHAPES[kind]) return; ensureVisible(kind); sel={kind,id}; openSheet(); render(); revealRow(); }
  function selectItem(id){ ensureVisible("item"); sel={kind:"item",id}; openSheet(); render(); revealRow(); }
  function clearSel(){ sel={kind:null,id:null}; render(); }
  function revealRow(){ const r=$("#elements .row.sel"); if(r && r.scrollIntoView) r.scrollIntoView({block:"nearest"}); }
  function deleteSelected(){
    const p=selPlant(), sh=selShape(), it=selItem();
    if(p) state.plants=state.plants.filter(x=>x.id!==p.id);
    else if(sh) state[sh.S.coll]=state[sh.S.coll].filter(x=>x.id!==sh.s.id);
    else if(it) state.items=state.items.filter(x=>x.id!==it.id);
    else return;
    sel={kind:null,id:null}; render(); scheduleSave();
  }

  /* ---------- Confirmation sur le bouton lui-même (pas de popup) ----------
     1er clic : le bouton devient « Confirmer ? » ; 2e clic : action. Échap ou un clic ailleurs annule. */
  let armed=null; // { btn, restore }
  function armConfirm(btn,label,onConfirm){
    if(armed && armed.btn===btn){ disarm(); onConfirm(); return; }
    disarm();
    const html=btn.innerHTML, cls=btn.className, title=btn.title;
    btn.classList.add("confirming"); btn.innerHTML=ICON("i-trash")+`<span>${esc(label)}</span>`; btn.title="Cliquez à nouveau pour confirmer · Échap pour annuler";
    armed={ btn, restore:()=>{ if(btn.isConnected){ btn.innerHTML=html; btn.className=cls; btn.title=title; } } };
  }
  function disarm(){ if(armed){ armed.restore(); armed=null; } }
  document.addEventListener("pointerdown",e=>{ if(armed && !armed.btn.contains(e.target)) disarm(); },true);
  // Touche Suppr : arme le bouton Supprimer de la fiche ; une 2e pression confirme
  function requestDeleteByKey(){ const b=$("#sheetActions .btn.del"); if(b && !b.closest("[hidden]")) armConfirm(b,"Confirmer ?",deleteSelected); }

  /* ==========================================================================
     Plantes
     ========================================================================== */
  function defaultDiam(){
    if(isCal()) return Math.max(2,Math.round(DEFAULT_M/state.scale.mPerPx));
    return Math.max(24,Math.round((imgNatW||800)*0.05));
  }
  function placeAt(cx,cy){
    const p=clientToPct(cx,cy);
    const num=nextNumIn(state.plants), pal=palette();
    const plant={ id:newId(), num, x:p.x, y:p.y, color:pal[(num+1)%pal.length], diam:defaultDiam(), opacity:1 };
    FIELDS.forEach(f=>plant[f]="");
    state.plants.push(plant);
    sel={kind:"plant",id:plant.id};
    setTool("select"); openSheet(); scheduleSave();
    const first=$('#sheetPlant [data-f="nom"]'); if(first) first.focus();
  }
  function shade(hex,p){
    hex=(hex||"#4f7a3a").replace("#","");
    if(hex.length===3) hex=hex.split("").map(c=>c+c).join("");
    const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    const f=t=>Math.round(p<0? t*(1+p) : t+(255-t)*p);
    return "#"+[f(r),f(g),f(b)].map(x=>Math.max(0,Math.min(255,x)).toString(16).padStart(2,"0")).join("");
  }
  /* Icône : arbre vu du dessus, contour arrondi façon feuillage */
  function iconSVG(p){
    const c=p.color||"#4f7a3a", d=shade(c,-0.28);
    const n=11, R=27, br=8.5;
    let dark="", col="";
    for(let i=0;i<n;i++){
      const a=(i/n)*Math.PI*2;
      const x=(50+Math.cos(a)*R).toFixed(1), y=(50+Math.sin(a)*R).toFixed(1);
      dark+=`<circle cx="${x}" cy="${y}" r="${br+1.4}" fill="${d}"/>`;
      col +=`<circle cx="${x}" cy="${y}" r="${br}" fill="${c}"/>`;
    }
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="${R+1.4}" fill="${d}"/>${dark}<circle cx="50" cy="50" r="${R}" fill="${c}"/>${col}</svg>`;
  }
  const MOVE_ICON=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><polyline points="8.5 6.5 12 3 15.5 6.5"/><polyline points="8.5 17.5 12 21 15.5 17.5"/><polyline points="6.5 8.5 3 12 6.5 15.5"/><polyline points="17.5 8.5 21 12 17.5 15.5"/></svg>`;

  /* Déplacement d'une plante : uniquement via la poignée de la plante sélectionnée */
  function startMove(e,p,marker){
    e.preventDefault(); e.stopPropagation();
    const handle=marker.querySelector(".handle");
    try{ handle.setPointerCapture(e.pointerId); }catch(_){}
    marker.classList.add("dragging");
    const lblbox=labelLayer.querySelector('.lblbox[data-id="'+p.id+'"]');
    const move=ev=>{
      const pc=clientToPct(ev.clientX,ev.clientY);
      p.x=pc.x; p.y=pc.y;
      marker.style.left=p.x+"%"; marker.style.top=p.y+"%";
      if(lblbox){ lblbox.style.left=p.x+"%"; lblbox.style.top=p.y+"%"; }
    };
    const up=ev=>{
      ev.stopPropagation();
      try{ handle.releasePointerCapture(e.pointerId); }catch(_){}
      marker.classList.remove("dragging");
      handle.removeEventListener("pointermove",move); handle.removeEventListener("pointerup",up);
      renderElements(); layoutLabels(); scheduleSave();
    };
    handle.addEventListener("pointermove",move); handle.addEventListener("pointerup",up);
  }
  function renderMarkers(){
    world.querySelectorAll(".marker").forEach(m=>m.remove());
    if(!hasImage()) return;
    state.plants.forEach(p=>{
      const dm=p.diam||defaultDiam();
      const m=document.createElement("div");
      m.className="marker"+(sel.kind==="plant"&&p.id===sel.id?" sel":"");
      m.dataset.id=p.id; m.dataset.kind="plant";
      m.style.left=p.x+"%"; m.style.top=p.y+"%";
      m.style.width=dm+"px"; m.style.height=dm+"px";
      if(p.opacity!=null && p.opacity<1) m.style.opacity=p.opacity;
      m.innerHTML=`<div class="canopy">${iconSVG(p)}</div><div class="handle" title="Glisser pour déplacer">${MOVE_ICON}</div>`;
      if(!READONLY) m.querySelector(".handle").addEventListener("pointerdown",ev=>startMove(ev,p,m));
      world.appendChild(m);
    });
    state.items.forEach(it=>{
      const t=itemType(it.typeId); if(!t) return;
      const d=itemDims(it);
      const m=document.createElement("div");
      m.className="marker item"+(sel.kind==="item"&&it.id===sel.id?" sel":"");
      m.dataset.id=it.id; m.dataset.kind="item";
      m.style.left=it.x+"%"; m.style.top=it.y+"%";
      m.style.width=d.w+"px"; m.style.height=d.h+"px";
      if(it.opacity!=null && it.opacity<1) m.style.opacity=it.opacity;
      m.innerHTML=`<div class="pic"><img src="/uploads/${esc(t.image)}" alt=""></div><div class="handle" title="Glisser pour déplacer">${MOVE_ICON}</div>`;
      if(!READONLY) m.querySelector(".handle").addEventListener("pointerdown",ev=>startMove(ev,it,m));
      world.appendChild(m);
    });
  }

  /* ==========================================================================
     Items : bibliothèque du projet (image importée) + instances posées sur le plan
     ========================================================================== */
  function defaultItemSize(){ return isCal() ? Math.max(2,Math.round(1.5/state.scale.mPerPx)) : Math.max(20,Math.round((imgNatW||800)*0.04)); }
  // Dimensions (px image) : « size » = largeur, hauteur selon les proportions de l'image du type
  function itemDims(it){ const t=itemType(it.typeId); const w=it.size||defaultItemSize(); const ratio=(t&&t.w&&t.h)?t.h/t.w:1; return { w, h:w*ratio }; }
  function placeItem(cx,cy){
    const p=clientToPct(cx,cy);
    const it={ id:newId(), num:nextNumIn(state.items), typeId:itemTypeSel, x:p.x, y:p.y, size:defaultItemSize(), opacity:1, label:"" };
    state.items.push(it);
    sel={kind:"item",id:it.id};
    setTool("select"); openSheet(); scheduleSave();
  }
  // Import d'une image → nouveau type dans la bibliothèque (nom demandé, proportions mesurées)
  async function uploadItemType(file){
    const dims=await new Promise(res=>{ const im=new Image(); im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight}); im.onerror=()=>res({w:1,h:1}); im.src=URL.createObjectURL(file); });
    const fd=new FormData(); fd.append("image",file);
    setSaveStatus("saving");
    let d;
    try{
      const r=await fetch("/api/projects/"+encodeURIComponent(PID)+"/assets",{method:"POST",body:fd});
      if(!r.ok){ const err=await r.json().catch(()=>({})); setSaveStatus("error"); alert(err.error||"Échec de l'envoi de l'image."); return; }
      d=await r.json();
    }catch(_){ setSaveStatus("error"); alert("Échec de l'envoi de l'image."); return; }
    const defName=(file.name||"Item").replace(/\.[a-z0-9]+$/i,"").replace(/[_-]+/g," ");
    const name=(prompt("Nom de l'item :",defName)||defName).trim().slice(0,80);
    const t={ id:newId(), name, image:d.image_path, w:dims.w, h:dims.h };
    state.itemTypes.push(t); itemTypeSel=t.id;
    prefs.cats.items=true; savePrefs();
    render(); scheduleSave(); updateHint();
    if(tool!=="item") setTool("item");
  }
  $("#fileItem").onchange=e=>{ const f=e.target.files[0]; e.target.value=""; if(f) uploadItemType(f); };
  function renameItemType(t){
    const name=prompt("Nom de l'item :",t.name); if(name===null) return;
    t.name=name.trim().slice(0,80)||t.name; render(); scheduleSave(); updateHint();
  }
  async function deleteItemType(t){
    state.items=state.items.filter(i=>i.typeId!==t.id);
    state.itemTypes=state.itemTypes.filter(x=>x.id!==t.id);
    if(sel.kind==="item" && !state.items.find(i=>i.id===sel.id)) sel={kind:null,id:null};
    if(itemTypeSel===t.id) itemTypeSel=state.itemTypes.length?state.itemTypes[0].id:null;
    render(); scheduleSave(); updateHint();
    const file=String(t.image||"").split("/").pop();
    try{ await fetch("/api/projects/"+encodeURIComponent(PID)+"/assets/"+encodeURIComponent(file),{method:"DELETE"}); }catch(_){}
  }
  // Couche d'étiquettes : noms des formes puis numéros/noms de plantes, toujours au-dessus
  function renderLabels(){
    labelLayer.innerHTML="";
    if(!hasImage()) return;
    for(const kind in SHAPES){
      const S=SHAPES[kind];
      state[S.coll].forEach(s=>{
        if(!s.cat || !s.points || s.points.length<2) return;
        const c=S.closed?centroid(s.points):midOfPath(s.points);
        const zl=document.createElement("div");
        zl.className="zlbl"+(kind==="zone"?"":kind==="path"?" path":" water"); zl.dataset.kind=kind; zl.dataset.id=s.id;
        zl.style.left=c.x+"%"; zl.style.top=c.y+"%"; zl.textContent=s.cat;
        labelLayer.appendChild(zl);
      });
    }
    const lbl=(obj,kind,boxW,boxH,text)=>{
      const gb=document.createElement("div");
      gb.className="lblbox"+(sel.kind===kind&&obj.id===sel.id?" sel":"");
      gb.dataset.id=obj.id; gb.dataset.kind=kind;
      gb.style.left=obj.x+"%"; gb.style.top=obj.y+"%"; gb.style.width=boxW+"px"; gb.style.height=boxH+"px";
      gb.innerHTML=`<div class="meta">${text}</div>`;
      labelLayer.appendChild(gb);
    };
    // pas de numéro : une plante sans nom n'a pas d'étiquette
    state.plants.forEach(p=>{ if(!p.nom) return; const dm=p.diam||defaultDiam(); lbl(p,"plant",dm,dm,esc(p.nom)); });
    state.items.forEach(it=>{ if(!itemType(it.typeId)) return; const d=itemDims(it); lbl(it,"item",d.w,d.h,esc(itemName(it))); });
    measureLabels();
  }

  /* ---------- Étiquettes intelligentes ----------
     Une étiquette qui en chevaucherait une déjà affichée est masquée (au dézoom). Ordre de priorité :
     l'élément sélectionné, puis les étiquettes « autres que plante » (zones, mares, fossés, items ;
     les plus grandes d'abord), puis les plantes (les plus grandes d'abord). Une plante qui touche
     n'importe quelle autre étiquette disparaît donc ; entre deux « autres », la plus petite disparaît.
     Le survol force l'affichage. */
  let labelBoxes=[], hoverId=null;
  const KIND_RANK={ zone:0, pond:0, ditch:1, path:1, item:2, plant:3 };
  function measureLabels(){
    labelBoxes=[];
    const byId={};
    state.plants.forEach(p=>{ const dm=p.diam||defaultDiam(); byId[p.id]={x:p.x,y:p.y,boxH:dm,size:dm,kind:"plant"}; });
    state.items.forEach(it=>{ const d=itemDims(it); byId[it.id]={x:it.x,y:it.y,boxH:d.h,size:Math.max(d.w,d.h),kind:"item"}; });
    for(const kind in SHAPES){ const S=SHAPES[kind];
      state[S.coll].forEach(s=>{ if(!s.points||s.points.length<2) return; const c=S.closed?centroid(s.points):midOfPath(s.points);
        byId[s.id]={x:c.x,y:c.y,boxH:0,size:S.closed?polyMetrics(s.points).areaPx:pathLength(s.points),kind,centered:true}; });
    }
    labelLayer.querySelectorAll(".lblbox, .zlbl").forEach(el=>{
      const o=byId[el.dataset.id]; if(!o) return;
      if(isHiddenLabels(catOfKind(o.kind))) return; // étiquette masquée : n'occupe pas de place
      const r=(el.querySelector(".meta")||el).getBoundingClientRect(); // taille écran (contre-échelle => constante)
      labelBoxes.push({ el, id:el.dataset.id, kind:o.kind, centered:!!o.centered, x:o.x, y:o.y, boxH:o.boxH, size:o.size, w:r.width, h:r.height });
    });
    layoutLabels();
  }
  function layoutLabels(){
    layoutScale=scale;
    if(!labelBoxes.length) return;
    const pri=b=>(b.id===sel.id)?-1:KIND_RANK[b.kind];
    const order=labelBoxes.slice().sort((a,b)=>pri(a)-pri(b) || b.size-a.size);
    const placed=[];
    order.forEach(b=>{
      const cx=b.x/100*imgNatW*scale, cy=b.y/100*imgNatH*scale;
      const top=b.centered ? cy-b.h/2 : cy+0.36*b.boxH*scale+2; // étiquette de forme centrée ; étiquette de marqueur sous le marqueur
      const rc={l:cx-b.w/2-3, t:top-2, r:cx+b.w/2+3, b:top+b.h+2};
      const hit=pri(b)>=0 && placed.some(q=>rc.l<q.r && rc.r>q.l && rc.t<q.b && rc.b>q.t);
      b.el.classList.toggle("hide",hit);
      if(!hit) placed.push(rc);
    });
  }
  // Plante ou item sous le curseur (calcul géométrique : fonctionne même quand rien n'est cliquable)
  function markerAt(cx,cy){
    if(!hasImage()) return null;
    const r=vp.getBoundingClientRect();
    const px=(cx-r.left-tx)/scale, py=(cy-r.top-ty)/scale;
    let best=null, bd=Infinity;
    if(!isHiddenCat("plants")) for(const p of state.plants){
      const rad=Math.max((p.diam||defaultDiam())/2, 8/scale);
      const d=Math.hypot(p.x/100*imgNatW-px, p.y/100*imgNatH-py);
      if(d<=rad && d<bd){ bd=d; best=p; }
    }
    if(!isHiddenCat("items")) for(const it of state.items){
      const dm=itemDims(it), dx=Math.abs(it.x/100*imgNatW-px), dy=Math.abs(it.y/100*imgNatH-py);
      if(dx<=Math.max(dm.w/2,8/scale) && dy<=Math.max(dm.h/2,8/scale)){ const d=Math.hypot(dx,dy); if(d<bd){ bd=d; best=it; } }
    }
    return best;
  }
  // Survol : l'étiquette ET le dessin (plante ou item) passent en surbrillance
  function setHover(p){
    const id=p?p.id:null;
    if(id===hoverId) return;
    const mark=(pid,on)=>{ if(!pid) return; const sel='[data-id="'+pid+'"]';
      const lb=labelLayer.querySelector('.lblbox'+sel), mk=world.querySelector('.marker'+sel);
      if(lb) lb.classList.toggle("hover",on); if(mk) mk.classList.toggle("hover",on); };
    mark(hoverId,false); hoverId=id; mark(id,true);
  }

  /* ==========================================================================
     Formes : zones, mares (polygones) · fossés (polylignes)
     ========================================================================== */
  function sizeLayers(){ if(!hasImage())return; [zoneLayer,calibLayer,editLayer,rulerLayer].forEach(s=>{ s.setAttribute("width",imgNatW); s.setAttribute("height",imgNatH); s.setAttribute("viewBox","0 0 "+imgNatW+" "+imgNatH); }); }
  function centroid(pts){ let x=0,y=0; pts.forEach(p=>{x+=p.x;y+=p.y;}); return {x:x/pts.length,y:y/pts.length}; }
  function ptsStr(pts){ return pts.map(p=>X(p)+","+Y(p)).join(" "); }
  function pathLength(pts){ let l=0; for(let i=1;i<pts.length;i++) l+=distPx(pts[i-1],pts[i]); return l; }
  // Point à mi-longueur d'une polyligne (pour son étiquette)
  function midOfPath(pts){
    const half=pathLength(pts)/2; let acc=0;
    for(let i=1;i<pts.length;i++){
      const d=distPx(pts[i-1],pts[i]);
      if(acc+d>=half){ const t=d?(half-acc)/d:0; return { x:pts[i-1].x+(pts[i].x-pts[i-1].x)*t, y:pts[i-1].y+(pts[i].y-pts[i-1].y)*t }; }
      acc+=d;
    }
    return pts[pts.length-1]||{x:0,y:0};
  }
  function pointInPoly(pt,pts){
    let inside=false;
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
      if(((yi>pt.y)!==(yj>pt.y)) && (pt.x < (xj-xi)*(pt.y-yi)/((yj-yi)||1e-9)+xi)) inside=!inside;
    }
    return inside;
  }
  function zoneOfPlant(p){
    for(const z of state.zones){ if(z.points && z.points.length>=3 && pointInPoly(p,z.points)) return z; }
    return null;
  }
  // Surface (px²) et périmètre (px) d'un polygone, en pixels image
  function polyMetrics(pts){
    let a=0, per=0; const n=pts.length;
    for(let i=0;i<n;i++){
      const p=pts[i], q=pts[(i+1)%n];
      const px=p.x/100*imgNatW, py=p.y/100*imgNatH, qx=q.x/100*imgNatW, qy=q.y/100*imgNatH;
      a+=px*qy-qx*py; per+=Math.hypot(qx-px,qy-py);
    }
    return { areaPx:Math.abs(a)/2, perimPx:per };
  }
  // Simplification de Douglas-Peucker (points en % ; eps en px image)
  function simplify(pts,eps){
    if(pts.length<3) return pts.slice();
    const P=pts.map(p=>({x:p.x/100*imgNatW,y:p.y/100*imgNatH}));
    const perp=(p,a,b)=>{ const dx=b.x-a.x, dy=b.y-a.y, l2=dx*dx+dy*dy; if(!l2) return Math.hypot(p.x-a.x,p.y-a.y); const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)); return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy)); };
    const keep=new Array(P.length).fill(false); keep[0]=keep[P.length-1]=true;
    const stack=[[0,P.length-1]];
    while(stack.length){
      const [a,b]=stack.pop(); let idx=-1, dmax=0;
      for(let i=a+1;i<b;i++){ const d=perp(P[i],P[a],P[b]); if(d>dmax){ dmax=d; idx=i; } }
      if(dmax>eps){ keep[idx]=true; stack.push([a,idx],[idx,b]); }
    }
    return pts.filter((_,i)=>keep[i]);
  }
  function shapeEls(id){ return zoneLayer.querySelectorAll('[data-id="'+id+'"]'); }
  function setShapePoints(id,pts){ const str=ptsStr(pts); shapeEls(id).forEach(el=>el.setAttribute("points",str)); }

  function shapeSVG(kind,s,selected){
    const S=SHAPES[kind], cls="shape"+(selected?" sel":"");
    if(S.closed) return `<polygon class="${cls}" data-kind="${kind}" data-id="${s.id}" points="${ptsStr(s.points)}" fill="${s.color}" fill-opacity="${s.opacity}" stroke="${shade(s.color,-0.35)}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    const w=s.width||defaultWidth(1);
    // ligne visible (largeur réelle) + ligne de saisie invisible à largeur écran constante
    return `<polyline class="shape-line" data-kind="${kind}" data-id="${s.id}" points="${ptsStr(s.points)}" fill="none" stroke="${s.color}" stroke-width="${w}" stroke-opacity="${s.opacity}" stroke-linecap="round" stroke-linejoin="round"/>`
         + `<polyline class="${cls} hit" data-kind="${kind}" data-id="${s.id}" points="${ptsStr(s.points)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  function renderShapes(){
    if(!hasImage()){ zoneLayer.innerHTML=""; editLayer.innerHTML=""; return; }
    const sh=selShape();
    let svg="", selSvg="";
    for(const kind in SHAPES){
      state[SHAPES[kind].coll].forEach(s=>{
        if(!s.points || s.points.length<2) return;
        const selected=!!(sh && sh.kind===kind && s.id===sh.s.id);
        const part=shapeSVG(kind,s,selected);
        if(selected) selSvg=part; else svg+=part;   // la forme sélectionnée passe au premier plan
      });
    }
    zoneLayer.innerHTML=svg+selSvg+`<g id="draftGroup"></g>`;
    renderDraft();
    if(sh && tool==="select" && !READONLY) buildShapeEditors(sh.kind,sh.s); else editLayer.innerHTML="";
  }

  // Poignées de la forme sélectionnée : sommets (déformer, double-clic = supprimer), milieux (ajouter), centre (déplacer)
  function buildShapeEditors(kind,z){
    const S=SHAPES[kind], R=10, n=z.points.length; // R : rayon en px écran (contre-échelle en CSS)
    const minPts=S.closed?3:2, edges=S.closed?n:n-1;
    let s="";
    for(let i=0;i<edges;i++){ const p=z.points[i], q=z.points[(i+1)%n]; const m={x:(p.x+q.x)/2,y:(p.y+q.y)/2}; s+=`<circle class="mhandle" data-i="${i}" cx="${X(m)}" cy="${Y(m)}" r="${(R*0.7).toFixed(1)}"><title>Glisser pour ajouter un point</title></circle>`; }
    z.points.forEach((p,i)=>{ s+=`<circle class="vhandle" data-i="${i}" cx="${X(p)}" cy="${Y(p)}" r="${R}"><title>Glisser pour déformer · double-clic pour supprimer</title></circle>`; });
    const c=S.closed?centroid(z.points):midOfPath(z.points), cr=R*1.5, a=cr*0.55;
    s+=`<circle class="zmove" cx="${X(c)}" cy="${Y(c)}" r="${cr.toFixed(1)}"><title>Glisser pour déplacer</title></circle>`;
    s+=`<path class="zmove-ic" d="M ${+X(c)} ${(+Y(c)-a).toFixed(1)} V ${(+Y(c)+a).toFixed(1)} M ${(+X(c)-a).toFixed(1)} ${+Y(c)} H ${(+X(c)+a).toFixed(1)}"/>`;
    editLayer.innerHTML=s;
    editLayer.querySelectorAll(".vhandle").forEach(h=>{
      h.addEventListener("pointerdown",ev=>startVertexDrag(ev,z,+h.getAttribute("data-i"),h));
      h.addEventListener("dblclick",ev=>{ ev.stopPropagation(); const i=+h.getAttribute("data-i"); if(z.points.length>minPts){ z.points.splice(i,1); render(); scheduleSave(); } });
    });
    editLayer.querySelectorAll(".mhandle").forEach(h=>h.addEventListener("pointerdown",ev=>startMidpointDrag(ev,z,+h.getAttribute("data-i"))));
    editLayer.querySelector(".zmove").addEventListener("pointerdown",ev=>startShapeMove(ev,kind,z));
  }
  function startVertexDrag(e,z,i,handle){
    e.preventDefault(); e.stopPropagation();
    try{ handle.setPointerCapture(e.pointerId); }catch(_){}
    const sx0=e.clientX, sy0=e.clientY; let movedV=false;
    const move=ev=>{
      // ignore les micro-mouvements : un simple clic ne re-rend pas la poignée, ce qui laisse passer le double-clic
      if(!movedV && Math.abs(ev.clientX-sx0)+Math.abs(ev.clientY-sy0)<=3) return;
      movedV=true;
      const p=clientToPct(ev.clientX,ev.clientY);
      z.points[i]={x:p.x,y:p.y};
      handle.setAttribute("cx",X(p)); handle.setAttribute("cy",Y(p));
      setShapePoints(z.id,z.points);
    };
    const up=ev=>{ ev.stopPropagation(); try{ handle.releasePointerCapture(e.pointerId); }catch(_){}
      handle.removeEventListener("pointermove",move); handle.removeEventListener("pointerup",up);
      if(movedV){ render(); scheduleSave(); } };
    handle.addEventListener("pointermove",move); handle.addEventListener("pointerup",up);
  }
  function startMidpointDrag(e,z,i){
    e.preventDefault(); e.stopPropagation();
    const p=clientToPct(e.clientX,e.clientY);
    z.points.splice(i+1,0,{x:p.x,y:p.y});
    render(); scheduleSave();
    const nh=editLayer.querySelector('.vhandle[data-i="'+(i+1)+'"]');
    if(nh) startVertexDrag(e,z,i+1,nh);
  }
  function startShapeMove(e,kind,z){
    e.preventDefault(); e.stopPropagation();
    const handle=editLayer.querySelector(".zmove");
    try{ handle.setPointerCapture(e.pointerId); }catch(_){}
    const start=clientToPct(e.clientX,e.clientY);
    const orig=z.points.map(p=>({x:p.x,y:p.y}));
    const move=ev=>{
      const cur=clientToPct(ev.clientX,ev.clientY);
      const dx=cur.x-start.x, dy=cur.y-start.y;
      z.points=orig.map(p=>({x:Math.max(0,Math.min(100,p.x+dx)),y:Math.max(0,Math.min(100,p.y+dy))}));
      setShapePoints(z.id,z.points);
      const c=SHAPES[kind].closed?centroid(z.points):midOfPath(z.points); handle.setAttribute("cx",X(c)); handle.setAttribute("cy",Y(c));
    };
    const up=ev=>{ ev.stopPropagation(); try{ handle.releasePointerCapture(e.pointerId); }catch(_){}
      handle.removeEventListener("pointermove",move); handle.removeEventListener("pointerup",up); render(); scheduleSave(); };
    handle.addEventListener("pointermove",move); handle.addEventListener("pointerup",up);
  }

  // Tracé en cours (outils zone / mare / fossé)
  function renderDraft(){
    const g=$("#draftGroup"); if(!g) return;
    if(!draftKind || !draft.length){ g.innerHTML=""; return; }
    const S=SHAPES[draftKind];
    const preview=draftCursor?draft.concat([draftCursor]):draft.slice();
    const r=7; // px écran (contre-échelle en CSS)
    let s="";
    if(draftKind==="path"){ // crayon : trait libre, sans sommets
      const w=defaultWidth(PATH_TYPES[pathType].widthM);
      g.innerHTML=draft.length>=2?`<polyline points="${ptsStr(draft)}" fill="none" stroke="${PATH_TYPES[pathType].color}" stroke-opacity=".8" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`:"";
      return;
    }
    if(S.closed && draft.length>=3) s+=`<polygon class="draftline" points="${ptsStr(draft)}"/>`;
    if(preview.length>=2) s+=`<polyline class="draftline" style="fill:none" points="${ptsStr(preview)}"/>`;
    draft.forEach((p,i)=>{ s+=`<circle class="vtx${i===0&&S.closed?' first':''}" cx="${X(p)}" cy="${Y(p)}" r="${r}"/>`; });
    g.innerHTML=s;
  }
  function addDraftVertex(cx,cy){
    const S=SHAPES[draftKind]; if(!S) return;
    const p=clientToPct(cx,cy);
    if(S.closed && draft.length>=3){
      const f=draft[0];
      const dx=(f.x-p.x)/100*imgNatW*scale, dy=(f.y-p.y)/100*imgNatH*scale;
      if(Math.hypot(dx,dy)<14){ finishDraft(); return; }
    }
    draft.push(p); draftCursor=null; renderDraft(); updateHint();
  }
  function finishDraft(){
    const kind=draftKind, S=SHAPES[kind]; if(!S){ setTool("select"); return; }
    const min=S.closed?3:2;
    if(draft.length>=min){
      const coll=state[S.coll];
      const z={ id:newId(), num:nextNumIn(coll), cat:"", color:S.color(), opacity:S.opacity, points:draft.slice() };
      if(S.width) z.width=S.width();
      coll.push(z); sel={kind,id:z.id};
      setTool("select"); openSheet(); scheduleSave();
      const cat=$("#sCat"); if(cat) cat.focus();
      return;
    }
    setTool("select");
  }

  /* ==========================================================================
     Calibration de l'échelle (2 points + distance réelle)
     ========================================================================== */
  function renderCalib(){
    if(!hasImage() || tool!=="calib"){ calibLayer.innerHTML=""; return; }
    const r=Math.max(3,Math.round(imgNatW*0.006));
    let s="";
    if(calibPts.length===2) s+=`<line class="calibline" x1="${X(calibPts[0])}" y1="${Y(calibPts[0])}" x2="${X(calibPts[1])}" y2="${Y(calibPts[1])}"/>`;
    calibPts.forEach(p=>{ s+=`<circle class="calibpt" cx="${X(p)}" cy="${Y(p)}" r="${r}"/>`; });
    calibLayer.innerHTML=s;
  }
  function addCalibPoint(cx,cy){
    if(calibPts.length>=2) return;
    calibPts.push(clientToPct(cx,cy));
    renderCalib(); updateHint();
  }
  function applyCalibration(){
    if(calibPts.length<2) return;
    const inp=$("#calibDist");
    const meters=parseFloat(String(inp?inp.value:"").replace(",","."));
    if(!(meters>0)){ if(inp) inp.focus(); return; }
    const a=calibPts[0], b=calibPts[1];
    const pixDist=Math.hypot((b.x-a.x)/100*imgNatW,(b.y-a.y)/100*imgNatH);
    if(pixDist<1){ alert("Les deux points sont trop proches, recommencez."); return; }
    state.scale={ mPerPx:meters/pixDist, p1:a, p2:b, meters:meters };
    setTool("select"); updateScaleBar();
    // l'échelle conditionne toutes les mesures : enregistrée tout de suite, avec confirmation visible
    saveNow().then(ok=>{ if(ok) flashStatus("Échelle enregistrée ✓",2500); else if($("#saveStatus").classList.contains("error")) alert("L'échelle n'a pas pu être enregistrée (connexion au serveur ?). Elle sera renvoyée automatiquement à la prochaine modification."); });
  }

  /* ==========================================================================
     Règle de mesure : polyligne transitoire (non sauvegardée), distances réelles
     ========================================================================== */
  function renderRuler(){
    if(!hasImage() || tool!=="ruler"){ rulerLayer.innerHTML=""; rulerLabels.innerHTML=""; return; }
    const pts=rulerPts.slice(), preview=(!rulerDone && rulerCursor && rulerPts.length) ? rulerCursor : null;
    let svg="", html="";
    if(pts.length>=2){ svg+=`<polyline class="rhalo" points="${ptsStr(pts)}"/><polyline class="rline" points="${ptsStr(pts)}"/>`; }
    if(preview){ const seg=[pts[pts.length-1],preview]; svg+=`<polyline class="rhalo" points="${ptsStr(seg)}"/><polyline class="rline preview" points="${ptsStr(seg)}"/>`; }
    pts.forEach(p=>{ svg+=`<circle class="rpt" cx="${X(p)}" cy="${Y(p)}" r="5"/>`; });
    // étiquette par segment (au milieu), total sur le dernier point
    const all=preview?pts.concat([preview]):pts;
    for(let i=1;i<all.length;i++){
      const a=all[i-1], b=all[i], m={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      html+=`<div class="rlbl" style="left:${m.x}%;top:${m.y}%">${fmtDist(distPx(a,b))}</div>`;
    }
    if(all.length>=3){
      const last=all[all.length-1];
      html+=`<div class="rlbl total" style="left:${last.x}%;top:${last.y}%;margin-top:-22px">Total ${fmtDist(pathLength(all))}</div>`;
    }
    rulerLayer.innerHTML=svg; rulerLabels.innerHTML=html;
  }

  /* ---------- Barre d'échelle ---------- */
  function niceNumber(x){
    const steps=[0.1,0.2,0.5,1,2,5,10,20,50,100,200,500,1000,2000,5000];
    for(let i=steps.length-1;i>=0;i--){ if(steps[i]<=x) return steps[i]; }
    return steps[0];
  }
  function updateScaleBar(){
    const sb=$("#scaleBar");
    if(!isCal()){ sb.style.display="none"; return; }
    const pxPerM=scale/state.scale.mPerPx;
    if(!isFinite(pxPerM)||pxPerM<=0){ sb.style.display="none"; return; }
    const nice=niceNumber(90/pxPerM);
    sb.style.display="flex";
    $("#scaleBarBar").style.width=(nice*pxPerM).toFixed(1)+"px";
    $("#scaleBarLabel").textContent = nice>=1000 ? (nice/1000)+" km" : (nice+" m");
  }

  /* ==========================================================================
     Panneau « Éléments » : catégories repliables, filtre, lignes
     ========================================================================== */
  const ICON=n=>`<svg class="ic"><use href="#${n}"/></svg>`;
  function matches(txt){ return !filterText || String(txt||"").toLowerCase().includes(filterText); }

  function plantRow(p){
    const row=document.createElement("div");
    row.className="row"+(sel.kind==="plant"&&p.id===sel.id?" sel":"");
    const sub=(p.type==="Autre"?p.typeAutre:p.type)||"—";
    row.innerHTML=`<span class="dot" style="background:${p.color}"></span><div class="info"><div class="nm">${esc(p.nom||"Plante sans nom")}</div><div class="vr">${esc(sub)}</div></div>`;
    row.onclick=()=>selectPlant(p.id);
    row.ondblclick=()=>centerOn(p.x,p.y,Math.min(maxScale(),60/(p.diam||defaultDiam())));
    row.title="Double-clic : centrer la carte sur la plante";
    return row;
  }
  function shapeRow(kind,z){
    const S=SHAPES[kind];
    const row=document.createElement("div");
    row.className="row"+(sel.kind===kind&&z.id===sel.id?" sel":"");
    const sub=S.closed ? `${z.points.length} points · ${Math.round(z.opacity*100)} %` : (kind==="path"&&PATH_TYPES[z.type]?PATH_TYPES[z.type].label+" · ":"")+fmtDist(pathLength(z.points));
    row.innerHTML=`<span class="sw" style="background:${z.color};opacity:${(0.45+z.opacity*0.55).toFixed(2)}"></span><div class="info"><div class="nm">${esc(z.cat||(S.label+" sans nom"))}</div><div class="vr">${sub}</div></div>`;
    row.onclick=()=>selectShape(kind,z.id);
    row.ondblclick=()=>{ const c=S.closed?centroid(z.points):midOfPath(z.points); centerOn(c.x,c.y); };
    row.title="Double-clic : centrer la carte";
    return row;
  }
  function groupHead(name,color,count,key,frag){
    const collapsed=!filterText && !!collapsedGroups[key];
    const head=document.createElement("div");
    head.className="grp-head"+(collapsed?" collapsed":"");
    head.innerHTML=`${ICON("i-chev").replace('class="ic"','class="ic chev"')}<span class="gsw" style="background:${color}"></span><span class="gname">${esc(name)}</span><span class="gcount">${count}</span>`;
    head.onclick=()=>{ collapsedGroups[key]=!collapsedGroups[key]; renderElements(); };
    frag.appendChild(head);
    return !collapsed;
  }
  function plantsBody(plants){
    const frag=document.createDocumentFragment();
    const hasZones=state.zones.some(z=>z.points && z.points.length>=3);
    if(!hasZones){ plants.forEach(p=>frag.appendChild(plantRow(p))); return frag; }
    // Regroupement par zone (ordre de numéro), « Sans zone » à la fin
    const groups=[], map={};
    const grp=(key,name,color)=>{ if(!map[key]){ map[key]={key,name,color,plants:[]}; groups.push(map[key]); } return map[key]; };
    state.zones.slice().sort((a,b)=>a.num-b.num).forEach(z=>{ if(z.points && z.points.length>=3) grp("z_"+z.id,z.cat||"Zone sans nom",z.color); });
    plants.forEach(p=>{ const z=zoneOfPlant(p); (z?grp("z_"+z.id,z.cat||"Zone sans nom",z.color):grp("none","Sans zone","#8a8a8a")).plants.push(p); });
    groups.filter(g=>g.plants.length>0).forEach(g=>{ if(groupHead(g.name,g.color,g.plants.length,g.key,frag)) g.plants.forEach(p=>frag.appendChild(plantRow(p))); });
    return frag;
  }
  function catBlock(o){
    const open=!!filterText || prefs.cats[o.key]!==false, vis=catVis(o.key), off=vis===2;
    const cat=document.createElement("div"); cat.className="cat"+(open?" open":"")+(off?" off":"")+(vis===1?" nolbl":"");
    const head=document.createElement("div"); head.className="cat-head";
    head.innerHTML=`${ICON("i-chev").replace('class="ic"','class="ic chev"')}<span class="csw" style="background:${o.color}"></span><span class="cname">${o.name}</span><span class="ccount">${filterText?o.count+" / "+o.total:o.total}</span>`;
    // L'icône montre l'état courant, l'infobulle annonce ce que fera le clic
    const EYE_ICON=["i-eye","i-label-off","i-eye-off"];
    const EYE_NEXT=["Masquer les étiquettes","Tout masquer sur le plan","Tout afficher"];
    const eye=document.createElement("button"); eye.className="eye"; eye.type="button";
    eye.title=EYE_NEXT[vis]; eye.setAttribute("aria-label",eye.title);
    eye.innerHTML=ICON(EYE_ICON[vis]);
    eye.onclick=ev=>{ ev.stopPropagation(); toggleCat(o.key); };
    head.appendChild(eye);
    (READONLY?[]:(o.adds||[])).forEach(a=>{
      const add=document.createElement("button"); add.className="add"+(a.icon?" tool-ic":""); add.type="button"; add.title=a.tip; add.setAttribute("aria-label",a.tip);
      add.innerHTML=ICON(a.icon||"i-plus"); add.disabled=!hasImage();
      add.onclick=ev=>{ ev.stopPropagation(); setTool(a.tool); };
      head.appendChild(add);
    });
    head.onclick=()=>{ prefs.cats[o.key]=!(prefs.cats[o.key]!==false); savePrefs(); renderElements(); };
    cat.appendChild(head);
    const body=document.createElement("div"); body.className="cat-body";
    if(o.count||o.forceBody) body.appendChild(o.body); else { const e=document.createElement("div"); e.className="cat-empty"; e.textContent=filterText?"Aucun résultat.":(hasImage()?o.empty:"Importez d'abord une image du terrain."); body.appendChild(e); }
    cat.appendChild(body);
    return cat;
  }
  function renderElements(){
    const root=$("#elements"); root.innerHTML="";
    const byNum=(a,b)=>a.num-b.num;
    const plants=state.plants.filter(p=>matches([p.nom,p.type,p.typeAutre].join(" "))).sort(byNum);
    root.appendChild(catBlock({ key:"plants", name:CATS.plants.name, color:CATS.plants.color, count:plants.length, total:state.plants.length,
      adds:[{tool:"plant",tip:"Poser une plante (P)"}], body:plantsBody(plants), empty:"Aucune plante. Utilisez l'outil « Poser une plante » (P) ou le bouton +." }));

    const zones=state.zones.filter(z=>matches(z.cat||"Zone")).sort(byNum);
    const zb=document.createDocumentFragment(); zones.forEach(z=>zb.appendChild(shapeRow("zone",z)));
    root.appendChild(catBlock({ key:"zones", name:CATS.zones.name, color:CATS.zones.color, count:zones.length, total:state.zones.length,
      adds:[{tool:"zone",tip:"Dessiner une zone (Z)"}], body:zb, empty:"Aucune zone. Utilisez l'outil « Dessiner une zone » (Z) ou le bouton +." }));

    // Eau : mares puis fossés, en sous-groupes
    const ponds=state.ponds.filter(z=>matches(z.cat||"Mare")).sort(byNum);
    const ditches=state.ditches.filter(z=>matches(z.cat||"Fossé")).sort(byNum);
    const wb=document.createDocumentFragment();
    if(ponds.length && groupHead("Mares","#3a78c7",ponds.length,"w_ponds",wb)) ponds.forEach(z=>wb.appendChild(shapeRow("pond",z)));
    if(ditches.length && groupHead("Fossés","#2f6fb3",ditches.length,"w_ditches",wb)) ditches.forEach(z=>wb.appendChild(shapeRow("ditch",z)));
    root.appendChild(catBlock({ key:"water", name:CATS.water.name, color:CATS.water.color, count:ponds.length+ditches.length, total:state.ponds.length+state.ditches.length,
      adds:[{tool:"pond",tip:"Dessiner une mare (M)",icon:"i-pond"},{tool:"ditch",tip:"Tracer un fossé (F)",icon:"i-ditch"}], body:wb,
      empty:"Aucune mare ni fossé. Utilisez les outils Mare (M) et Fossé (F)." }));

    const paths=state.paths.filter(z=>matches((z.cat||"Chemin")+" "+(PATH_TYPES[z.type]?PATH_TYPES[z.type].label:""))).sort(byNum);
    const pb=document.createDocumentFragment(); paths.forEach(z=>pb.appendChild(shapeRow("path",z)));
    root.appendChild(catBlock({ key:"paths", name:CATS.paths.name, color:CATS.paths.color, count:paths.length, total:state.paths.length,
      adds:[{tool:"path",tip:"Dessiner un chemin au crayon (C)",icon:"i-path"}], body:pb, empty:"Aucun chemin. Utilisez l'outil Crayon (C) : cliquer-glisser pour dessiner." }));

    // Items : bibliothèque (types) puis exemplaires posés
    const ib=document.createDocumentFragment();
    const addBtn=document.createElement("button"); addBtn.type="button"; addBtn.className="btn sm lib-add"; addBtn.innerHTML=ICON("i-upload")+"Nouvel item (image PNG)";
    addBtn.disabled=!hasImage(); addBtn.onclick=()=>$("#fileItem").click();
    ib.appendChild(addBtn);
    const types=state.itemTypes.filter(t=>matches(t.name));
    if(types.length && groupHead("Bibliothèque",CATS.items.color,types.length,"i_lib",ib)) types.forEach(t=>ib.appendChild(libRow(t)));
    const items=state.items.filter(it=>matches(itemName(it))).sort(byNum);
    if(items.length && groupHead("Sur le plan","#b39ddb",items.length,"i_placed",ib)) items.forEach(it=>ib.appendChild(itemRow(it)));
    root.appendChild(catBlock({ key:"items", name:CATS.items.name, color:CATS.items.color, count:types.length+items.length, total:state.itemTypes.length+state.items.length,
      adds:[{tool:"item",tip:"Poser un item (I)"}], body:ib, empty:"" , forceBody:true }));

    const n=state.plants.length, nz=state.zones.length, nw=state.ponds.length+state.ditches.length, np=state.paths.length, ni=state.items.length;
    $("#elCount").textContent=[`${n} plante${n>1?"s":""}`,`${nz} zone${nz>1?"s":""}`,nw?`${nw} eau`:null,np?`${np} chemin${np>1?"s":""}`:null,ni?`${ni} item${ni>1?"s":""}`:null].filter(Boolean).join(" · ");
  }
  function libRow(t){
    const row=document.createElement("div"); row.className="lib-row"+(t.id===itemTypeSel&&tool==="item"?" on":"");
    const n=state.items.filter(i=>i.typeId===t.id).length;
    row.innerHTML=`<img class="thumb" src="/uploads/${esc(t.image)}" alt=""><div class="info"><div class="nm">${esc(t.name)}</div><div class="vr">${n?n+" sur le plan":"pas encore posé"}</div></div>`;
    const place=document.createElement("button"); place.type="button"; place.className="ib place"; place.title="Poser sur le plan"; place.setAttribute("aria-label","Poser sur le plan"); place.innerHTML=ICON("i-pin");
    place.onclick=()=>{ itemTypeSel=t.id; if(tool==="item"){ updateHint(); renderElements(); } else setTool("item"); };
    const ren=document.createElement("button"); ren.type="button"; ren.className="ib"; ren.title="Renommer"; ren.setAttribute("aria-label","Renommer"); ren.innerHTML=ICON("i-copy").replace("i-copy","i-path");
    ren.onclick=()=>renameItemType(t);
    const del=document.createElement("button"); del.type="button"; del.className="ib del"; del.title="Supprimer de la bibliothèque"; del.setAttribute("aria-label","Supprimer de la bibliothèque"); del.innerHTML=ICON("i-trash");
    del.onclick=()=>armConfirm(del, n?`Supprimer + ${n} sur le plan ?`:"Supprimer ?", ()=>deleteItemType(t));
    row.appendChild(place); row.appendChild(ren); row.appendChild(del);
    row.querySelector(".info").onclick=()=>place.onclick();
    row.querySelector(".info").style.cursor="pointer";
    return row;
  }
  function itemRow(it){
    const t=itemType(it.typeId);
    const row=document.createElement("div");
    row.className="row"+(sel.kind==="item"&&it.id===sel.id?" sel":"");
    row.innerHTML=`${t?`<img class="thumb" src="/uploads/${esc(t.image)}" alt="">`:`<span class="sw" style="background:${CATS.items.color}"></span>`}<div class="info"><div class="nm">${esc(itemName(it))}</div><div class="vr">${esc(t?t.name:"type supprimé")}</div></div>`;
    row.onclick=()=>selectItem(it.id);
    row.ondblclick=()=>centerOn(it.x,it.y,Math.min(maxScale(),60/(it.size||defaultItemSize())));
    row.title="Double-clic : centrer la carte sur l'item";
    return row;
  }
  $("#filter").addEventListener("input",e=>{ filterText=e.target.value.trim().toLowerCase(); $("#filterWrap").classList.toggle("has",!!filterText); renderElements(); });
  $("#filterClear").onclick=()=>{ $("#filter").value=""; filterText=""; $("#filterWrap").classList.remove("has"); renderElements(); $("#filter").focus(); };

  /* ==========================================================================
     Fiche (élément sélectionné)
     ========================================================================== */
  function openSheet(){ if(!prefs.sheet){ prefs.sheet=true; savePrefs(); applySheetPref(); } }
  function applySheetPref(){ $("#sheet").classList.toggle("collapsed",!prefs.sheet); }
  $("#sheetToggle").onclick=()=>{ prefs.sheet=!prefs.sheet; savePrefs(); applySheetPref(); };
  $("#sheetHead").addEventListener("dblclick",e=>{ if(e.target.closest("button")) return; $("#sheetToggle").click(); });

  function actionBtn(cls,icon,label,onClick){ const b=document.createElement("button"); b.className="btn sm "+cls; b.type="button"; b.innerHTML=ICON(icon)+label; b.onclick=onClick; return b; }
  function deleteBtn(label){ const b=actionBtn("del","i-trash",label,null); b.onclick=()=>armConfirm(b,"Confirmer ?",deleteSelected); return b; }
  // Fiche en lecture seule : les informations, sans champ de saisie
  function renderSheetRO(){
    const p=selPlant(), sh=selShape(), it=selItem();
    const ro=$("#sheetRO"), kind=$("#sheetKind"), title=$("#sheetTitle");
    $("#sheetEmpty").hidden=!!(p||sh||it); ro.hidden=!(p||sh||it);
    $("#sheetPlant").hidden=true; $("#sheetShape").hidden=true; $("#sheetItem").hidden=true; $("#sheetActions").hidden=true;
    const row=(label,val,cls)=>val?`<dt>${label}</dt><dd${cls?` class="${cls}"`:""}>${esc(val)}</dd>`:"";
    let html="";
    if(p){
      kind.hidden=false; kind.textContent="Plante"; kind.className="kind"; title.textContent=p.nom||"Plante sans nom";
      const type=p.type==="Autre"?p.typeAutre:p.type;
      html=row("Type",type)+row("Année de plantation",p.annee)+(isCal()?row("Diamètre",fmtNum((p.diam||defaultDiam())*state.scale.mPerPx,1)+" m","mono"):"")
          +row("Description",p.description)+row("Période de récolte",p.recolte)+row("Conservation",p.conservation);
    } else if(sh){
      const S=sh.S, z=sh.s;
      kind.hidden=false; kind.textContent=S.label; kind.className="kind"+(sh.kind==="zone"?" zone":" water"); title.textContent=z.cat||(S.label+" sans nom");
      if(isCal() && z.points && z.points.length>=2){
        if(S.closed){ const m=polyMetrics(z.points), mpp=state.scale.mPerPx, a=m.areaPx*mpp*mpp; html+=row("Surface", a>=10000?fmtNum(a/10000,2)+" ha ("+fmtNum(a,0)+" m²)":fmtNum(a,1)+" m²","mono")+row("Périmètre",fmtNum(m.perimPx*mpp,1)+" m","mono"); }
        else html+=row("Longueur",fmtDist(pathLength(z.points)),"mono")+(z.width?row("Largeur",fmtNum(z.width*state.scale.mPerPx,1)+" m","mono"):"");
      }
      if(sh.kind==="path" && PATH_TYPES[z.type]) html+=row("Type",PATH_TYPES[z.type].label);
      if(!html) html=`<dd style="color:var(--muted)">Aucune information complémentaire.</dd>`;
    } else if(it){
      const t=itemType(it.typeId);
      kind.hidden=false; kind.textContent="Item"; kind.className="kind item"; title.textContent=itemName(it);
      html=(t?`<div class="ro-img"><img src="/uploads/${esc(t.image)}" alt=""></div>`:"")+row("Type",t?t.name:"")+(isCal()?row("Largeur",fmtNum((it.size||defaultItemSize())*state.scale.mPerPx,1)+" m","mono"):"");
    } else { kind.hidden=true; title.textContent="Fiche"; }
    ro.innerHTML=html?`<dl>${html}</dl>`:"";
  }
  function renderSheet(){
    if(READONLY) return renderSheetRO();
    const p=selPlant(), sh=selShape(), it=selItem();
    $("#sheetEmpty").hidden=!!(p||sh||it); $("#sheetPlant").hidden=!p; $("#sheetShape").hidden=!sh; $("#sheetItem").hidden=!it;
    const kind=$("#sheetKind"), title=$("#sheetTitle"), acts=$("#sheetActions"); acts.innerHTML=""; acts.hidden=!(p||sh||it);
    if(it){
      kind.hidden=false; kind.textContent="Item"; kind.className="kind item";
      title.textContent=itemName(it);
      acts.appendChild(actionBtn("dup","i-copy","Dupliquer",duplicateSelected));
      acts.appendChild(deleteBtn("Retirer"));
      fillItemForm(it);
    } else if(p){
      kind.hidden=false; kind.textContent="Plante"; kind.className="kind";
      title.textContent=p.nom||"Plante sans nom";
      acts.appendChild(actionBtn("dup","i-copy","Dupliquer",duplicateSelected));
      acts.appendChild(deleteBtn("Supprimer"));
      fillPlantForm(p);
    } else if(sh){
      kind.hidden=false; kind.textContent=sh.S.label; kind.className="kind"+(sh.kind==="zone"?" zone":" water");
      title.textContent=sh.s.cat||(sh.S.label+" sans nom");
      acts.appendChild(deleteBtn("Supprimer"));
      fillShapeForm(sh.kind,sh.s);
    } else { kind.hidden=true; title.textContent="Fiche"; }
  }
  function toggleAutre(p){ $("#autreField").hidden=p.type!=="Autre"; }
  function fillPlantForm(p){
    FIELDS.forEach(f=>{ const el=$(`#sheetPlant [data-f="${f}"]`); if(el) el.value=p[f]||""; });
    toggleAutre(p);
    sizeControls("#sizeRange","#sizeNum","#sizeUnit","#sizeVal", p.diam||defaultDiam(), isCal()?[0.3,40]:[5,400], "Diamètre");
    colorPicker($("#colorPick"),"pcolor",p.color,(c,live)=>{
      p.color=c;
      if(live){ const m=world.querySelector('.marker[data-id="'+p.id+'"] .canopy'); if(m) m.innerHTML=iconSVG(p); return; } // aperçu pendant le choix
      renderMarkers(); renderElements(); scheduleSave();
    });
    const op=Math.round((p.opacity==null?1:p.opacity)*100);
    $("#pOpacity").value=op; $("#pOpacityVal").textContent="Opacité "+op+" %";
  }
  /* Taille / largeur : curseur + champ de valeur exacte, en mètres si l'échelle est définie, sinon en px image.
     px : valeur interne (px image) ; range [min,max] en unités d'affichage ; label : « Diamètre » / « Largeur ». */
  function toDisp(px){ return isCal() ? px*state.scale.mPerPx : px; }
  function fromDisp(v){ return isCal() ? v/state.scale.mPerPx : v; }
  function fmtDisp(v){ return isCal() ? (Math.round(v*10)/10).toString() : String(Math.round(v)); }
  function sizeText(label,px){ return isCal() ? label+" ≈ "+fmtNum(toDisp(px),1)+" m (réel)" : label+" ≈ "+Math.round(px)+" px sur l'image"; }
  function sizeControls(rangeSel,numSel,unitSel,valSel,px,range,label){
    const sr=$(rangeSel), num=$(numSel), v=toDisp(px);
    sr.min=String(range[0]); sr.max=String(range[1]); sr.step=isCal()?"0.1":"1"; sr.value=Math.max(range[0],Math.min(range[1],v));
    num.min=String(range[0]); num.step=isCal()?"0.1":"1"; num.value=fmtDisp(v);
    $(unitSel).textContent=isCal()?"m":"px"; $(valSel).textContent=sizeText(label,px);
  }
  // Applique une valeur saisie (unités d'affichage) ; source = "range" | "num" → l'autre contrôle est synchronisé
  function syncSize(rangeSel,numSel,valSel,label,v,source){
    const sr=$(rangeSel), num=$(numSel);
    if(source==="range") num.value=fmtDisp(v); else sr.value=Math.max(+sr.min,Math.min(+sr.max,v));
    $(valSel).textContent=sizeText(label,fromDisp(v));
    return fromDisp(v);
  }
  function widthLabel(w){ return sizeText("Largeur",w); }
  function fillItemForm(it){
    const t=itemType(it.typeId);
    $("#itemPreview").innerHTML=t?`<img src="/uploads/${esc(t.image)}" alt="">`:"";
    $("#iLabel").value=it.label||""; $("#iLabel").placeholder=t?t.name:"Nom";
    const sl=$("#iType"); sl.innerHTML=state.itemTypes.map(x=>`<option value="${esc(x.id)}" ${x.id===it.typeId?"selected":""}>${esc(x.name)}</option>`).join("");
    sizeControls("#iSize","#iSizeNum","#iSizeUnit","#iSizeVal", it.size||defaultItemSize(), isCal()?[0.2,30]:[5,400], "Largeur");
    const op=Math.round((it.opacity==null?1:it.opacity)*100);
    $("#iOpacity").value=op; $("#iOpacityVal").textContent="Opacité "+op+" %";
  }
  $("#iLabel").addEventListener("input",e=>{ const it=selItem(); if(!it) return; it.label=e.target.value; $("#sheetTitle").textContent=itemName(it); renderLabels(); renderElements(); scheduleSave(); });
  $("#iType").addEventListener("change",e=>{ const it=selItem(); if(!it) return; it.typeId=e.target.value; render(); scheduleSave(); });
  function applyItemSize(v,source){
    const it=selItem(); if(!it || !(v>0)) return;
    it.size=syncSize("#iSize","#iSizeNum","#iSizeVal","Largeur",v,source);
    const d=itemDims(it), m=world.querySelector('.marker[data-id="'+it.id+'"]'); if(m){ m.style.width=d.w+"px"; m.style.height=d.h+"px"; }
    renderLabels(); scheduleSave();
  }
  $("#iSize").addEventListener("input",e=>applyItemSize(+e.target.value,"range"));
  $("#iSizeNum").addEventListener("input",e=>applyItemSize(parseFloat(String(e.target.value).replace(",",".")),"num"));
  $("#iOpacity").addEventListener("input",e=>{
    const it=selItem(); if(!it) return;
    it.opacity=(+e.target.value)/100; $("#iOpacityVal").textContent="Opacité "+e.target.value+" %";
    const m=world.querySelector('.marker[data-id="'+it.id+'"]'); if(m) m.style.opacity=it.opacity;
    scheduleSave();
  });
  function fillShapeForm(kind,z){
    const S=SHAPES[kind];
    $("#sCatLabel").textContent=S.catLabel;
    const cat=$("#sCat"); cat.value=z.cat||""; cat.placeholder=S.catPh||""; if(S.catList) cat.setAttribute("list",S.catList); else cat.removeAttribute("list");
    $("#sOpacity").value=Math.round(z.opacity*100);
    $("#sOpacityVal").textContent="Opacité "+Math.round(z.opacity*100)+" %";
    // type (chemins) et largeur (formes ouvertes, en mètres si calibré)
    $("#sTypeField").hidden=kind!=="path";
    if(kind==="path") $("#sType").value=PATH_TYPES[z.type]?z.type:"pied";
    const wf=$("#sWidthField"); wf.hidden=S.closed;
    if(!S.closed) sizeControls("#sWidth","#sWidthNum","#sWidthUnit","#sWidthVal", z.width||defaultWidth(1), isCal()?[0.1,15]:[1,Math.max(20,Math.round(imgNatW*0.05))], "Largeur");
    // Données : surface / périmètre (polygones) ou longueur (polylignes), en unités réelles si l'échelle est définie
    const stats=$("#shapeStats");
    if(z.points && z.points.length>=2){
      if(!isCal()) stats.innerHTML=`<div class="note">Définissez l'échelle (outil Échelle, touche E) pour afficher les mesures réelles.</div>`;
      else if(S.closed){
        const m=polyMetrics(z.points), mpp=state.scale.mPerPx, aM2=m.areaPx*mpp*mpp, perM=m.perimPx*mpp;
        const aStr = aM2>=10000 ? fmtNum(aM2/10000,2)+" ha ("+fmtNum(aM2,0)+" m²)" : fmtNum(aM2,1)+" m²";
        stats.innerHTML=`<div class="stat"><span>Surface</span><b>${aStr}</b></div><div class="stat"><span>Périmètre</span><b>${fmtNum(perM,1)} m</b></div>`;
      } else stats.innerHTML=`<div class="stat"><span>Longueur</span><b>${fmtDist(pathLength(z.points))}</b></div>`;
    } else stats.innerHTML="";
    colorPicker($("#sColorPick"),"scolor",z.color,(c,live)=>{
      z.color=c;
      if(live){ shapeEls(z.id).forEach(el=>{ if(el.tagName==="polygon"){ el.setAttribute("fill",c); el.setAttribute("stroke",shade(c,-0.35)); } else if(el.classList.contains("shape-line")) el.setAttribute("stroke",c); }); return; }
      renderShapes(); renderElements(); scheduleSave();
    });
  }
  /* Palette : clic sur une pastille = appliquer ; crayon = modifier cette couleur de la palette (sélecteur de
     l'OS, aperçu en direct) ; « + » = ajouter une couleur. onPick(couleur, live) ; la palette est enregistrée
     dans le projet. Modifier une pastille ne recolore pas les autres éléments qui l'utilisaient. */
  function colorPicker(container,name,current,onPick){
    container.innerHTML="";
    const pal=palette();
    pal.forEach((c,i)=>{
      const sw=document.createElement("span"); sw.className="swatch"+(current===c?" on":""); sw.title=c;
      sw.innerHTML=`<label><input type="radio" name="${name}" ${current===c?"checked":""}><span class="sw" style="background:${c}"></span></label>`
                  +`<button type="button" class="edit" title="Modifier cette couleur" aria-label="Modifier cette couleur">${ICON("i-path")}</button><input type="color" class="cin" value="${c}" aria-hidden="true" tabindex="-1">`;
      const radio=sw.querySelector("input[type=radio]"), cin=sw.querySelector(".cin"), dot=sw.querySelector(".sw");
      radio.onchange=()=>{ container.querySelectorAll(".swatch").forEach(s=>s.classList.remove("on")); sw.classList.add("on"); onPick(c,false); };
      sw.querySelector(".edit").onclick=ev=>{ ev.stopPropagation(); cin.click(); };
      cin.addEventListener("input",()=>{ c=cin.value; pal[i]=c; dot.style.background=c; sw.title=c; radio.checked=true; onPick(c,true); });
      cin.addEventListener("change",()=>{ c=cin.value; pal[i]=c; state.palette=pal.slice(); colorPicker(container,name,c,onPick); onPick(c,false); scheduleSave(); });
      container.appendChild(sw);
    });
    const add=document.createElement("button"); add.type="button"; add.className="addc"; add.title="Ajouter une couleur"; add.setAttribute("aria-label","Ajouter une couleur"); add.textContent="+";
    const cadd=document.createElement("input"); cadd.type="color"; cadd.className="cin"; cadd.value=isHex(current)?current:"#4f7a3a"; cadd.setAttribute("aria-hidden","true"); cadd.tabIndex=-1;
    add.onclick=()=>cadd.click();
    cadd.addEventListener("input",()=>onPick(cadd.value,true));
    cadd.addEventListener("change",()=>{ const v=cadd.value; if(!pal.includes(v)) state.palette=pal.concat([v]); colorPicker(container,name,v,onPick); onPick(v,false); scheduleSave(); });
    const wrap=document.createElement("span"); wrap.className="swatch"; wrap.appendChild(add); wrap.appendChild(cadd);
    container.appendChild(wrap);
  }

  // Saisie en direct dans la fiche plante
  $("#sheetPlant").addEventListener("input",e=>{
    const f=e.target.getAttribute("data-f"); if(!f) return;
    const p=selPlant(); if(!p) return;
    if(f==="diam"||f==="diamNum"){
      const v=f==="diam" ? +e.target.value : parseFloat(String(e.target.value).replace(",","."));
      if(!(v>0)) return;
      p.diam=syncSize("#sizeRange","#sizeNum","#sizeVal","Diamètre",v,f==="diam"?"range":"num");
      renderMarkers(); renderLabels(); scheduleSave(); return;
    }
    if(f==="opacity"){
      p.opacity=(+e.target.value)/100; $("#pOpacityVal").textContent="Opacité "+e.target.value+" %";
      const m=world.querySelector('.marker[data-id="'+p.id+'"]'); if(m) m.style.opacity=p.opacity;
      scheduleSave(); return;
    }
    if(f==="annee"){ const y=e.target.value.replace(/\D/g,"").slice(0,4); if(y!==e.target.value) e.target.value=y; } // chiffres seulement
    p[f]=e.target.value;
    if(f==="type"){ toggleAutre(p); renderElements(); scheduleSave(); return; }
    if(f==="nom"){ $("#sheetTitle").textContent=p.nom||"Plante sans nom"; renderLabels(); }
    if(f==="nom"||f==="typeAutre") renderElements();
    scheduleSave();
  });
  // Saisie en direct dans la fiche forme
  $("#sCat").addEventListener("input",e=>{ const sh=selShape(); if(!sh) return; sh.s.cat=e.target.value; $("#sheetTitle").textContent=sh.s.cat||(sh.S.label+" sans nom"); renderElements(); renderLabels(); scheduleSave(); });
  $("#sOpacity").addEventListener("input",e=>{ const sh=selShape(); if(!sh) return; sh.s.opacity=(+e.target.value)/100; $("#sOpacityVal").textContent="Opacité "+e.target.value+" %"; renderShapes(); renderElements(); scheduleSave(); });
  function applyShapeWidth(v,source){
    const sh=selShape(); if(!sh || sh.S.closed || !(v>0)) return;
    sh.s.width=syncSize("#sWidth","#sWidthNum","#sWidthVal","Largeur",v,source);
    const line=zoneLayer.querySelector('.shape-line[data-id="'+sh.s.id+'"]'); if(line) line.setAttribute("stroke-width",sh.s.width);
    scheduleSave();
  }
  $("#sWidth").addEventListener("input",e=>applyShapeWidth(+e.target.value,"range"));
  $("#sWidthNum").addEventListener("input",e=>applyShapeWidth(parseFloat(String(e.target.value).replace(",",".")),"num"));
  // Changer le type d'un chemin applique ses préréglages (couleur, largeur, motif) ; on peut ensuite les ajuster
  $("#sType").addEventListener("change",e=>{
    const sh=selShape(); if(!sh || sh.kind!=="path") return;
    const t=PATH_TYPES[e.target.value]; if(!t) return;
    sh.s.type=e.target.value; sh.s.color=t.color; sh.s.width=defaultWidth(t.widthM); pathType=sh.s.type;
    render(); scheduleSave();
  });

  function duplicateSelected(){
    const p=selPlant(), it=selItem();
    const src=p||it; if(!src) return;
    const coll=p?state.plants:state.items;
    const dm=p?(p.diam||defaultDiam()):itemDims(it).w;
    // décalage d'environ 0,7 × taille vers le bas-droite, en % de l'image
    const offX=imgNatW?(dm/imgNatW*100)*0.7:2, offY=imgNatH?(dm/imgNatH*100)*0.7:2;
    const copy=Object.assign({},src);
    copy.id=newId(); copy.num=nextNumIn(coll);
    copy.x=Math.max(0,Math.min(100,src.x+offX)); copy.y=Math.max(0,Math.min(100,src.y+offY));
    coll.push(copy);
    if(p) selectPlant(copy.id); else selectItem(copy.id);
    scheduleSave();
  }

  /* ---------- Rendu global ---------- */
  function render(){ renderMarkers(); renderShapes(); renderLabels(); renderElements(); renderSheet(); }

  /* ---------- Panneau latéral ---------- */
  function applyPanelPref(){ document.body.classList.toggle("nopanel",!prefs.panel); $("#btnPanel").classList.toggle("on",!prefs.panel); }
  $("#btnPanel").onclick=()=>{ prefs.panel=!prefs.panel; savePrefs(); applyPanelPref(); if(hasImage()) applyTransform(); };

  /* ---------- Métadonnées ---------- */
  $("#clientName").oninput=e=>{ state.client=e.target.value; document.title="Permabondance — "+(state.client||"Plan de terrain"); scheduleSave(); };

  /* ==========================================================================
     Menu Fichier : export (fichier autonome, sauvegarde ou copie hors ligne)
     et import (remplace tout le contenu du plan).

     Le fichier .permab.json embarque l'image du terrain et les images d'items
     en base64 : il se suffit à lui-même. Seul le format de l'application
     actuelle (version 3) est accepté ; les fichiers de l'ancienne version
     autonome ne sont volontairement plus lus.
     ========================================================================== */
  const FILE_FORMAT="permabondance-plan", FILE_VERSION=3;

  async function toDataURL(url){
    const r=await fetch(url); if(!r.ok) throw new Error("Image introuvable : "+url);
    const b=await r.blob();
    return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=()=>rej(new Error("Lecture de l'image impossible")); fr.readAsDataURL(b); });
  }
  function dataURLtoBlob(u){ return fetch(u).then(r=>r.blob()); }
  function extOf(blob){ return { "image/png":"png", "image/jpeg":"jpg", "image/webp":"webp", "image/gif":"gif" }[blob.type]||"jpg"; }
  function stamp(d){ const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`; } // 2026-09-18_14h05
  function safeName(s){ return (String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^\w-]+/g,"_").replace(/^_+|_+$/g,""))||"plan"; }

  // Fichier autonome construit à partir de l'état courant de l'éditeur
  async function buildExport(){
    const itemTypes=await Promise.all(state.itemTypes.map(async t=>{
      const o=Object.assign({},t);
      o.imgData = t.image ? await toDataURL("/uploads/"+t.image).catch(()=>null) : null;
      return o;
    }));
    const data={
      format:FILE_FORMAT, version:FILE_VERSION, exportedAt:new Date().toISOString(),
      client:state.client||"",
      imgData: state.imageUrl ? await toDataURL(state.imageUrl) : null,
      plants:state.plants, zones:state.zones, ponds:state.ponds, ditches:state.ditches, paths:state.paths, items:state.items,
      itemTypes, scale:state.scale, palette:state.palette,
    };
    return { filename:safeName(state.client)+"_"+stamp(new Date())+".permab.json", blob:new Blob([JSON.stringify(data)],{type:"application/json"}) };
  }
  function download(blob,filename){
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),10000);
  }
  function parseFile(text){
    let d; try{ d=JSON.parse(text); }catch(_){ throw new Error("Ce fichier n'est pas un fichier de plan valide."); }
    if(!d || typeof d!=="object" || d.format!==FILE_FORMAT || !Array.isArray(d.plants)) throw new Error("Ce fichier ne contient pas un plan Permabondance.");
    if(!(+d.version>=FILE_VERSION)) throw new Error("Ce fichier a été exporté par une version antérieure de l'application : il n'est plus lisible.");
    return d;
  }
  // « 12 plantes · 3 zones · image incluse »
  function fileSummary(d){
    const n=a=>Array.isArray(a)?a.length:0, pl=(k,s)=>`${k} ${s}${k>1?"s":""}`;
    const parts=[pl(n(d.plants),"plante")];
    if(n(d.zones)) parts.push(pl(n(d.zones),"zone"));
    const w=n(d.ponds)+n(d.ditches); if(w) parts.push(`${w} eau`);
    if(n(d.paths)) parts.push(pl(n(d.paths),"chemin"));
    if(n(d.items)) parts.push(pl(n(d.items),"item"));
    parts.push(d.imgData?"image incluse":"sans image");
    return parts.join(" · ");
  }
  // Envoie le contenu du fichier dans ce projet (remplace tout). say(texte) : progression.
  async function importInto(d,say){
    if(d.imgData){
      say("Envoi de l'image du terrain…");
      const blob=await dataURLtoBlob(d.imgData);
      const fd=new FormData(); fd.append("image",blob,"plan."+extOf(blob));
      const r=await fetch("/api/projects/"+encodeURIComponent(PID)+"/image",{method:"POST",body:fd});
      if(!r.ok) throw new Error("Échec de l'envoi de l'image du terrain.");
    }
    const list=Array.isArray(d.itemTypes)?d.itemTypes:[];
    const types=[];
    for(let i=0;i<list.length;i++){
      const t=Object.assign({},list[i]);
      if(t.imgData){
        say(`Envoi des images d'items (${i+1}/${list.length})…`);
        const blob=await dataURLtoBlob(t.imgData);
        const fd=new FormData(); fd.append("image",blob,"item."+extOf(blob));
        const r=await fetch("/api/projects/"+encodeURIComponent(PID)+"/assets",{method:"POST",body:fd});
        t.image = r.ok ? (await r.json()).image_path : null;
      } else t.image=null; // une image du serveur d'origine n'est pas transférable : type ignoré
      delete t.imgData;
      if(t.image) types.push(t);
    }
    say("Enregistrement du plan…");
    const body={
      name:String(d.client||"").slice(0,200),
      plants:arr(d.plants), zones:arr(d.zones), ponds:arr(d.ponds), ditches:arr(d.ditches), paths:arr(d.paths),
      items:arr(d.items).filter(it=>types.some(t=>t.id===it.typeId)), item_types:types,
      scale:(d.scale && typeof d.scale==="object" && d.scale.mPerPx>0)?d.scale:null,
      palette:Array.isArray(d.palette)?d.palette.filter(isHex):null,
    };
    const r=await fetch(API,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!r.ok) throw new Error("Échec de l'enregistrement du plan.");
  }

  let pendingImport=null, importing=false, importProgress="", importError=null;
  async function exportProject(){
    flashStatus("Préparation du fichier…",8000);
    try{
      const { blob, filename }=await buildExport();
      download(blob,filename);
      flashStatus("Fichier exporté ✓",2500);
    }catch(err){ flashStatus("",0); alert("Export impossible : "+(err.message||err)); }
  }
  $("#fileProj").onchange=async e=>{
    const f=e.target.files[0]; e.target.value=""; if(!f) return;
    let data;
    try{ data=parseFile(await f.text()); }catch(err){ importError=err.message; setTool("import"); updateHint(); return; }
    pendingImport={ data, file:f }; importError=null;
    setTool("import"); updateHint();
  };
  async function runImport(){
    const d=pendingImport; if(!d || importing) return;
    importing=true; importProgress="lecture du fichier…"; updateHint();
    try{
      // les images d'items du plan remplacé ne servent plus
      for(const t of state.itemTypes){ const file=String(t.image||"").split("/").pop(); if(file) fetch("/api/projects/"+encodeURIComponent(PID)+"/assets/"+encodeURIComponent(file),{method:"DELETE"}).catch(()=>{}); }
      await importInto(d.data,msg=>{ importProgress=msg; updateHint(); });
      lastSavedParts=parts(); // rien à renvoyer : on recharge sur le nouvel état
      location.reload();
    }catch(err){ importing=false; importError=err.message||String(err); updateHint(); }
  }
  const fileMenu=$("#fileMenu"), btnFile=$("#btnFile");
  function toggleFile(on){ fileMenu.classList.toggle("on",on); btnFile.setAttribute("aria-expanded",on?"true":"false"); }
  btnFile.onclick=e=>{ e.stopPropagation(); toggleShare(false); toggleFile(!fileMenu.classList.contains("on")); };
  document.addEventListener("click",e=>{ if(!e.target.closest("#fileWrap")) toggleFile(false); });
  fileMenu.querySelectorAll("[data-file]").forEach(b=>b.onclick=()=>{ toggleFile(false); if(b.dataset.file==="export") exportProject(); else if(!READONLY) $("#fileProj").click(); });

  /* ==========================================================================
     Image du terrain
     ========================================================================== */
  // Écran « pas d'image » (normal, ou après un échec de chargement)
  function showEmpty(errorMsg){
    $("#imgLoading").hidden=true;
    $("#emptyTitle").textContent=errorMsg?"L'image du terrain n'a pas pu être chargée":"Commencez par une image du terrain";
    $("#emptyText").textContent=errorMsg||(READONLY?"Ce plan n'a pas encore d'image de terrain.":"Importez une photo satellite ou un plan. Vous pourrez ensuite définir l'échelle, poser les plantes et dessiner les zones.");
    $("#btnLoad2").textContent=errorMsg?"Importer une autre image":"Importer une image";
    $("#emptyState").hidden=false;
  }
  function showLoading(frac){
    $("#emptyState").hidden=true; $("#imgLoading").hidden=false;
    $("#imgLoadBar").style.width=(frac==null?0:Math.round(frac*100))+"%";
    $("#imgLoadPct").textContent=frac==null?"Connexion…":Math.round(frac*100)+" %";
  }
  // Téléchargement de l'image avec progression (fetch en flux), puis affichage
  let imgObjectUrl=null;
  async function loadImageData(url){
    showLoading(null);
    let blob;
    try{
      const r=await fetch(url,{cache:"force-cache"});
      if(!r.ok) throw new Error("HTTP "+r.status);
      const total=+r.headers.get("content-length")||0;
      if(r.body && total){
        const reader=r.body.getReader(), chunks=[]; let got=0;
        for(;;){ const {done,value}=await reader.read(); if(done) break; chunks.push(value); got+=value.length; showLoading(got/total); }
        blob=new Blob(chunks,{type:r.headers.get("content-type")||"image/jpeg"});
      } else blob=await r.blob();
    }catch(_){ showEmpty("Vérifiez la connexion, puis rechargez la page."); return; }
    img.onload=()=>{
      imgNatW=img.naturalWidth; imgNatH=img.naturalHeight;
      $("#emptyState").hidden=true; $("#imgLoading").hidden=true;
      $$(".rail .tool").forEach(b=>{ b.disabled=READONLY && !RO_TOOLS.includes(b.dataset.tool); });
      sizeLayers(); fit(); render(); updateScaleBar();
      if(pendingCalib){ pendingCalib=false; setTool("calib"); }
    };
    img.onerror=()=>showEmpty("Le fichier reçu n'est pas une image lisible.");
    if(imgObjectUrl) URL.revokeObjectURL(imgObjectUrl);
    imgObjectUrl=URL.createObjectURL(blob);
    img.src=imgObjectUrl; state.imageUrl=url; // imageUrl : adresse serveur (export, rechargement), pas l'URL blob
  }
  $("#fileImg").onchange=async e=>{
    const f=e.target.files[0]; e.target.value=""; if(!f) return;
    setSaveStatus("saving");
    const fd=new FormData(); fd.append("image",f);
    try{
      const r=await fetch("/api/projects/"+encodeURIComponent(PID)+"/image",{method:"POST",body:fd});
      if(!r.ok){ setSaveStatus("error"); alert("Échec de l'envoi de l'image."); return; }
      const d=await r.json();
      pendingCalib=true; // proposer la calibration d'échelle juste après le chargement
      loadImageData(d.image_url+(d.image_url.includes("?")?"":"?t="+Date.now()));
      setSaveStatus("saved");
    }catch(_){ setSaveStatus("error"); alert("Échec de l'envoi de l'image."); }
  };
  $("#btnLoad2").onclick=()=>$("#fileImg").click();

  /* ---------- Partage : lien d'édition (/p/<id>) ou de lecture seule (/v/<jeton>) ---------- */
  const shareMenu=$("#shareMenu"), btnShare=$("#btnShare");
  function toggleShare(on){ shareMenu.classList.toggle("on",on); btnShare.setAttribute("aria-expanded",on?"true":"false"); }
  btnShare.onclick=e=>{ e.stopPropagation(); toggleFile(false); toggleShare(!shareMenu.classList.contains("on")); };
  document.addEventListener("click",e=>{ if(!e.target.closest("#shareWrap")) toggleShare(false); });
  shareMenu.querySelectorAll("[data-share]").forEach(b=>b.onclick=async()=>{
    toggleShare(false);
    const view=b.dataset.share==="view";
    if(view && !state.viewToken){ alert("Lien de lecture seule indisponible pour ce projet."); return; }
    const url=location.origin+(view?"/v/"+encodeURIComponent(state.viewToken):"/p/"+encodeURIComponent(PID));
    const label=view?"Lien lecture copié ✓":"Lien édition copié ✓";
    try{ await navigator.clipboard.writeText(url); flashStatus(label,1800); }
    catch(_){ prompt(view?"Lien lecture :":"Lien édition :",url); }
  });

  /* ==========================================================================
     Démarrage
     ========================================================================== */
  const arr=v=>Array.isArray(v)?v:[];
  async function boot(){
    applySheetPref(); applyPanelPref(); applyVisibility();
    if(READONLY){
      document.body.classList.add("readonly");
      $("#clientName").hidden=true; $("#roMeta").hidden=false; $("#roBadge").hidden=false;
      $("#btnLoad2").hidden=true;
      $("#sheetEmpty").textContent="Cliquez une plante ou un élément sur le plan, ou dans la liste ci-dessus, pour lire sa fiche.";
    }
    if(!PID){ $("#bootLoader").textContent="Projet introuvable."; return; }
    let d;
    try{
      const r=await fetch(API);
      if(!r.ok){ $("#bootLoader").innerHTML=READONLY?"Ce lien n'est plus valide.":'Projet introuvable. <a href="/">Retour aux projets</a>'; return; }
      d=await r.json();
    }catch(_){ $("#bootLoader").textContent="Erreur de chargement."; return; }

    state.client=d.name||""; state.viewToken=d.view_token||null;
    if(READONLY) $("#roMeta").textContent=state.client||"Plan de terrain";
    state.plants=arr(d.plants); state.zones=arr(d.zones); state.ponds=arr(d.ponds); state.ditches=arr(d.ditches);
    state.paths=arr(d.paths); state.items=arr(d.items); state.itemTypes=arr(d.item_types);
    const migrated=state.plants.map(migratePlant).some(Boolean);
    state.scale=(d.scale && typeof d.scale==="object" && d.scale.mPerPx>0) ? d.scale : null;
    state.palette=Array.isArray(d.palette)&&d.palette.some(isHex) ? d.palette.filter(isHex) : null;
    // Réglages d'affichage du plan. Plan d'avant cette colonne : on reprend une dernière fois
    // ceux du navigateur, qui seront enregistrés en base au premier changement.
    const disp=(d.display && typeof d.display==="object" && !Array.isArray(d.display)) ? d.display : null;
    state.display={ hidden:Object.assign({}, disp ? (disp.hidden||{}) : prefs.hidden) };
    applyVisibility();
    state.imageUrl=d.image_path ? "/uploads/"+d.image_path : null;
    $("#clientName").value=state.client;
    document.title="Permabondance — "+(state.client||"Plan de terrain")+(READONLY?" (lecture seule)":"");

    if(state.imageUrl) loadImageData(state.imageUrl); else { showEmpty(); render(); }
    $("#bootLoader").style.display="none";
    loaded=true; lastSavedParts=parts(); setSaveStatus(READONLY?"":"saved");
    if(migrated){ delete lastSavedParts.plants; scheduleSave(); } // les fiches migrées côté client doivent être renvoyées
    updateHint();
  }
  boot();
})();
