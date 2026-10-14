import { ordersToJson, downloadText, stamp } from './src/lib/export.js';

const CONTENT_SCRIPTS = [
  "src/content/util.js",
  "src/content/readers.js",
  "src/content/sites/amazon.js",
  "src/content/sites/rakuten.js",
  "src/content/sites/shopify.js",
  "src/content/sites/tower.js",
  "src/content/main.js",
];
const PREVIEW_LIMIT = 100;

const $ = (id) => document.getElementById(id);
const els = {
  version: $('version'),
  status: $('status'),
  candidates: $('candidates'),
  candidateList: $('candidateList'),
  candidateHint: $('candidateHint'),
  selectAll: $('selectAll'),
  scrape: $('scrape'),
  progress: $('progress'),
  result: $('result'),
  preview: $('preview'),
  saveJson: $('saveJson'),
};

let lastResult = null;
/* 掃描結果。old / recent 是 content script 標好的 ——
 * 「幾天內算新」那條線定義在 main.js，這裡不重算，免得兩邊各有一份會走鐘 */
let candidates = [];
let recentDays = 7;    // 只用來寫訊息，實際的判斷看每筆訂單的 old / recent

/* ---------- 小工具 ---------- */

const yen = (n) => (typeof n === 'number' ? `¥${n.toLocaleString('ja-JP')}` : '');

// 檔名帶上站台，兩個站台的匯出檔才不會搞混
const filename = (ext) => `${lastResult?.site || 'orders'}-orders-${stamp()}.${ext}`;

function el(tag, { className, text, title } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (title) node.title = title;
  return node;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function setProgress(text) {
  els.progress.classList.toggle('hidden', !text);
  els.progress.textContent = text || '';
}

/* ---------- 分頁 ---------- */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 擴充功能剛重新載入時，既有分頁裡沒有 content script，需要補打進去
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ok) return pong;
  } catch { /* 尚未注入 */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
  return chrome.tabs.sendMessage(tabId, { type: 'PING' });
}

/* ---------- 要擷取哪幾筆 ---------- */

const boxes = () => [...els.candidateList.querySelectorAll('input[type="checkbox"]')];
const selectedIds = () => boxes().filter((b) => b.checked).map((b) => b.value);

function syncControls() {
  const all = boxes();
  const picked = all.filter((b) => b.checked).length;
  els.scrape.disabled = picked === 0;
  els.scrape.textContent = picked ? `擷取選取的 ${picked} 筆` : '擷取選取的訂單';
  els.selectAll.checked = picked > 0 && picked === all.length;
  els.selectAll.indeterminate = picked > 0 && picked < all.length;
}

// 一列一筆訂單：注文日 / 注文番号 / 合計 / 列表頁上已經知道的部分
function candidateRow(order) {
  const row = el('label', { className: 'candidate' });
  const box = el('input');
  box.type = 'checkbox';
  box.value = order.orderId;
  box.checked = order.recent;
  box.addEventListener('change', syncControls);

  const date = order.orderedAt
    ? el('span', { className: 'c-date', text: order.orderedAt })
    : el('span', { className: 'c-date muted', text: '日期不明' });
  if (order.recent) date.classList.add('recent');

  // 列表頁上就看得到伝票番号時直接顯示；Shopify 與楽天英文介面要讀詳細頁才知道
  const note = order.trackingIds.length
    ? `${order.trackingIds.length} 個包裹`
    : (order.needsLookup ? '要讀詳細頁' : '');

  row.append(
    box,
    date,
    el('span', { className: 'c-id', text: order.orderId, title: order.orderId }),
    el('span', { className: 'c-total num', text: yen(order.total) }),
    el('span', { className: 'c-note muted', text: note })
  );
  return row;
}

function renderCandidates() {
  const shown = candidates.filter((o) => !o.old);
  els.candidateList.replaceChildren(...shown.map(candidateRow));
  els.candidates.classList.remove('hidden');
  // 這一頁還有幾筆更舊的只寫個數字，讓使用者知道不是解析漏了
  els.candidateHint.textContent = shown.length === candidates.length
    ? `共 ${candidates.length} 筆`
    : `${recentDays} 天內 ${shown.length} 筆（掃過 ${candidates.length} 筆）`;
  syncControls();
}

els.selectAll.addEventListener('change', () => {
  boxes().forEach((b) => { b.checked = els.selectAll.checked; });
  syncControls();
});

/* ---------- 結果 ---------- */

