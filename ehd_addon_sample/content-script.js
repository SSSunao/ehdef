// content-script.js (updated - full file)
// - Fixed list button overlay (insert before anchor; not inside anchor)
// - Improved page count detection via pagination '?p=' links
// - Collects image page URLs deduplicated while preserving order
// - Extracts only #img.src and filters by extension (jpg/png/gif/webp)
// - UI states: DL button, "⌛️ URL取得中..", "⌛ ■ DL中...", "↓ ✔", and error badge "✖"
// - On STOP sends STOP_GALLERY; on errors writes nothing itself (background records resume)

// DISCLAIMER: This script runs in page context (content script) and uses fetch(..., {credentials:'include'})

(function () {
  const GALLERY_RE = /\/g\/(\d+)\/([0-9a-fA-F]+)/;
  const ADDED_ATTR = 'data-ehdl-added';
  const BTN_CLS = 'ehdl-btn';
  const STATUS_CLS = 'ehdl-status';
  const VALID_IMG_EXT = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;

  // inject CSS
  const css = `
  .${BTN_CLS}{ display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; cursor:pointer; font-size:13px; border:0; background:transparent; padding:0; margin-right:6px; }
  .${STATUS_CLS}{ font-size:12px; margin-left:6px; color: #555; }
  .ehdl-small { font-size:11px; color:#666; margin-left:6px; }
  .ehdl-done-mark { color: limegreen; margin-left:6px; font-weight:700; }
  .ehdl-error-mark { color: #ff4444; margin-left:4px; font-weight:700; }
  .ehdl-overlay { position:absolute; right:6px; top:6px; z-index:50; }
  .ehdl-thumb-sibling { position:relative; display:inline-block; }
  `;
  const styleEl = document.createElement('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

  function $(s, el = document) { return el.querySelector(s); }
  function $$(s, el = document) { return Array.from(el.querySelectorAll(s)); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function sendBg(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, resp => r(resp))); }
  function sanitize(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 150); }

  // load completed/resume sets and update DOM marks
  let completedSet = new Set();
  let resumeSet = new Set();
  async function refreshHistorySets() {
    try {
      const resp = await sendBg({ type: "GET_HISTORY" });
      const arr = resp && resp.history ? resp.history : [];
      completedSet = new Set(arr.map(x => String(x.galleryId)));
    } catch (e) {
      completedSet = new Set();
    }
    try {
      const r = await sendBg({ type: "GET_RESUME" });
      const ra = (r && r.resume) ? r.resume : [];
      resumeSet = new Set(ra.map(x => String(x.galleryId)));
    } catch (e) {
      resumeSet = new Set();
    }
    updateAllMarks();
  }

  function updateAllMarks() {
    // mark list glinks
    $$('a[href] .glink').forEach(gl => {
      const a = gl.closest('a');
      if (!a) return;
      const m = a.href.match(GALLERY_RE);
      if (!m) return;
      const gid = m[1];
      // remove existing marks
      const existing = gl.querySelector('.ehdl-done-mark'); if (existing) existing.remove();
      const err = gl.querySelector('.ehdl-error-mark'); if (err) err.remove();
      if (completedSet.has(gid)) {
        const mark = document.createElement('span'); mark.className = 'ehdl-done-mark'; mark.textContent = '✔';
        gl.appendChild(mark);
      } else if (resumeSet.has(gid)) {
        const mark = document.createElement('span'); mark.className = 'ehdl-error-mark'; mark.textContent = '✖';
        gl.appendChild(mark);
      }
    });
    // update gallery page header status handled elsewhere
  }

 const ADDED_ATTR = "data-ehdl-added";

    function insertListButtons() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));

    anchors.forEach(a => {
        // すでに処理済みならスキップ
        if (a.getAttribute(ADDED_ATTR)) return;

        const m = a.href.match(/\/g\/(\d+)\/([0-9a-fA-F]+)/);
        if (!m) return;

        const gid = m[1];

        // ボタン作成
        const btn = document.createElement("button");
        btn.className = "ehdl-btn";
        btn.textContent = "⬇";
        btn.style.cursor = "pointer";
        btn.style.marginRight = "6px";

        // クリックをリンクへ伝播させない
        btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = a.href;
        });

        // コンテナを作って、ボタン → リンク の順で入れる
        const wrapper = document.createElement("span");
        wrapper.style.display = "inline-flex";
        wrapper.style.alignItems = "center";
        wrapper.appendChild(btn);

        // (重要) wrapper を a の前に挿入し、その直後に a を移動
        a.parentNode.insertBefore(wrapper, a);
        wrapper.appendChild(a);

        // 属性フラグを付与（dataset を避ける）
        a.setAttribute(ADDED_ATTR, "1");
    });
    }

  // Insert gallery page header button (on title line)
  function insertGalleryHeaderButton() {
    const gd2 = document.getElementById('gd2');
    if (!gd2) return;
    if (gd2.dataset[ADDED_ATTR]) return;
    const titleNode = gd2.querySelector('#gn') || gd2.querySelector('#gj') || gd2.querySelector('h1');
    if (!titleNode) { gd2.dataset[ADDED_ATTR] = "1"; return; }
    // Make title node display flex to keep button inline
    titleNode.style.display = 'flex';
    titleNode.style.alignItems = 'center';
    titleNode.style.gap = '8px';
    // button
    const btn = document.createElement('button'); btn.className = BTN_CLS; btn.textContent = '⬇'; btn.title = 'Download gallery';
    const small = document.createElement('span'); small.className = 'ehdl-small'; small.textContent = ''; // status small text
    const stopBtn = document.createElement('button'); stopBtn.className = BTN_CLS; stopBtn.textContent = '■'; stopBtn.title = '停止';
    stopBtn.style.display = 'none';
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.disabled = true;
      small.textContent = '⌛️ URL取得中..';
      // collect info and send to background
      const info = await collectGalleryFull((progress) => {
        // progress callback optionally updates small text
        small.textContent = progress;
      });
      if (!info || !info.images || info.images.length === 0) {
        small.textContent = '取得失敗';
        btn.disabled = false;
        return;
      }
      // send
      const resp = await sendBg({ type: "ADD_TO_QUEUE", gallery: info });
      if (resp && resp.ok) {
        small.textContent = '';
        // show DL starting UI: display stop button and downloading text
        stopBtn.style.display = 'inline-block';
        small.textContent = '⌛ ■ DL中...';
      } else {
        small.textContent = 'キュー登録失敗';
      }
      btn.disabled = false;
    });

    stopBtn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      // find gallery id from url
      const m = location.href.match(GALLERY_RE);
      if (!m) return;
      const gid = m[1];
      stopBtn.disabled = true;
      await sendBg({ type: "STOP_GALLERY", galleryId: gid });
      small.textContent = '停止中';
      stopBtn.style.display = 'none';
      setTimeout(() => { small.textContent = ''; stopBtn.disabled = false; }, 800);
    });

    // append to title
    titleNode.insertBefore(btn, titleNode.firstChild);
    titleNode.insertBefore(stopBtn, titleNode.firstChild.nextSibling);
    titleNode.appendChild(small);
    gd2.dataset[ADDED_ATTR] = "1";
    // initial mark update
    updateAllMarks();
  }

  // Collect gallery info robustly
  async function collectGalleryFull(progressCb) {
    try {
      // bypass caution if exists
      const cont = document.getElementById('continue');
      if (cont) { cont.click(); await sleep(600); }

      const locm = location.href.match(GALLERY_RE);
      if (!locm) return null;
      const gid = locm[1], token = locm[2];
      const title = ($('#gn')?.innerText || $('#gj')?.innerText || document.title || '').trim();
      const uploader = $('#gdn > a')?.innerText?.trim() || '';
      const tags = $$('.gt').map(d => d.innerText.trim());

      // determine thumbnail pages count by parsing pagination links on first page HTML
      const firstPageUrl = `https://e-hentai.org/g/${gid}/${token}/?p=0`;
      progressCb && progressCb('⌛️ ページ解析中...');
      const firstResp = await fetch(firstPageUrl, { credentials: 'include' });
      if (!firstResp.ok) return { title, galleryId: gid, images: [], meta: { galleryId: gid, galleryToken: token, uploader, tags } };
      const firstText = await firstResp.text();
      const tmpFirst = document.createElement('div'); tmpFirst.innerHTML = firstText;
      // find pagination anchors with '?p='
      const pageAnchors = tmpFirst.querySelectorAll('a[href*="?p="]');
      let maxP = 0;
      pageAnchors.forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/[?&]p=(\d+)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (!isNaN(n) && n > maxP) maxP = n;
        }
      });
      // if none found, fallback to 0
      const pages = Math.max(1, maxP + 1);
      progressCb && progressCb(`⌛️ サムネ取得中 p 0/${pages - 1} ...`);

      // collect image page urls (preserve order, dedupe)
      const imgPageSet = new Set();
      const imgPageList = [];
      for (let p = 0; p < pages; p++) {
        progressCb && progressCb(`⌛️ URL取得中 p=${p} ...`);
        const pageUrl = `https://e-hentai.org/g/${gid}/${token}/?p=${p}`;
        try {
          const resp = (p === 0) ? firstResp : await fetch(pageUrl, { credentials: 'include' });
          if (!resp.ok) { /* skip this page */ continue; }
          const text = await resp.text();
          const tmp = document.createElement('div'); tmp.innerHTML = text;
          const anchors = tmp.querySelectorAll('a[href]');
          anchors.forEach(a => {
            const href = a.getAttribute('href') || '';
            // link to view pages typically contain '/s/' and `${gid}-`
            if (href.includes('/s/') && href.includes(`/${gid}-`)) {
              if (!imgPageSet.has(href)) { imgPageSet.add(href); imgPageList.push(href); }
            }
          });
        } catch (e) {
          console.warn('page fetch failed p=', p, e);
        }
        await sleep(80);
      }

      // now fetch each image page and extract #img.src only if extension matches
      progressCb && progressCb(`⌛️ 画像URL抽出中 (${imgPageList.length} 枚) ...`);
      const images = [];
      for (let i = 0; i < imgPageList.length; i++) {
        const url = imgPageList[i];
        try {
          progressCb && progressCb(`⌛️ 画像ページ取得 ${i + 1}/${imgPageList.length} ...`);
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) { continue; }
          const t = await r.text();
          const tmp = document.createElement('div'); tmp.innerHTML = t;
          const img = tmp.querySelector('#img');
          if (img && img.src && VALID_IMG_EXT.test(img.src)) {
            images.push(img.src);
          } else {
            // fallback: scan images and pick first with extension match and reasonably large filesize hint (skip tiny icons)
            const imgs = tmp.querySelectorAll('img');
            let chosen = null;
            for (const im of imgs) {
              const s = im.getAttribute('src') || '';
              if (s && VALID_IMG_EXT.test(s)) { chosen = s; break; }
            }
            if (chosen) images.push(chosen);
          }
        } catch (e) {
          console.warn('image page fetch fail', url, e);
        }
        await sleep(90);
      }

      return { title: title || `gallery_${gid}`, galleryId: gid, images, meta: { galleryId: gid, galleryToken: token, uploader, tags } };
    } catch (err) {
      console.error('collectGalleryFull error', err);
      return null;
    }
  }

  // message handler for updates from background (update UI)
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    const t = String(msg.type);
    // gallery page status reflection
    const loc = location.href.match(GALLERY_RE);
    const currentGid = loc ? loc[1] : null;
    if (!currentGid) return;
    if (String(msg.galleryId) !== String(currentGid)) {
      // not for this page
      return;
    }
    // find title small status
    const gd2 = document.getElementById('gd2');
    if (!gd2) return;
    const titleNode = gd2.querySelector('#gn') || gd2.querySelector('#gj') || gd2.querySelector('h1');
    if (!titleNode) return;
    const small = titleNode.querySelector('.ehdl-small');
    const stopBtn = titleNode.querySelector('button[title="停止"]');
    const dlBtn = titleNode.querySelector(`button[title="Download gallery"]`);
    if (t === 'DOWNLOAD_STATUS') {
      if (msg.status === 'preparing') { if (small) small.textContent = '⌛️ URL取得中..'; if (stopBtn) stopBtn.style.display = 'none'; if (dlBtn) dlBtn.style.display = 'inline-block'; }
      if (msg.status === 'downloading') { if (small) small.textContent = '⌛ ■ DL中...'; if (stopBtn) stopBtn.style.display = 'inline-block'; }
    } else if (t === 'DOWNLOAD_PROGRESS') {
      if (small) small.textContent = `⌛ ■ DL中... (${msg.current}/${msg.total})`;
      if (stopBtn) stopBtn.style.display = 'inline-block';
    } else if (t === 'DOWNLOAD_FINISHED') {
      // show download arrow + check mark
      if (small) small.textContent = '';
      if (stopBtn) stopBtn.style.display = 'none';
      // ensure green check added to header and list
      refreshHistorySets().then(() => {
        // update header mark
        if (titleNode && !titleNode.querySelector('.ehdl-done-mark')) {
          const mark = document.createElement('span'); mark.className = 'ehdl-done-mark'; mark.textContent = '✔';
          titleNode.appendChild(mark);
        }
      });
    } else if (t === 'DOWNLOAD_ERROR') {
      // show check + red cross
      if (small) small.textContent = '';
      if (stopBtn) stopBtn.style.display = 'none';
      // mark resume
      refreshHistorySets().then(() => {
        if (titleNode && !titleNode.querySelector('.ehdl-error-mark')) {
          const mark = document.createElement('span'); mark.className = 'ehdl-error-mark'; mark.textContent = '✖';
          titleNode.appendChild(mark);
        }
      });
    }
  });

  // observe DOM and insert buttons
  function init() {
    insertListButtons();
    insertGalleryHeaderButton();
    refreshHistorySets();
    const mo = new MutationObserver(() => { insertListButtons(); insertGalleryHeaderButton(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  init();

})();
