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

  /* 注文日：各站台的寫法都不一樣，一律轉成 YYYY-MM-DD。認不得就回 null，不猜 ——
   * 日期是用來決定「七天內」的，猜錯會讓使用者漏掉或多抓訂單。
   *   2026-10-05T14:53:07Z   Shopify 的 <time datetime>
   *   2026/10/08、2026/09/18(金)、2026/09/29 (Tuesday)   タワーレコード / 楽天
   *   2026年8月21日                                      Amazon 日本語 / 简体中文
   *   2026年09月 10日（木）                               ポケモンセンター（月和日中間有空格）
   *   2026.10.17 21:06:59                                ZOZOTOWN
   *   August 21, 2026                                    Amazon English */
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const ymd = (y, m, d) =>
    (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31
      ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      : null);

  function parseDate(text) {
    const str = clean(text);
    if (!str) return null;
    const iso = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return ymd(iso[1], iso[2], iso[3]);
    const slash = str.match(/(\d{4})\s*[/年.]\s*(\d{1,2})\s*[/月.]\s*(\d{1,2})/);
    if (slash) return ymd(slash[1], slash[2], slash[3]);
    const named = str.match(/([A-Za-z]{3,})\s+(\d{1,2}),?\s*(\d{4})/);
    if (named) {
      const month = MONTHS.findIndex((name) => name.startsWith(named[1].toLowerCase().slice(0, 3)));
      if (month >= 0) return ymd(named[3], month + 1, named[2]);
    }
    return null;
  }

  /* 配送業者由查詢網址的網域判斷（タワーレコード、ポケモンセンター）。
   * 子網域不固定（ポケモンセンター連的是 member.kms.kuronekoyamato.co.jp），所以比對結尾 */
  const CARRIER_HOSTS = [
    [/(^|\.)japanpost\.jp$/, '日本郵便'],
    [/(^|\.)kuronekoyamato\.co\.jp$/, 'ヤマト運輸'],
    [/(^|\.)sagawa-exp\.co\.jp$/, '佐川急便'],
  ];
  const carrierOf = (href) => {
    try { return CARRIER_HOSTS.find(([host]) => host.test(new URL(href).hostname))?.[1] || ''; }
    catch { return ''; }
  };

  const absUrl = (href, base) => {
    try { return href ? new URL(href, base).href : null; } catch { return null; }
  };

  /* 下一頁的連結。各站台的分頁版面都不一樣，這裡只認最通用的三種訊號：
   *   <a rel="next">、aria-label 是 next 之類的字、連結文字是「次へ / Next / 下一頁」
   * 認不出來就回 null —— 那就停在目前這一頁，跟沒有分頁功能時一樣。
   * 注意：樂天的「次へ」是 <button> 沒有 href，這個規則抓不到它 */
  const NEXT_TEXT_RE = /^(?:次(?:へ|のページ)?|next(?:\s*page)?|下一頁|下一页|›|»)$/i;

  const samePage = (a, b) => {
    try {
      const [x, y] = [new URL(a), new URL(b)];
      x.hash = '';
      y.hash = '';
      return x.href === y.href;
    } catch { return a === b; }
  };

  function nextPageLink(doc, pageUrl) {
    const rel = doc.querySelector('a[rel~="next"][href]');
    const labelled = Array.from(doc.querySelectorAll('a[href]')).find((a) =>
      NEXT_TEXT_RE.test(clean(a.getAttribute('aria-label'))) || NEXT_TEXT_RE.test(clean(a.textContent)));
    const url = absUrl((rel || labelled)?.getAttribute('href'), pageUrl);
    // 連回同一頁（#、javascript:）就不算下一頁，不然會原地打轉
    return url && !samePage(url, pageUrl) ? url : null;
  }

  /* 查詢字串帶 page=N 的站台（Shopify 的 /account?page=1）：直接加一。
   * 猜錯也不會有事 —— 回來的若是同一頁，注文番号全部重複，上層就會停下來 */
  function bumpPageParam(pageUrl, param = 'page') {
    try {
      const url = new URL(pageUrl);
      const page = Number(url.searchParams.get(param) || 1);
      if (!Number.isInteger(page) || page < 1) return null;
      url.searchParams.set(param, String(page + 1));
      return url.href;
    } catch { return null; }
  }

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

  /* 照瀏覽器送出表單的規則，組出跟頁面送出 form 一樣的請求（mu-mo、plusmember 的詳細頁
   * 不是一般連結，是頁面的 JS 把代碼填進表單再送出）。
   * 送出按鈕、沒勾的選項、停用的欄位都不帶；values 填進同名的欄位。
   * POST 時欄位放在 body；GET 時欄位取代網址原本的查詢字串 */
  function formRequest(form, action, values) {
    const fields = new URLSearchParams();
    for (const el of all(form, 'input[name], select[name], textarea[name]')) {
      if (el.disabled || /^(?:submit|button|image|reset|file)$/i.test(el.type || '')) continue;
      if (/^(?:checkbox|radio)$/i.test(el.type || '') && !el.checked) continue;
      fields.append(el.name, el.value);
    }
    for (const [name, value] of Object.entries(values)) fields.set(name, value);
    const url = new URL(action);
    if (/^post$/i.test(attr(form, 'method'))) return { url: url.href, post: fields.toString() };
    url.search = fields.toString();
    return { url: url.href };
  }

  /* 回應的編碼：Content-Type 的 charset → HTML 開頭的 <meta charset> → UTF-8。
   * res.text() 一律當 UTF-8 解，Shift_JIS / EUC-JP 的舊站會變成亂碼，標籤就比對不到 */
  async function decodeHtml(res) {
    const buf = await res.arrayBuffer();
    const head = new TextDecoder('windows-1252').decode(buf.slice(0, 2048));
    const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1]
      || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
      || 'utf-8';
    try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder().decode(buf); }
  }

  // post 有給時用 POST 送出（application/x-www-form-urlencoded，跟網頁表單一樣）
  async function fetchDoc(url, post) {
    const init = { credentials: 'include', headers: { Accept: 'text/html' } };
    if (post != null) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = post;
    }
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return { doc: new DOMParser().parseFromString(await decodeHtml(res), 'text/html'), url: res.url || url };
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
    sleep, clean, textOf, attr, all, cls, parseMoney, parseDate, carrierOf, absUrl,
    nextPageLink, bumpPageParam,
    climbUnique, countContained, countMatches, outermost, byDocumentOrder,
    countOrderIds, cardsByOrderId,
    formRequest, fetchDoc, readInFrame,
  };
})();
