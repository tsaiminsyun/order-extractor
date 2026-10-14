/* 擷取流程（各站台共用）：解析目前這一頁 → 讀取需要另外載入的頁面（配送資料 / 合計）。
 * 只擷取使用者正在看的那一頁，不會自動翻頁。 */
(() => {
  'use strict';
  const { sites, readers, util } = globalThis.OrderScraper;
  const { fetchDoc, readInFrame } = util;

  const currentSite = () => sites.find((s) => s.isOrderPage(location, document));

  function progress(payload) {
    chrome.runtime.sendMessage({ type: 'SCRAPE_PROGRESS', ...payload }).catch(() => {});
  }

  /* ---------- 需要真的載入才讀得到的頁面 ---------- */

  // 另外載入的頁面分兩種讀法，由站台在 lookup 上指定 via：
  //   'frame'（預設）前端渲染的頁面，要讓瀏覽器真的跑完 JS，用隱藏 iframe
  //   'fetch'         伺服器就渲染好的頁面（例如 Shopify 的訂單頁），抓回來解析即可，快得多
  async function readPage(url, reader, via) {
    if (via === 'fetch') {
      try {
        const { doc } = await fetchDoc(url);
        return await readers[reader](doc);
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }
    // iframe 被擋下時就放棄這一頁，相關欄位留空，不另開分頁
    return (await readInFrame(url, (doc) => readers[reader](doc))) || { ok: false, error: '頁面無法在 iframe 內載入' };
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

  /* ---------- 主流程 ---------- */

  // 解析目前這一頁，還不讀任何另外的頁面。只看使用者眼前這一頁 ——
  // 要抓別頁就自己翻到那一頁再按一次
  function candidates() {
    const site = currentSite();
    if (!site) throw new Error('目前頁面不是支援的訂單列表頁');
    if (site.isSignInPage(document, location.href)) {
      throw new Error('需要重新登入，請在分頁登入後再試一次');
    }
    const found = site.findOrders(document, location.href).filter(Boolean);
    // 同一筆注文番号在頁面上可能出現多次（桌機 / 手機版版面），只留第一筆
    const seen = new Set();
    return { site, orders: found.filter((o) => !seen.has(o.orderId) && seen.add(o.orderId)) };
  }

  /* 給 popup 勾選用的清單：只有列表頁上就看得到的欄位，不讀詳細頁。
   * trackingIds 在 Shopify 與楽天英文介面會是空的（要讀詳細頁才知道），
   * 所以空的不代表沒有伝票番号 —— needsLookup 為真就是「還不知道」 */
  const summarize = (order) => ({
    orderId: order.orderId,
    orderedAt: order.orderedAt ?? null,
    total: order.total ?? null,
    currency: order.currency,
    trackingIds: order.shipments.map((s) => s.trackingId).filter(Boolean),
    itemCount: order.shipments.reduce((n, s) => n + s.items.length, 0),
    needsLookup: order.lookups.length > 0,
  });

  function preview() {
    const { site, orders } = candidates();
    return { ok: true, site: site.name, label: site.label, orders: orders.map(summarize) };
  }

  // orderIds：popup 勾選的那幾筆。沒指定就全部擷取
  async function scrape({ withLookups = true, orderIds = null } = {}) {
    const { site, orders: found } = candidates();
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
        try {
          sendResponse(preview());
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return false;
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