function renderPreview(orders) {
  const rows = orders
    .flatMap((o) => (o.items.length ? o.items : [{ title: '（未解析到商品）' }]).map((it) => ({ o, it })))
    .slice(0, PREVIEW_LIMIT)
    .map(({ o, it }) => {
      const tr = el('tr');
      const title = el('td');
      title.append(el('span', { className: 'title', text: it.title, title: it.title }));
      // 數量 1 件是常態，只在 2 件以上時標示
      if (it.quantity > 1) title.append(el('span', { className: 'qty', text: ' ×' + it.quantity }));
      tr.append(
        el('td', { text: o.orderId }),
        title,
        el('td', { className: 'num', text: yen(o.total) }),
        el('td', { text: [o.carrier, o.trackingId].filter(Boolean).join(' ') })
      );
      return tr;
    });

  const table = el('table');
  table.innerHTML = '<thead><tr><th>注文番号</th><th>品名</th><th>合計</th><th>配送業者 / ID</th></tr></thead>';
  const tbody = el('tbody');
  tbody.append(...rows);
  table.append(tbody);
  els.preview.replaceChildren(table);
}

function render(result) {
  lastResult = result;
  renderPreview(result.orders);
  els.result.classList.remove('hidden');
  els.saveJson.disabled = !result.orders.length;
}

/* ---------- 事件 ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'SCRAPE_PROGRESS') return;
  if (msg.phase === 'lookup') {
    setProgress(`讀取詳細資料 ${msg.done} / ${msg.total}…`);
  } else if (msg.phase === 'scan') {
    setProgress(`讀取訂單列表…（第 ${msg.pages} 頁，${msg.orders} 筆）`);
  } else {
    setProgress(`解析頁面…（${msg.orders} 筆訂單）`);
  }
});

els.scrape.addEventListener('click', async () => {
  const orderIds = selectedIds();
  els.scrape.disabled = true;
  setStatus('已就緒'); // 清掉上一次失敗留下的錯誤訊息
  setProgress('開始擷取…');
  try {
    const tab = await activeTab();
    // 結果由 content script 存進 storage，這裡只負責顯示
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE', payload: { orderIds } });
    if (!result?.ok) throw new Error(result?.error || '擷取失敗');
    setProgress('完成');
    render(result);
  } catch (err) {
    setProgress('');
    setStatus(`擷取失敗：${err.message}`, true);
  } finally {
    syncControls();
  }
});

els.saveJson.addEventListener('click', () => {
  downloadText(filename('json'), ordersToJson(lastResult.orders));
});

/* ---------- 初始化 ---------- */

// 一律先問 content script：支不支援目前這一頁由它決定（站台可能是用頁面特徵判斷的）
async function checkTab() {
  const tab = await activeTab();
  try {
    const pong = await ensureContentScript(tab.id);
    if (!pong?.onOrderPage) {
      setStatus('目前的分頁不是支援的訂單紀錄頁', true);
      return;
    }
    setStatus(`已就緒（${pong.label}）`);
    // 先把這一頁上的訂單列出來讓使用者勾，勾完才去讀詳細頁
    const list = await chrome.tabs.sendMessage(tab.id, { type: 'PREVIEW' });
    if (!list?.ok) throw new Error(list?.error || '讀不到這一頁的訂單');
    if (!list.orders.length) {
      setStatus(`這一頁沒有可擷取的訂單（${pong.label}）`, true);
      return;
    }
    candidates = list.orders;
    recentDays = list.recentDays ?? recentDays;
    renderCandidates();
    // 翻了幾頁要講出來，不然使用者會以為清單上的訂單只來自眼前這一頁
    if (list.pages > 1) setStatus(`已就緒（${pong.label}，翻了 ${list.pages} 頁）`);
    // 全部都是舊訂單時清單會是空的，要講清楚為什麼
    if (!els.candidateList.children.length) {
      setStatus(`沒有 ${recentDays} 天內的訂單（掃過 ${candidates.length} 筆都更舊）`, true);
    }
  } catch {
    // 注入不進去（chrome:// 等頁面），或分頁需要重新整理
    setStatus('這個分頁無法擷取，請開啟訂單紀錄頁後重試', true);
  }
}

async function restoreLastResult() {
  const { lastResult: saved } = await chrome.storage.local.get('lastResult');
  if (saved?.orders?.length) render(saved);
}

els.version.textContent = `v${chrome.runtime.getManifest().version}`;
checkTab();
restoreLastResult();
