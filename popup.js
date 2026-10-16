import { ordersToJson, downloadText, stamp } from './src/lib/export.js';

const CONTENT_SCRIPTS = [
  "src/content/util.js",
  "src/content/readers.js",
  "src/content/sites/amazon.js",
  "src/content/sites/rakuten.js",
  "src/content/sites/shopify.js",
  "src/content/sites/tower.js",
  "src/content/sites/pokemoncenter.js",
  "src/content/main.js",
];

const $ = (id) => document.getElementById(id);
const els = {
  version: $('version'),
  status: $('status'),
  progress: $('progress'),
  warning: $('warning'),
  result: $('result'),
  selectAll: $('selectAll'),
  summary: $('summary'),
  preview: $('preview'),
  saveJson: $('saveJson'),
};

// 擷取結果：一個包裹一筆，表格的每一列對應這裡的一筆（checkbox 的 value 是索引）
let result = null;

/* ---------- 小工具 ---------- */

const yen = (n) => (typeof n === 'number' ? `¥${n.toLocaleString('ja-JP')}` : '');

// 檔名帶上站台，不同站台的匯出檔才不會搞混
const filename = () => `${result?.site || 'orders'}-orders-${stamp()}.json`;

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

function setWarning(text) {
  els.warning.classList.toggle('hidden', !text);
  els.warning.textContent = text || '';
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

/* ---------- 表格 ---------- */

const boxes = () => [...els.preview.querySelectorAll('input[type="checkbox"]')];
const selected = () => boxes().filter((b) => b.checked).map((b) => result.orders[Number(b.value)]);

function syncControls() {
  const all = boxes();
  const picked = all.filter((b) => b.checked).length;
  els.saveJson.disabled = picked === 0;
  els.saveJson.textContent = picked ? `下載 JSON（${picked} 筆）` : '下載 JSON';
  els.selectAll.checked = picked > 0 && picked === all.length;
  els.selectAll.indeterminate = picked > 0 && picked < all.length;
}

// 一列一個包裹。品名一件一行，2 件以上才標數量
function parcelRow(parcel, index) {
  const tr = el('tr');

  const pick = el('td', { className: 'pick' });
  const box = el('input');
  box.type = 'checkbox';
  box.value = String(index);
  // 七天內的才會出現在這裡，預設全勾。注文日讀不到的例外 —— 不知道就別替使用者決定
  box.checked = Boolean(parcel.orderedAt);
  box.addEventListener('change', syncControls);
  pick.append(box);

  const titles = el('td');
  for (const item of parcel.items.length ? parcel.items : [{ title: '（未解析到商品）' }]) {
    const line = el('span', { className: 'title', text: item.title, title: item.title });
    if (item.quantity > 1) line.append(el('span', { className: 'qty', text: ` ×${item.quantity}` }));
    titles.append(line);
  }

  const id = el('td', { className: 'c-id', text: parcel.orderId });
  if (!parcel.orderedAt) id.append(el('span', { className: 'muted', text: '（日期不明）' }));

  // 業者名一行、tracking ID 一行（中間的空白讓複製出來的文字仍然分得開）
  const ship = el('td', { className: 'c-ship' });
  if (parcel.carrier) ship.append(el('span', { text: parcel.carrier }), ' ');
  ship.append(el('span', { className: 'ship-id', text: parcel.trackingId }));

  tr.append(pick, id, titles, el('td', { className: 'num c-total', text: yen(parcel.total) }), ship);
  return tr;
}

function render() {
  const table = el('table');
  table.innerHTML = '<thead><tr><th class="pick"></th><th class="c-id">訂單編號</th><th>品名</th>'
    + '<th class="c-total">合計</th><th class="c-ship">物流業者 / 運單號</th></tr></thead>';
  const tbody = el('tbody');
  tbody.append(...result.orders.map(parcelRow));
  table.append(tbody);
  els.preview.replaceChildren(table);
  els.summary.textContent = `${result.recentDays} 天內 ${result.orders.length} 個包裹`;
  els.result.classList.remove('hidden');
  syncControls();
}

/* ---------- 事件 ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'SCRAPE_PROGRESS') return;
  if (msg.phase === 'scan') setProgress(`讀取訂單列表…（第 ${msg.pages} 頁）`);
  else if (msg.phase === 'lookup') setProgress(`讀取配送資料 ${msg.done} / ${msg.total}…`);
  else setProgress(`整理訂單…（${msg.orders} 筆）`);
});

els.selectAll.addEventListener('change', () => {
  boxes().forEach((b) => { b.checked = els.selectAll.checked; });
  syncControls();
});

els.saveJson.addEventListener('click', () => {
  downloadText(filename(), ordersToJson(selected()));
});

/* ---------- 初始化 ---------- */

// 一律先問 content script：支不支援目前這一頁由它決定（站台可能是用頁面特徵判斷的）。
// 支援就直接整套跑完，不用再按任何按鈕
async function start() {
  const tab = await activeTab();
  let pong;
  try {
    pong = await ensureContentScript(tab.id);
  } catch {
    // 注入不進去（chrome:// 等頁面），或分頁需要重新整理
    setStatus('這個分頁無法擷取，請開啟訂單紀錄頁後重試', true);
    return;
  }
  if (!pong?.onOrderPage) {
    setStatus('目前的分頁不是支援的訂單紀錄頁', true);
    return;
  }

  setStatus(`讀取中…（${pong.label}）`);
  setProgress('開始擷取…');
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE' });
    if (!res?.ok) throw new Error(res?.error || '擷取失敗');
    result = res;
  } catch (err) {
    setProgress('');
    setStatus(`擷取失敗：${err.message}`, true);
    return;
  }

  setProgress('');
  const pages = result.pages > 1 ? `，翻了 ${result.pages} 頁` : '';
  if (result.missingTracking) {
    setWarning(`另有 ${result.missingTracking} 個配送中的包裹讀不到配送資料，沒有列出來`);
  }
  if (!result.orders.length) {
    setStatus(`${result.recentDays} 天內沒有配送中的訂單（${pong.label}${pages}）`, true);
    return;
  }
  setStatus(`已就緒（${pong.label}${pages}）`);
  render();
}

els.version.textContent = `v${chrome.runtime.getManifest().version}`;
start();
