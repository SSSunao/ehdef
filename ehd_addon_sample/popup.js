/* popup.js — 完全版 */

const qs = sel => document.querySelector(sel);
const qsa = sel => [...document.querySelectorAll(sel)];
const send = (type, body={}) => chrome.runtime.sendMessage({type, ...body});

// elements
const fname = qs("#fname");
const folder = qs("#folder");
const chkFname = qs("#chkFname");
const chkFolder = qs("#chkFolder");
const concurrent = qs("#concurrent");
const rangeChk = qs("#rangeChk");
const rangeStart = qs("#rangeStart");
const rangeEnd = qs("#rangeEnd");

const queueBox = qs("#queueBox");
const historyBox = qs("#historyBox");

const saveBtn = qs("#saveBtn");
const clearHistoryBtn = qs("#clearHistoryBtn");
const reloadHistoryBtn = qs("#reloadHistoryBtn");
const stopAllBtn = qs("#stopAllBtn");

const themeBtn = qs("#themeBtn");
const exportBtn = qs("#exportBtn");
const hintBtn = qs("#hintBtn");
const hintPopup = qs("#hintPopup");

// --------------------------
// 初期化
// --------------------------
document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    loadQueue();
    loadHistory();
});

// --------------------------
// 設定のロード
// --------------------------
function loadSettings(){
    chrome.storage.local.get([
        "fname", "folder", "useFname", "useFolder",
        "concurrent", "range", "theme"
    ], st => {
        fname.value = st.fname || "";
        folder.value = st.folder || "";
        chkFname.checked = !!st.useFname;
        chkFolder.checked = !!st.useFolder;

        concurrent.value = st.concurrent || 2;

        if(st.range){
            rangeChk.checked = st.range.enable || false;
            rangeStart.value = st.range.start ?? "";
            rangeEnd.value = st.range.end ?? "";
        }

        document.body.dataset.theme = st.theme || "light";
    });
}

// --------------------------
// 設定保存
// --------------------------
saveBtn.onclick = () => {
    chrome.storage.local.set({
        fname: fname.value,
        folder: folder.value,
        useFname: chkFname.checked,
        useFolder: chkFolder.checked,
        concurrent: Number(concurrent.value),
        range: {
            enable: rangeChk.checked,
            start: rangeStart.value === "" ? null : Number(rangeStart.value),
            end: rangeEnd.value === "" ? null : Number(rangeEnd.value),
        }
    }, () => {
        saveBtn.textContent = "保存済み";
        setTimeout(() => saveBtn.textContent = "設定保存", 700);
    });
};

// --------------------------
// キュー表示
// --------------------------
function loadQueue(){
    send("getQueue", {}, q => {
        queueBox.innerHTML = "";

        if(!q || q.length === 0){
            queueBox.innerHTML = `<div class="queue-item">(空)</div>`;
            return;
        }

        q.forEach(item => {
            const el = document.createElement("div");
            el.className = "queue-item";
            el.innerHTML = `
                <div class="meta">${item.title || item.gallery_id}</div>
                <button class="btn-danger" data-id="${item.gallery_id}">停止</button>
            `;
            queueBox.appendChild(el);
        });

        qsa(".btn-danger").forEach(btn => {
            btn.onclick = () => {
                send("stopGallery", {gallery_id: btn.dataset.id});
            };
        });
    });
}

// --------------------------
// 履歴表示
// --------------------------
function loadHistory(){
    send("getHistory", {}, hist => {
        historyBox.innerHTML = "";
        if(!hist || hist.length === 0){
            historyBox.innerHTML = `<div class="queue-item">(履歴なし)</div>`;
            return;
        }

        hist.slice().reverse().forEach(h => {
            const el = document.createElement("div");
            el.className = "queue-item";
            el.innerHTML = `<div class="meta">${h.title}</div>`;
            historyBox.appendChild(el);
        });
    });
}

// 履歴削除
clearHistoryBtn.onclick = () => {
    send("clearHistory");
    loadHistory();
};

// 再読み込み
reloadHistoryBtn.onclick = () => {
    loadHistory();
    loadQueue();
};

// 全停止
stopAllBtn.onclick = () => {
    send("stopAll");
    setTimeout(loadQueue, 300);
};

// --------------------------
// テーマ切替
// --------------------------
themeBtn.onclick = () => {
    const now = document.body.dataset.theme;
    const next = (now === "light") ? "dark" : (now === "dark" ? "classic" : "light");
    document.body.dataset.theme = next;
    chrome.storage.local.set({theme: next});
};

// --------------------------
// 変数ヒント
// --------------------------
hintBtn.onclick = () => {
    hintPopup.style.display = (hintPopup.style.display === "block") ? "none" : "block";
};
document.addEventListener("click", e => {
    if(!hintPopup.contains(e.target) && e.target !== hintBtn){
        hintPopup.style.display = "none";
    }
});

// --------------------------
// Export History
// --------------------------
exportBtn.onclick = () => {
    send("exportHistory");
};

// --------------------------
// Background → Popup 更新連携
// --------------------------
chrome.runtime.onMessage.addListener((msg) => {
    if(msg.type === "queueUpdated") loadQueue();
    if(msg.type === "historyUpdated") loadHistory();
});
