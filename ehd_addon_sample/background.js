// background.js (updated - full file)
// Implements: queue, per-image retry/backoff, STOP with resume recording, unique folder naming using completed-store history,
// richer messaging for content-script UI updates.

const DEFAULT_SETTINGS = {
  sleepMsBetweenStarts: 800,
  concurrentImages: 2,
  retryCount: 5,
  retryDelayMs: 1500,
  filenameTemplate: "{gallery_title}/{index}_{orig_name}",
  createPerGalleryFolder: true,
  theme: "light",
  lang: "ja"
};

let settings = Object.assign({}, DEFAULT_SETTINGS);
let queue = [];
let processing = false;

const activeGalleryState = new Map();
const activeDownloadIds = new Map();
const downloadIdToGallery = new Map();

const DB_NAME = "ehdl_db_v1";
const DB_VER = 1;
const STORE_COMPLETED = "completed";
const STORE_RESUME = "resume";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitize(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 200); }

function msgTypeKey(type) { return String(type || "").toUpperCase(); }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_COMPLETED)) db.createObjectStore(STORE_COMPLETED, { keyPath: "galleryId" });
      if (!db.objectStoreNames.contains(STORE_RESUME)) db.createObjectStore(STORE_RESUME, { keyPath: "galleryId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, obj) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.put(obj);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const r = s.getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const r = s.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbDel(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function dbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

// Build filename - uses unique folder naming by checking completed store
async function ensureUniqueFolder(baseFolder) {
  // Count how many completed entries used this baseFolder name (exact match or starting with baseFolder)
  try {
    const all = await dbGetAll(STORE_COMPLETED);
    const same = all.filter(r => {
      if (!r || !r.meta || !r.meta.title) return false;
      const used = String(r.meta.title);
      return used === baseFolder || used.startsWith(baseFolder + " (");
    });
    if (same.length === 0) return baseFolder;
    // generate suffix (n)
    const n = same.length + 1;
    return `${baseFolder} (${n})`;
  } catch (e) {
    return baseFolder;
  }
}

async function buildFilenameAsync(template, meta) {
  let t = template || DEFAULT_SETTINGS.filenameTemplate;
  t = t.replace(/\{gallery_title\}/g, sanitize(meta.gallery_title || "gallery"));
  t = t.replace(/\{gallery_id\}/g, meta.galleryId || "");
  t = t.replace(/\{index\}/g, String(meta.index || 0).padStart(3, "0"));
  t = t.replace(/\{orig_name\}/g, sanitize(meta.orig_name || "img"));
  t = t.replace(/\{total\}/g, String(meta.total || ""));
  if (settings.createPerGalleryFolder) {
    const folderBase = sanitize(meta.gallery_title || "gallery");
    const folderName = await ensureUniqueFolder(folderBase);
    if (!t.startsWith(folderName + "/")) t = folderName + "/" + t;
  }
  if (!/\.[a-z0-9]{2,6}$/i.test(t)) t += ".jpg";
  return t;
}

function recordDownload(gid, id) {
  if (!activeDownloadIds.has(gid)) activeDownloadIds.set(gid, []);
  activeDownloadIds.get(gid).push(id);
  downloadIdToGallery.set(id, gid);
}
function removeDownloadId(id) {
  const gid = downloadIdToGallery.get(id);
  if (!gid) return;
  const arr = activeDownloadIds.get(gid) || [];
  const idx = arr.indexOf(id);
  if (idx >= 0) arr.splice(idx, 1);
  if (arr.length === 0) activeDownloadIds.delete(gid);
  downloadIdToGallery.delete(id);
}
async function cancelGalleryDownloads(gid) {
  const arr = (activeDownloadIds.get(gid) || []).slice();
  for (const id of arr) {
    try {
      await new Promise(r => chrome.downloads.cancel(id, () => r()));
    } catch (e) { /* ignore */ }
    downloadIdToGallery.delete(id);
  }
  activeDownloadIds.delete(gid);
}

chrome.downloads.onChanged.addListener(delta => {
  try {
    if (!delta || !delta.id) return;
    if (delta.state && delta.state.current === "complete") {
      removeDownloadId(delta.id);
    }
    if (delta.state && delta.state.current === "interrupted") {
      const gid = downloadIdToGallery.get(delta.id);
      removeDownloadId(delta.id);
      if (gid) chrome.runtime.sendMessage({ type: "DOWNLOAD_ERROR", galleryId: gid, message: "interrupted" });
    }
  } catch (e) {
    console.error("downloads.onChanged error", e);
  }
});

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      const gid = String(item.galleryId);
      const title = item.title || `gallery_${gid}`;
      const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
      const total = images.length;

      chrome.runtime.sendMessage({ type: "DOWNLOAD_STATUS", galleryId: gid, status: "preparing", title });

      activeGalleryState.set(gid, { abortRequested: false, startedAt: Date.now() });

      const concurrency = Math.max(1, Number(settings.concurrentImages || 1));
      let idx = 0;

      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          const st = activeGalleryState.get(gid);
          if (!st || st.abortRequested) break;
          const cur = idx++;
          if (cur >= images.length) break;
          const url = images[cur];
          if (!url) continue;
          chrome.runtime.sendMessage({ type: "DOWNLOAD_STATUS", galleryId: gid, status: "downloading", index: cur + 1, total, title });

          const meta = {
            gallery_title: title,
            galleryId: gid,
            index: cur + 1,
            orig_name: (url.split("/").pop().split("?")[0] || `img${cur+1}`),
            total
          };
          // build filename asynchronously (ensures unique folder name)
          let filename;
          try {
            filename = await buildFilenameAsync(settings.filenameTemplate, meta);
          } catch (e) {
            filename = `${sanitize(title)}/${String(meta.index).padStart(3,"0")}_${meta.orig_name}.jpg`;
          }

          let attempt = 0;
          let ok = false;
          const maxRetry = Number(settings.retryCount || DEFAULT_SETTINGS.retryCount);
          while (attempt < maxRetry && !ok) {
            attempt++;
            try {
              const downloadId = await new Promise((resolve, reject) => {
                chrome.downloads.download({ url, filename, conflictAction: "uniquify" }, id => {
                  if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                  resolve(id);
                });
              });
              recordDownload(gid, downloadId);
              ok = true;
              chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", galleryId: gid, current: cur + 1, total });
            } catch (e) {
              console.warn("download attempt failed", attempt, e);
              if (attempt >= maxRetry) {
                await dbPut(STORE_RESUME, { galleryId: gid, last_error: true, last_error_msg: String(e), ts: Date.now(), failedIndex: cur + 1 }).catch(()=>{});
                chrome.runtime.sendMessage({ type: "DOWNLOAD_ERROR", galleryId: gid, message: String(e) });
                const st2 = activeGalleryState.get(gid); if (st2) st2.abortRequested = true;
                break;
              } else {
                await sleep(Number(settings.retryDelayMs || DEFAULT_SETTINGS.retryDelayMs));
              }
            }
          }
          await sleep(Number(settings.sleepMsBetweenStarts || DEFAULT_SETTINGS.sleepMsBetweenStarts));
        }
      });

      await Promise.all(workers);

      const final = activeGalleryState.get(gid);
      if (final && final.abortRequested) {
        // record resume entry if not already recorded
        await dbPut(STORE_RESUME, { galleryId: gid, stopped: true, ts: Date.now() }).catch(()=>{});
        await cancelGalleryDownloads(gid);
        activeGalleryState.delete(gid);
        chrome.runtime.sendMessage({ type: "DOWNLOAD_ERROR", galleryId: gid, message: "stopped" });
        continue;
      }

      // wait for all downloads to finish
      const waitStart = Date.now();
      const waitTimeout = 1000 * 60 * 10;
      while (true) {
        const arr = activeDownloadIds.get(gid) || [];
        if (arr.length === 0) break;
        if (Date.now() - waitStart > waitTimeout) { console.warn("wait timeout", gid); break; }
        await sleep(500);
      }

      // completed
      try {
        await dbPut(STORE_COMPLETED, { galleryId: gid, ts: Date.now(), meta: { title, total } });
        await dbDel(STORE_RESUME, gid).catch(()=>{});
      } catch (e) {
        console.warn("db put completed fail", e);
      }

      activeGalleryState.delete(gid);
      chrome.runtime.sendMessage({ type: "DOWNLOAD_FINISHED", galleryId: gid });
    }
  } catch (e) {
    console.error("processQueue error", e);
  } finally {
    processing = false;
    chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) { sendResponse && sendResponse({ ok: false }); return; }
      const t = msgTypeKey(msg.type);

      // ADD_TO_QUEUE synonyms
      if (t === "ADD_TO_QUEUE" || t === "ADDTOQUEUE" || t === "ADD") {
        const g = msg.gallery || msg.galleryObj || msg.galleryData;
        if (!g || !g.galleryId || !Array.isArray(g.images) || g.images.length === 0) { sendResponse && sendResponse({ ok: false, reason: "invalid_gallery" }); return; }
        queue.push({ title: g.title || `gallery_${g.galleryId}`, galleryId: String(g.galleryId), images: g.images, meta: g.meta || null });
        chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
        processQueue().catch(e => console.error(e));
        sendResponse && sendResponse({ ok: true });
        return;
      }

      if (t === "STOP_GALLERY" || t === "STOPGALLERY" || t === "STOP") {
        const gid = String(msg.galleryId || msg.gallery_id || msg.gallery || "");
        if (!gid) { sendResponse && sendResponse({ ok: false, reason: "no_gid" }); return; }
        queue = queue.filter(x => x.galleryId !== gid);
        const st = activeGalleryState.get(gid);
        if (st) st.abortRequested = true;
        // record resume entry
        await dbPut(STORE_RESUME, { galleryId: gid, stopped: true, ts: Date.now() }).catch(()=>{});
        await cancelGalleryDownloads(gid);
        chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
        sendResponse && sendResponse({ ok: true });
        return;
      }

      if (t === "STOP_ALL" || t === "STOPALL") {
        queue = [];
        for (const gid of Array.from(activeDownloadIds.keys())) {
          const st = activeGalleryState.get(gid);
          if (st) st.abortRequested = true;
          await cancelGalleryDownloads(gid);
          await dbPut(STORE_RESUME, { galleryId: gid, stopped: true, ts: Date.now() }).catch(()=>{});
        }
        chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: [] });
        sendResponse && sendResponse({ ok: true });
        return;
      }

      if (t === "GET_QUEUE" || t === "GETQUEUE") {
        sendResponse && sendResponse({ queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
        return;
      }

      if (t === "GET_SETTINGS" || t === "GETSETTINGS") {
        sendResponse && sendResponse({ settings });
        return;
      }

      if (t === "SAVE_SETTINGS" || t === "SAVESETTINGS") {
        settings = Object.assign({}, DEFAULT_SETTINGS, msg.settings || msg.payload || {});
        await chrome.storage.local.set({ settings });
        sendResponse && sendResponse({ ok: true });
        return;
      }

      if (t === "GET_HISTORY" || t === "GETHISTORY") {
        const all = await dbGetAll(STORE_COMPLETED).catch(() => []);
        sendResponse && sendResponse({ history: all });
        return;
      }

      if (t === "GET_RESUME" || t === "GETRESUME") {
        const all = await dbGetAll(STORE_RESUME).catch(() => []);
        sendResponse && sendResponse({ resume: all });
        return;
      }

      if (t === "EXPORT_HISTORY" || t === "EXPORTHISTORY") {
        const comp = await dbGetAll(STORE_COMPLETED).catch(() => []);
        const blob = new Blob([JSON.stringify({ ts: Date.now(), completed: comp }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const filename = `ehdl-history-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        chrome.downloads.download({ url, filename }, id => { setTimeout(() => URL.revokeObjectURL(url), 15000); });
        sendResponse && sendResponse({ ok: true });
        return;
      }

      if (t === "CLEAR_HISTORY" || t === "CLEARHISTORY") {
        await dbClear(STORE_COMPLETED).catch(() => { });
        chrome.runtime.sendMessage({ type: "HISTORY_CLEARED" });
        sendResponse && sendResponse({ ok: true });
        return;
      }

      // lowercase synonyms used by popup.js
      if (String(msg.type).toLowerCase() === "getqueue") { sendResponse && sendResponse({ queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) }); return; }
      if (String(msg.type).toLowerCase() === "gethistory") { const all = await dbGetAll(STORE_COMPLETED).catch(() => []); sendResponse && sendResponse({ history: all }); return; }
      if (String(msg.type).toLowerCase() === "exporthistory") { const comp = await dbGetAll(STORE_COMPLETED).catch(() => []); const blob = new Blob([JSON.stringify({ ts: Date.now(), completed: comp }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const filename = `ehdl-history-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; chrome.downloads.download({ url, filename }, id => { setTimeout(() => URL.revokeObjectURL(url), 15000); }); sendResponse && sendResponse({ ok: true }); return; }
      if (String(msg.type).toLowerCase() === "clearhistory") { await dbClear(STORE_COMPLETED).catch(() => { }); chrome.runtime.sendMessage({ type: "HISTORY_CLEARED" }); sendResponse && sendResponse({ ok: true }); return; }
      if (String(msg.type).toLowerCase() === "stopgallery") {
        const gid = String(msg.gallery_id || msg.galleryId || msg.gallery || "");
        if (!gid) { sendResponse && sendResponse({ ok: false, reason: "no_gid" }); return; }
        queue = queue.filter(x => x.galleryId !== gid);
        const st = activeGalleryState.get(gid);
        if (st) st.abortRequested = true;
        await dbPut(STORE_RESUME, { galleryId: gid, stopped: true, ts: Date.now() }).catch(()=>{});
        await cancelGalleryDownloads(gid);
        chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
        sendResponse && sendResponse({ ok: true });
        return;
      }
      if (String(msg.type).toLowerCase() === "stopall") {
        queue = [];
        for (const gid of Array.from(activeDownloadIds.keys())) {
          const st = activeGalleryState.get(gid); if (st) st.abortRequested = true;
          await cancelGalleryDownloads(gid);
          await dbPut(STORE_RESUME, { galleryId: gid, stopped: true, ts: Date.now() }).catch(()=>{});
        }
        chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: [] });
        sendResponse && sendResponse({ ok: true });
        return;
      }

      sendResponse && sendResponse({ ok: false, reason: "unknown_type", type: msg.type });
    } catch (e) {
      console.error("background onMessage error", e);
      sendResponse && sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

chrome.storage.local.get(["settings"], res => {
  if (res && res.settings) settings = Object.assign({}, DEFAULT_SETTINGS, res.settings);
  processQueue().catch(e => console.error(e));
});
