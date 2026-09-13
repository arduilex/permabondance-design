/* ==========================================================================
   Permabondance — export / import de projet (fichier .permab.json autonome)
   Partagé par l'éditeur (exporter, remplacer le projet) et la liste admin
   (créer un projet depuis un fichier). Le fichier embarque l'image du terrain
   et les images d'items en base64 : il se suffit à lui-même (hors ligne,
   sauvegarde) et reste lisible par l'ancienne version autonome de l'éditeur.
   ========================================================================== */
(function(){
  "use strict";
  const FORMAT="permabondance-plan";

  async function toDataURL(url){
    const r=await fetch(url); if(!r.ok) throw new Error("Image introuvable : "+url);
    const b=await r.blob();
    return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=()=>rej(new Error("Lecture de l'image impossible")); fr.readAsDataURL(b); });
  }
  function dataURLtoBlob(u){ return fetch(u).then(r=>r.blob()); }
  function extOf(blob){ return { "image/png":"png", "image/jpeg":"jpg", "image/webp":"webp", "image/gif":"gif" }[blob.type]||"jpg"; }
  // 2026-09-13_14h05
  function stamp(d){ const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`; }
  function safeName(s){ return (String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^\w-]+/g,"_").replace(/^_+|_+$/g,""))||"plan"; }

  // Fiche v2 : « variete » → 1re ligne de « description », « libre » → fin (fichiers de l'ancienne version)
  function migratePlant(p){
    if(!p || typeof p!=="object" || (!("variete" in p) && !("libre" in p))) return p;
    const v=String(p.variete||"").trim(), d=String(p.description||"").trim(), l=String(p.libre||"").trim();
    const head=[v,d].filter(Boolean).join("\n");
    const out=Object.assign({},p,{ description:[head,l].filter(Boolean).join("\n\n") });
    delete out.variete; delete out.libre;
    return out;
  }

  /* Construit le fichier à partir de l'état de l'éditeur
     state : { client, planDate, imageUrl, plants, zones, ponds, ditches, paths, items, itemTypes, scale, palette } */
  async function buildExport(state){
    const itemTypes=await Promise.all((state.itemTypes||[]).map(async t=>{
      const o=Object.assign({},t);
      o.imgData = t.image ? await toDataURL("/uploads/"+t.image).catch(()=>null) : null;
      return o;
    }));
    const data={
      format:FORMAT, version:2, exportedAt:new Date().toISOString(),
      client:state.client||"", planDate:state.planDate||"",
      imgData: state.imageUrl ? await toDataURL(state.imageUrl) : null,
      plants:state.plants||[], zones:state.zones||[], ponds:state.ponds||[], ditches:state.ditches||[], paths:state.paths||[], items:state.items||[],
      itemTypes, scale:state.scale||null, palette:state.palette||null,
    };
    const filename=safeName(state.client)+"_"+stamp(new Date())+".permab.json";
    return { data, filename, blob:new Blob([JSON.stringify(data)],{type:"application/json"}) };
  }
  function download(blob,filename){
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),10000);
  }

  function parseFile(text){
    let d; try{ d=JSON.parse(text); }catch(_){ throw new Error("Ce fichier n'est pas un fichier de projet valide."); }
    if(!d || typeof d!=="object" || !Array.isArray(d.plants)) throw new Error("Ce fichier ne contient pas de projet Permabondance.");
    return d;
  }
  function summary(d){
    const n=a=>Array.isArray(a)?a.length:0, pl=(k,s)=>`${k} ${s}${k>1?"s":""}`;
    const parts=[pl(n(d.plants),"plante")];
    if(n(d.zones)) parts.push(pl(n(d.zones),"zone"));
    const w=n(d.ponds)+n(d.ditches); if(w) parts.push(`${w} eau`);
    if(n(d.paths)) parts.push(pl(n(d.paths),"chemin"));
    if(n(d.items)) parts.push(pl(n(d.items),"item"));
    parts.push(d.imgData?"image incluse":"sans image");
    return parts.join(" · ");
  }

  /* Envoie le contenu du fichier dans le projet pid (remplace tout). onProgress(texte) facultatif. */
  async function importInto(pid,d,onProgress){
    const api="/api/projects/"+encodeURIComponent(pid), say=t=>{ if(onProgress) onProgress(t); };
    if(d.imgData){
      say("Envoi de l'image du terrain…");
      const blob=await dataURLtoBlob(d.imgData);
      const fd=new FormData(); fd.append("image",blob,"plan."+extOf(blob));
      const r=await fetch(api+"/image",{method:"POST",body:fd});
      if(!r.ok) throw new Error("Échec de l'envoi de l'image du terrain.");
    }
    const list=Array.isArray(d.itemTypes)?d.itemTypes:(Array.isArray(d.item_types)?d.item_types:[]);
    const types=[];
    for(let i=0;i<list.length;i++){
      const t=Object.assign({},list[i]);
      if(t.imgData){
        say(`Envoi des images d'items (${i+1}/${list.length})…`);
        const blob=await dataURLtoBlob(t.imgData);
        const fd=new FormData(); fd.append("image",blob,"item."+extOf(blob));
        const r=await fetch(api+"/assets",{method:"POST",body:fd});
        t.image = r.ok ? (await r.json()).image_path : null;
      } else t.image=null; // une image du serveur d'origine n'est pas transférable : type ignoré
      delete t.imgData;
      if(t.image) types.push(t);
    }
    say("Enregistrement du projet…");
    const body={
      name:String(d.client||d.name||"").slice(0,200),
      plants:(d.plants||[]).map(migratePlant), zones:d.zones||[], ponds:d.ponds||[], ditches:d.ditches||[], paths:d.paths||[],
      items:(d.items||[]).filter(it=>types.some(t=>t.id===it.typeId)), item_types:types,
      scale:(d.scale && typeof d.scale==="object" && d.scale.mPerPx>0)?d.scale:null,
      palette:Array.isArray(d.palette)?d.palette:null,
    };
    const r=await fetch(api,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!r.ok) throw new Error("Échec de l'enregistrement du projet.");
    return body;
  }

  window.PermabIO={ buildExport, download, parseFile, summary, importInto };
})();
