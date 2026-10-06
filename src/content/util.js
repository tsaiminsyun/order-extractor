/* 共用工具：各站台共用的小工具、頁面載入方式。掛在 globalThis.OrderScraper 上，
 * 因為 content script 無法用 import。 */
globalThis.OrderScraper ??= { sites: [], readers: {} };

(() => {
  'use strict';

  const FRAME_LOAD_TIMEOUT_MS = 30000;
  const FRAME_POLL_MS = 200;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/[\u200e\u200f]/g, ' ').replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.textContent);
  const attr = (el, name) => el?.getAttribute(name) || '';
  const all = (root, sel) => Array.from(root.querySelectorAll(sel));

  // CSS Modules 的 class 帶雜湊（ellipsis--3QFZf），雜湊每次改版都會變，只比對前綴
  const cls = (prefix) => `[class*="${prefix}--"]`;

  const parseMoney = (str) => {
    const m = String(str || '').match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/); // ￥ / ¥ / JP¥ / 純數字
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  const absUrl = (href, base) => {
    try { return href ? new URL(href, base).href : null; } catch { return null; }
  };

  /* ---------- DOM 範圍 ---------- */

  // 從 start 往上爬，只要父節點的 count ≤ 1 就繼續，回傳最高的那層
  function climbUnique(start, boundary, count) {
    let node = start;
    while (node.parentElement && node.parentElement !== boundary && count(node.parentElement) <= 1) {
      node = node.parentElement;
    }
    return node;
  }

  const countContained = (els) => (scope) => els.filter((el) => scope.contains(el)).length;
  const countMatches = (sel) => (scope) => scope.querySelectorAll(sel).length;
  const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
  const byDocumentOrder = (a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

  // 給 climbUnique 用的計數函式：這個範圍裡有幾筆「不同的」訂單。
  // 同一個注文番号在桌機版與手機版標頭可能各出現一次，所以不能直接數元素個數
  const countOrderIds = (sel, idOf) => (scope) =>
    new Set(all(scope, sel).map(idOf).filter(Boolean)).size;

  // 以注文番号為錨點切出每筆訂單的範圍（scopeOf 回傳 { card, …站台自己要的欄位 }）。
  // 同一個番号出現多次只取第一個；不同番号爬到同一個容器時也只留一筆
  function cardsByOrderId(anchors, idOf, scopeOf) {
    const firstEl = new Map();
    for (const el of anchors) {
      const id = idOf(el);
      if (id && !firstEl.has(id)) firstEl.set(id, el);
    }

    const seen = new Set();
    const cards = [];
    for (const [orderId, el] of firstEl) {
      const scope = scopeOf(el);
      if (seen.has(scope.card)) continue;
      seen.add(scope.card);
      cards.push({ orderId, ...scope });
    }
    return cards;
  }

  /* ---------- 另外載入頁面 ---------- */

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return { doc: new DOMParser().parseFromString(await res.text(), 'text/html'), url: res.url || url };
  }

  // 等 iframe 載入到同網域的文件。只要 HTML 解析完就回傳，不必等圖片等資源（load 事件）。
  // 被擋下（例如 X-Frame-Options 的錯誤頁讀不到 DOM）或逾時回傳 null
  function frameDocument(frame) {
    return new Promise((resolve) => {
      const started = Date.now();
      let loaded = false;
      frame.addEventListener('load', () => { loaded = true; }, { once: true });
      const check = () => {
        let doc = null;
        try { doc = frame.contentDocument; } catch { /* 跨網域或被擋 */ }
        // 導向目標頁之前 contentDocument 是 about:blank，要排除
        if (doc?.location.href.startsWith(location.origin) && doc.readyState !== 'loading') return resolve(doc);
        if (loaded || Date.now() - started > FRAME_LOAD_TIMEOUT_MS) return resolve(null);
        setTimeout(check, FRAME_POLL_MS);
      };
      check();
    });
  }

  // 用隱藏 iframe 載入同網域頁面並讀取內容；被擋下時回傳 null（由呼叫端改用背景分頁）
  async function readInFrame(url, read) {
    const frame = document.createElement('iframe');
    // 不給 allow-top-navigation：避免頁面的防嵌入程式把目前頁面導走
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;';
    frame.src = url;
    document.body.append(frame);
    try {
      const doc = await frameDocument(frame);
      return doc && (await read(doc));
    } finally {
      frame.remove();
    }
  }

  globalThis.OrderScraper.util = {
    sleep, clean, textOf, attr, all, cls, parseMoney, absUrl,
    climbUnique, countContained, countMatches, outermost, byDocumentOrder,
    countOrderIds, cardsByOrderId,
    fetchDoc, readInFrame,
  };
})();
