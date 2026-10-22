/* 擷取流程（各站台共用）。popup 一打開就整套跑完，表格上看到的就是最終結果：
 *   1. 掃描訂單列表，必要時自動往後翻頁
 *   2. 七天內、而且有東西可擷取的訂單，讀取需要另外載入的頁面（配送資料 / 合計）
 *   3. 只交出有 tracking ID 的包裹
 *
 * 這個擴充功能只要**配送中**的訂單。已送達的在認得出來的站台上由各站台的轉接層擋掉；
 * 認不出來的站台（Shopify、楽天英文介面）改用「下單未滿七天」當替代條件。
 * 翻頁也停在這條線上 —— 訂單列表都是新到舊排的，看到第一筆超過七天的就不必再往下。 */
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

  // 日期不明的不算舊 —— 站台改版導致日期抓不到時，訂單不該整批無聲消失
  const isOld = (orderedAt, recentDays) => orderedAt != null && daysAgo(orderedAt) >= recentDays;

  /* ---------- 需要真的載入才讀得到的頁面 ---------- */

  // 另外載入的頁面分兩種讀法，由站台指定 via：
  //   'frame'（預設）前端渲染的頁面，要讓瀏覽器真的跑完 JS，用隱藏 iframe
  //   'fetch'         伺服器就渲染好的頁面（例如 Shopify 的訂單頁），抓回來解析即可，快得多
  //                   post 有給時用 POST 送出（詳細頁是用表單打開的站台，例如 mu-mo）
  // read 一律在頁面還活著的時候跑完 —— iframe 讀完就會被移除，不能把 document 帶出來
  async function withPage(url, via, read, post) {
    if (via === 'fetch') {
      const { doc } = await fetchDoc(url, post);
      return read(doc);
    }
    return readInFrame(url, read);
  }

  async function readPage({ url, reader, via, post }) {
    try {
      const info = await withPage(url, via, (doc) => readers[reader](doc), post);
      // iframe 被擋下時就放棄這一頁，相關欄位留空，不另開分頁
      return info || { ok: false, error: '頁面無法在 iframe 內載入' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // 同一個請求（網址＋POST 內容）只讀一次，所有請求同時讀取
  async function runLookups(orders) {
    const byKey = new Map();
    for (const { apply, ...page } of orders.flatMap((o) => o.lookups)) {
      const key = `${page.url}\n${page.post ?? ''}`;
      if (!byKey.has(key)) byKey.set(key, { page, waiting: [] });
      byKey.get(key).waiting.push(apply);
    }

    const total = byKey.size;
    let done = 0;
    progress({ phase: 'lookup', done, total });
    await Promise.all([...byKey.values()].map(async ({ page, waiting }) => {
      const info = await readPage(page);
      progress({ phase: 'lookup', done: ++done, total });
      // 讀失敗或需要重新登入的頁面，相關欄位留空
      if (info.ok) for (const apply of waiting) apply(info);
    }));
  }

  /* ---------- 掃描訂單列表 ---------- */

  // 各站台對「不擷取」的訂單（已送達、沒有伝票番号）回傳空的訂單而不是 null ——
  // 那些訂單的注文日翻頁時還用得到
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
   *   - 這一頁出現超過七天的訂單（列表是新到舊排的，再往後只會更舊）
   *   - 沒有下一頁的連結（或站台沒有實作）
   *   - 翻到的頁面沒有新的注文番号（重複或空頁）
   *   - 到達 MAX_PAGES
   * 「超過七天」看的是**每一筆**訂單，包括已送達、沒伝票番号這些不擷取的 ——
   * 不然界線剛好落在一串已送達的訂單上時，會白翻下一頁。
   * 翻頁失敗不算錯誤：把已經掃到的交出去就好。 */
  async function scanOrders(site, recentDays) {
    const seen = new Set();
    const scanned = [];
    let pages = 0;
    let atPageCap = false;
    // 第一頁用使用者眼前這一份 document，不重新載入
    let page = { orders: parseOrders(site, document, location.href), next: site.nextPage?.(document, location.href) || null };

    while (page) {
      pages += 1;
      // 同一筆注文番号在頁面上可能出現多次（桌機 / 手機版版面），也可能跨頁重複
      const fresh = page.orders.filter((o) => !seen.has(o.orderId) && seen.add(o.orderId));
      scanned.push(...fresh);
      progress({ phase: 'scan', pages });

      if (fresh.some((o) => isOld(o.orderedAt, recentDays))) break;
      if (!fresh.length && pages > 1) break;
      if (!page.next) break;
      if (pages >= MAX_PAGES) { atPageCap = true; break; }

      try {
        page = await readListPage(site, page.next);
      } catch {
        break; // 下一頁讀不到就停在這裡，已經掃到的照樣可用
      }
    }
    return { scanned, pages, atPageCap };
  }

  /* ---------- 主流程 ---------- */

  const hasWork = (order) => order.shipments.length > 0 || order.lookups.length > 0;

  // recentDays 平常不用給。測試會傳 Infinity 關掉七天的規則 —— fixture 都是幾週前擷取的
  async function run({ withLookups = true, recentDays } = {}) {
    const days = recentDays > 0 ? recentDays : RECENT_DAYS;
    const site = currentSite();
    if (!site) throw new Error('目前頁面不是支援的訂單列表頁');
    if (site.isSignInPage(document, location.href)) {
      throw new Error('需要重新登入，請在分頁登入後再試一次');
    }

    // 列表頁上沒有注文日、要一筆一筆點開才知道的站台（ちいかわくじ）自己掃描，七天的界線照樣由這裡給
    const { scanned, pages, atPageCap } = site.scan
      ? await site.scan({ isOld: (orderedAt) => isOld(orderedAt, days), progress })
      : await scanOrders(site, days);
    // 只有七天內、而且有東西可擷取的才去讀詳細頁 —— 舊訂單讀了也不會列出來
    const orders = scanned.filter((o) => !isOld(o.orderedAt, days) && hasWork(o));
    progress({ phase: 'parsed', orders: orders.length });

    if (withLookups && orders.length) await runLookups(orders);

    // 一個包裹一筆：同一筆訂單有多個包裹時，注文番号與合計會重複出現
    const parcels = orders.flatMap(({ orderId, orderedAt, total, currency, shipments }) =>
      shipments.map(({ carrier, trackingId, items }) =>
        ({ orderId, orderedAt, total, currency, carrier, trackingId, items })));
    // 只交出有 tracking ID 的。配送中卻讀不到 ID 的（例如配送狀況頁被擋下）不列，但要報個數
    const withTracking = parcels.filter((p) => p.trackingId);

    return {
      ok: true,
      site: site.name,
      version: chrome.runtime.getManifest().version,
      scrapedAt: new Date().toISOString(),
      pageUrl: location.href,
      recentDays: days,
      pages,
      atPageCap,
      missingTracking: parcels.length - withTracking.length,
      orders: withTracking,
    };
  }

  // popup 關掉再打開時，上一次還沒跑完的就接著等，不要再開一批 iframe
  let inflight = null;
  const scrape = (payload) => (inflight ??= run(payload).finally(() => { inflight = null; }));

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
