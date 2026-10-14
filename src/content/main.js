/* 擷取流程（各站台共用）：掃描訂單列表（必要時自動翻頁）→ 讀取需要另外載入的頁面
 * （配送資料 / 合計）。
 *
 * 這個擴充功能只要**配送中**的訂單。已送達的在認得出來的站台上由各站台的轉接層擋掉；
 * 認不出來的站台（Shopify、楽天英文介面）改用「下單未滿七天」當替代條件。
 * 翻頁也是停在這條線上 —— 訂單列表都是新到舊排的，翻到整頁都超過七天就不必再往下。 */
(() => {
  'use strict';
  const { sites, readers, util } = globalThis.OrderScraper;
  const { sleep, fetchDoc, readInFrame } = util;

  const RECENT_DAYS = 7;   // 超過就不要了，見檔頭
  const MAX_PAGES = 10;    // 保險閥：分頁連結壞掉時不要一直翻下去
  const RENDER_WAIT_MS = 6000;  // 前端渲染的列表頁等訂單出現的上限
  const POLL_MS = 200;

  const currentSite = () => sites.find((s) => s.isOrderPage(location, document));

  function progress(payload) {
    chrome.runtime.sendMessage({ type: 'SCRAPE_PROGRESS', ...payload }).catch(() => {});
  }

  /* ---------- 注文日 ---------- */

  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const daysAgo = (orderedAt) =>
    Math.round((startOfToday() - Date.parse(`${orderedAt}T00:00:00`)) / 86400000);

  // 日期不明的既不算新也不算舊 —— 站台改版導致日期抓不到時，訂單不該整批無聲消失
  const isRecent = (orderedAt) =>
    orderedAt != null && daysAgo(orderedAt) >= 0 && daysAgo(orderedAt) < RECENT_DAYS;
  const isOld = (orderedAt) => orderedAt != null && daysAgo(orderedAt) >= RECENT_DAYS;

  /* ---------- 需要真的載入才讀得到的頁面 ---------- */

  // 另外載入的頁面分兩種讀法，由站台指定 via：
  //   'frame'（預設）前端渲染的頁面，要讓瀏覽器真的跑完 JS，用隱藏 iframe
  //   'fetch'         伺服器就渲染好的頁面（例如 Shopify 的訂單頁），抓回來解析即可，快得多
  // read 一律在頁面還活著的時候跑完 —— iframe 讀完就會被移除，不能把 document 帶出來
  async function withPage(url, via, read) {
    if (via === 'fetch') {
      const { doc } = await fetchDoc(url);
      return read(doc);
    }
    return readInFrame(url, read);
  }

  async function readPage(url, reader, via) {
    try {
      const info = await withPage(url, via, (doc) => readers[reader](doc));
      // iframe 被擋下時就放棄這一頁，相關欄位留空，不另開分頁
      return info || { ok: false, error: '頁面無法在 iframe 內載入' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // 同一個網址只讀一次，所有網址同時讀取
  async function runLookups(orders) {
    const byUrl = new Map();
    for (const { url, reader, via, apply } of orders.flatMap((o) => o.lookups)) {
      if (!byUrl.has(url)) byUrl.set(url, { reader, via, waiting: [] });
      byUrl.get(url).waiting.push(apply);
    }

    const total = byUrl.size;
    let done = 0;
    progress({ phase: 'lookup', done, total });
    await Promise.all([...byUrl].map(async ([url, { reader, via, waiting }]) => {
      const info = await readPage(url, reader, via);
      progress({ phase: 'lookup', done: ++done, total });
      // 讀失敗或需要重新登入的頁面，相關欄位留空
      if (info.ok) for (const apply of waiting) apply(info);
    }));
  }

  /* ---------- 掃描訂單列表 ---------- */

  const parseOrders = (site, doc, url) => site.findOrders(doc, url).filter(Boolean);

  // 另外載入的列表頁：前端渲染的要等訂單卡片出現才讀得到
  async function readListPage(site, { url, via }) {
    return withPage(url, via, async (doc) => {
      if (via !== 'fetch') {
        const deadline = Date.now() + RENDER_WAIT_MS;
        while (!parseOrders(site, doc, url).length && Date.now() < deadline) await sleep(POLL_MS);
      }
      // nextPage 也要在這裡算完 —— 離開這個函式之後 iframe 就沒了
      return { orders: parseOrders(site, doc, url), next: site.nextPage?.(doc, url) || null };
    });
  }

  /* 從使用者眼前這一頁開始往後翻，直到：
   *   - 沒有下一頁的連結（或站台沒有實作）
   *   - 整頁訂單都超過七天（列表是新到舊排的，再往後只會更舊）
   *   - 翻到的頁面沒有新的注文番号（重複或空頁）
   *   - 到達 MAX_PAGES
   * 翻頁失敗不算錯誤：把已經掃到的交出去就好。
   *
   * 掃到的訂單**全部**回傳，超過七天的只是標記起來（見 summarize 的 old）——
   * 要不要顯示由 popup 決定。這一層只用七天決定「翻到哪裡為止」。 */
  async function scanOrders() {
    const site = currentSite();
    if (!site) throw new Error('目前頁面不是支援的訂單列表頁');
    if (site.isSignInPage(document, location.href)) {
      throw new Error('需要重新登入，請在分頁登入後再試一次');
    }

    const seen = new Set();
    const kept = [];
    let scanned = 0;
    let pages = 0;
    let atPageCap = false;
    // 第一頁用使用者眼前這一份 document，不重新載入
    let page = { orders: parseOrders(site, document, location.href), next: site.nextPage?.(document, location.href) || null };

    while (page) {
      pages += 1;
      // 同一筆注文番号在頁面上可能出現多次（桌機 / 手機版版面），也可能跨頁重複
      const fresh = page.orders.filter((o) => !seen.has(o.orderId) && seen.add(o.orderId));
      scanned += fresh.length;
      kept.push(...fresh);
      progress({ phase: 'scan', pages, orders: kept.filter((o) => !isOld(o.orderedAt)).length });

      if (fresh.length && fresh.every((o) => isOld(o.orderedAt))) break;
      if (!fresh.length && pages > 1) break;
      if (!page.next) break;
      if (pages >= MAX_PAGES) { atPageCap = true; break; }

      try {
        page = await readListPage(site, page.next);
      } catch {
        break; // 下一頁讀不到就停在這裡，已經掃到的照樣可用
      }
    }

    return { site, orders: kept, scanned, pages, atPageCap };
  }

  /* ---------- 主流程 ---------- */

  /* 給 popup 勾選用的清單：只有列表頁上就看得到的欄位，不讀詳細頁。
   * trackingIds 在 Shopify 與楽天英文介面會是空的（要讀詳細頁才知道），
   * 所以空的不代表沒有伝票番号 —— needsLookup 為真就是「還不知道」 */
  const summarize = (order) => ({
    orderId: order.orderId,
    orderedAt: order.orderedAt ?? null,
    // 兩個都是 false 就是「日期不明」：既不預設勾選，也不該藏起來
    recent: isRecent(order.orderedAt),
    old: isOld(order.orderedAt),
    total: order.total ?? null,
    currency: order.currency,
    trackingIds: order.shipments.map((s) => s.trackingId).filter(Boolean),
    itemCount: order.shipments.reduce((n, s) => n + s.items.length, 0),
    needsLookup: order.lookups.length > 0,
  });

  // preview 掃到的訂單留著給 scrape 用 —— 勾選的可能來自第 2、3 頁，重新解析目前這一頁會找不到
  let lastScan = null;

  async function preview() {
    const { site, orders, scanned, pages, atPageCap } = await scanOrders();
    lastScan = { pageUrl: location.href, orders };
    return {
      ok: true,
      site: site.name,
      label: site.label,
      recentDays: RECENT_DAYS,
      scanned,
      pages,
      atPageCap,
      orders: orders.map(summarize),
    };
  }

  // orderIds：popup 勾選的那幾筆。沒指定就全部擷取
  async function scrape({ withLookups = true, orderIds = null } = {}) {
    const site = currentSite();
    if (!site) throw new Error('目前頁面不是支援的訂單列表頁');

    // preview 剛掃過而且涵蓋了勾選的那幾筆，就沿用 —— 不必為了第 2 頁的訂單再翻一次
    const cached = lastScan?.pageUrl === location.href ? lastScan.orders : null;
    const covered = cached && (!orderIds || orderIds.every((id) => cached.some((o) => o.orderId === id)));
    const found = covered ? cached : (await scanOrders()).orders;

    const orders = orderIds ? found.filter((o) => orderIds.includes(o.orderId)) : found;
    progress({ phase: 'parsed', orders: orders.length });

    if (withLookups && orders.length) await runLookups(orders);

    // 一個包裹一筆：同一筆訂單有多個包裹時，注文番号與合計會重複出現
    const entries = orders.flatMap(({ orderId, orderedAt, total, currency, shipments }) =>
      shipments.map(({ carrier, trackingId, items }) =>
        ({ orderId, orderedAt, total, currency, carrier, trackingId, items })));

    const result = {
      ok: true,
      site: site.name,
      version: chrome.runtime.getManifest().version,
      scrapedAt: new Date().toISOString(),
      pageUrl: location.href,
      orders: entries,
    };
    // popup 可能在擷取途中被關掉，先存起來，重開時仍看得到結果
    await chrome.storage.local.set({ lastResult: result }).catch(() => {});
    return result;
  }

  /* ---------- 訊息 ---------- */

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.type) {
      case 'PING': {
        const site = currentSite();
        sendResponse({
          ok: true,
          version: chrome.runtime.getManifest().version,
          onOrderPage: !!site,
          site: site?.name || null,
          label: site?.label || null,
        });
        return false;
      }
      case 'PREVIEW':
        preview()
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true; // 非同步回覆（可能要翻頁）
      case 'SCRAPE':
        scrape(msg.payload)
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true; // 非同步回覆
      default:
        return false;
    }
  }

  // 擴充功能重新載入後，分頁裡可能還留著舊版的監聽器；先移除再註冊新版，
  // 避免舊程式繼續回應，也避免重複注入時註冊兩次
  try { chrome.runtime.onMessage.removeListener(globalThis.__orderScraperListener); } catch { /* 舊的已失效 */ }
  globalThis.__orderScraperListener = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);
})();
