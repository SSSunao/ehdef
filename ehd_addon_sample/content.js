// background.js (service worker module)
// Queue per gallery; images downloaded via chrome.downloads.download
// Supports: ADD_TO_QUEUE (gallery: {title,galleryId,images,meta})
// STOP_GALLERY, STOP_ALL, GET_QUEUE, GET_SETTINGS, SAVE_SETTINGS, GET_HISTORY, EXPORT_HISTORY
// Sends messages: QUEUE_UPDATED, DOWNLOAD_STATUS, DOWNLOAD_PROGRESS, DOWNLOAD_FINISHED, DOWNLOAD_ERROR

const DEFAULT_SETTINGS = {
  sleepMsBetweenStarts: 800,
  concurrentImages: 2,
  retryCount: 5,
  filenameTemplate: "{gallery_title}/{index}_{orig_name}",
  createPerGalleryFolder: true,
  theme: "light",
  lang: "ja"
};

let settings = Object.assign({}, DEFAULT_SETTINGS);
let queue = []; // FIFO: {title,galleryId,images,meta}
let processing = false;
const activeGalleryState = new Map(); // gid -> {abortRequested:bool}
const activeDownloadIds = new Map(); // gid -> [downloadId]
const downloadIdToGallery = new Map();

const DB_NAME = "ehdl_db_v1";
const STORE_COMPLETED = "completed";
const STORE_RESUME = "resume";

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_COMPLETED)) db.createObjectStore(STORE_COMPLETED, { keyPath: "galleryId" });
      if (!db.objectStoreNames.contains(STORE_RESUME)) db.createObjectStore(STORE_RESUME, { keyPath: "galleryId" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbPut(store,obj){ const db=await openDB(); return new Promise((r,rej)=>{ const tx=db.transaction(store,"readwrite"); const s=tx.objectStore(store); const q=s.put(obj); q.onsuccess=()=>r(q.result); q.onerror=()=>rej(q.error);});}
async function dbGetAll(store){ const db=await openDB(); return new Promise((r,rej)=>{ const tx=db.transaction(store,"readonly"); const s=tx.objectStore(store); const q=s.getAll(); q.onsuccess=()=>r(q.result||[]); q.onerror=()=>rej(q.error); });}
async function dbDel(store,key){ const db=await openDB(); return new Promise((r,rej)=>{ const tx=db.transaction(store,"readwrite"); const s=tx.objectStore(store); const q=s.delete(key); q.onsuccess=()=>r(); q.onerror=()=>rej(q.error);});}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function sanitize(s){ return String(s||"").replace(/[\\/:*?"<>|]+/g,"_").trim().slice(0,200); }
function buildFilename(template,meta){
  let t = template || DEFAULT_SETTINGS.filenameTemplate;
  t = t.replace(/\{gallery_title\}/g,sanitize(meta.gallery_title||"gallery"));
  t = t.replace(/\{gallery_id\}/g, meta.galleryId||"");
  t = t.replace(/\{index\}/g, String(meta.index||0).padStart(3,"0"));
  t = t.replace(/\{orig_name\}/g,sanitize(meta.orig_name||"img"));
  t = t.replace(/\{total\}/g, String(meta.total||""));
  if(settings.createPerGalleryFolder){
    const f = sanitize(meta.gallery_title||"gallery");
    if(!t.startsWith(f+"/")) t = f + "/" + t;
  }
  if(!/\.[a-z0-9]{2,6}$/i.test(t)) t += ".jpg";
  return t;
}

function recordDownload(gid,id){ if(!activeDownloadIds.has(gid)) activeDownloadIds.set(gid,[]); activeDownloadIds.get(gid).push(id); downloadIdToGallery.set(id,gid); }
function removeDownloadId(id){ const gid = downloadIdToGallery.get(id); if(!gid) return; const arr = activeDownloadIds.get(gid)||[]; const i = arr.indexOf(id); if(i>=0) arr.splice(i,1); if(arr.length===0) activeDownloadIds.delete(gid); downloadIdToGallery.delete(id); }
async function cancelGalleryDownloads(gid){ const arr=(activeDownloadIds.get(gid)||[]).slice(); for(const id of arr){ try{ await new Promise(r=>chrome.downloads.cancel(id,()=>r())); }catch(e){} downloadIdToGallery.delete(id); } activeDownloadIds.delete(gid); }

chrome.downloads.onChanged.addListener(delta=>{
  try{
    if(!delta||!delta.id) return;
    if(delta.state && delta.state.current==="complete"){ removeDownloadId(delta.id); }
    if(delta.state && delta.state.current==="interrupted"){ const gid = downloadIdToGallery.get(delta.id); removeDownloadId(delta.id); if(gid) chrome.runtime.sendMessage({type:"DOWNLOAD_ERROR",galleryId:gid,message:"interrupted"}); }
  }catch(e){ console.error(e); }
});

async function processQueue(){
  if(processing) return;
  processing = true;
  try{
    while(queue.length>0){
      const item = queue.shift();
      if(!item) continue;
      const gid = String(item.galleryId);
      const title = item.title || gid;
      const images = Array.isArray(item.images)?item.images.filter(Boolean):[];
      const total = images.length;
      chrome.runtime.sendMessage({type:"DOWNLOAD_STATUS",galleryId:gid,status:"preparing",title});
      activeGalleryState.set(gid,{abortRequested:false});
      const concurrency = Math.max(1, Number(settings.concurrentImages||1));
      let idx = 0;
      const workers = Array.from({length:concurrency}, async ()=>{
        while(true){
          const st = activeGalleryState.get(gid);
          if(!st || st.abortRequested) break;
          const cur = idx++;
          if(cur >= images.length) break;
          const url = images[cur];
          chrome.runtime.sendMessage({type:"DOWNLOAD_STATUS",galleryId:gid,status:"downloading",index:cur+1,total,title});
          const meta = {gallery_title:title,galleryId:gid,index:cur+1,orig_name:(url.split("/").pop().split("?")[0]||`img${cur+1}`),total};
          const filename = buildFilename(settings.filenameTemplate,meta);
          let success = false;
          let attempt = 0;
          while(attempt < (Number(settings.retryCount)||5) && !success){
            attempt++;
            try{
              const id = await new Promise((resolve,reject)=>{
                chrome.downloads.download({url,filename,conflictAction:"uniquify"}, id=>{
                  if(chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                  resolve(id);
                });
              });
              recordDownload(gid,id);
              success = true;
              chrome.runtime.sendMessage({type:"DOWNLOAD_PROGRESS",galleryId:gid,current:cur+1,total});
            }catch(e){
              console.warn("image download attempt failed",attempt,e);
              if(attempt >= (Number(settings.retryCount)||5)){
                await dbPut(STORE_RESUME,{galleryId:gid,last_error:true,last_error_msg:String(e),ts:Date.now()}).catch(()=>{});
                chrome.runtime.sendMessage({type:"DOWNLOAD_ERROR",galleryId:gid,message:String(e)});
                // abort gallery on fatal image error
                const st2 = activeGalleryState.get(gid); if(st2) st2.abortRequested = true;
                break;
              } else {
                // sleep between retries (use sleepMsBetweenStarts)
                await sleep(Number(settings.sleepMsBetweenStarts||800));
              }
            }
          } // end retries
          // small pause between starting next
          await sleep(Number(settings.sleepMsBetweenStarts||800));
        } // end while worker
      });
      await Promise.all(workers);
      // if aborted, cancel remaining downloads and do not add to completed
      const fstate = activeGalleryState.get(gid);
      if(fstate && fstate.abortRequested){
        await cancelGalleryDownloads(gid);
        activeGalleryState.delete(gid);
        chrome.runtime.sendMessage({type:"DOWNLOAD_ERROR",galleryId:gid,message:"stopped"});
        continue;
      }
      // wait until all download ids for gid complete or timeout
      const waitStart = Date.now();
      const timeout = 1000*60*10;
      while(true){
        const arr = activeDownloadIds.get(gid) || [];
        if(arr.length === 0) break;
        if(Date.now() - waitStart > timeout){ console.warn("wait timeout",gid); break; }
        await sleep(500);
      }
      // mark completed
      await dbPut(STORE_COMPLETED,{galleryId:gid,ts:Date.now(),meta:{title,total}}).catch(()=>{});
      await dbDel(STORE_RESUME,gid).catch(()=>{});
      activeGalleryState.delete(gid);
      chrome.runtime.sendMessage({type:"DOWNLOAD_FINISHED",galleryId:gid});
    }
  }catch(e){ console.error("processQueue error",e); }
  finally{ processing=false; chrome.runtime.sendMessage({type:"QUEUE_UPDATED",queue:queue.map(q=>({title:q.title,galleryId:q.galleryId}))}); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async ()=>{
    try{
      if(!msg || !msg.type){ sendResponse({ok:false}); return; }
      switch(msg.type){
        case "ADD_TO_QUEUE": {
          const g = msg.gallery;
          if(!g || !g.galleryId || !Array.isArray(g.images) || g.images.length===0){ sendResponse({ok:false,reason:"invalid"}); return; }
          queue.push({title:g.title||`gallery_${g.galleryId}`,galleryId:String(g.galleryId),images:g.images,meta:g.meta||null});
          chrome.runtime.sendMessage({type:"QUEUE_UPDATED",queue:queue.map(q=>({title:q.title,galleryId:q.galleryId}))});
          processQueue().catch(e=>console.error(e));
          sendResponse({ok:true});
          return;
        }
        case "STOP_GALLERY": {
          const gid = String(msg.galleryId);
          queue = queue.filter(q=>q.galleryId !== gid);
          const st = activeGalleryState.get(gid);
          if(st) st.abortRequested = true;
          await cancelGalleryDownloads(gid);
          chrome.runtime.sendMessage({type:"QUEUE_UPDATED",queue:queue.map(q=>({title:q.title,galleryId:q.galleryId}))});
          sendResponse({ok:true});
          return;
        }
        case "STOP_ALL": {
          queue = [];
          for(const gid of Array.from(activeDownloadIds.keys())){
            const st = activeGalleryState.get(gid); if(st) st.abortRequested = true;
            await cancelGalleryDownloads(gid);
          }
          chrome.runtime.sendMessage({type:"QUEUE_UPDATED",queue:[]});
          sendResponse({ok:true});
          return;
        }
        case "GET_QUEUE": sendResponse({queue:queue.map(q=>({title:q.title,galleryId:q.galleryId}))}); return;
        case "GET_SETTINGS": sendResponse({settings}); return;
        case "SAVE_SETTINGS": settings = Object.assign({}, DEFAULT_SETTINGS, msg.settings||{}); await chrome.storage.local.set({settings}); sendResponse({ok:true}); return;
        case "GET_HISTORY": { const all = await dbGetAll(STORE_COMPLETED).catch(()=>[]); sendResponse({history:all}); return; }
        case "EXPORT_HISTORY": { const comp = await dbGetAll(STORE_COMPLETED).catch(()=>[]); const blob = new Blob([JSON.stringify({ts:Date.now(),completed:comp},null,2)],{type:"application/json"}); const url = URL.createObjectURL(blob); const filename = `ehdl-history-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; chrome.downloads.download({url,filename}, id => setTimeout(()=>URL.revokeObjectURL(url),15000)); sendResponse({ok:true}); return; }
        default: sendResponse({ok:false,reason:"unknown"}); return;
      }
    }catch(e){ console.error("bg msg err",e); sendResponse({ok:false,error:String(e)}); }
  })();
  return true;
});

chrome.storage.local.get(["settings"], res => { if(res && res.settings) settings = Object.assign({},DEFAULT_SETTINGS,res.settings); processQueue().catch(e=>console.error(e)); });
