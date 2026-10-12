/* 擷取流程（各站台共用）：翻頁 → 解析訂單 → 讀取需要另外載入的頁面（配送資料 / 合計） */
(() => {
  'use strict';
  const { sites, readers, util } = globalThis.OrderScraper;
  const { sleep, fetchDoc, readInFrame } = util;

  const MAX_PAGES = 50;  // 安全上限，避免無限翻頁
  const DELAY_MS = 400;  // 翻頁之間的間隔，避免被判定為機器人

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

  async function scrape({ maxPages = MAX_PAGES, delayMs = DELAY_MS, withLookups = true } = {}) {
    const site = currentSite();
    if (!site) throw new Error('目前頁面不是支援的訂單列表頁');

    const orders = [];              // 擷取到的訂單
    const seenOrderIds = new Set(); // 已處理過的注文番号（含略過的）
    const visitedUrls = new Set();

    const first = site.firstPage(location);
    let url = first.url;
    let page = 0;
    while (url && page < maxPages && !visitedUrls.has(url)) {
      visitedUrls.add(url);
      page += 1;
      progress({ phase: 'fetching', page, orders: orders.length });

      // 目前分頁就是第一頁時直接用現有 DOM，不必再發 request
      let loaded;
      try {
        loaded = page === 1 && first.useCurrent ? { doc: document, url: location.href } : await fetchDoc(url);
      } catch (err) {
        if (page === 1) throw err;
        break; // 後面的頁讀取失敗時，保留已取得的訂單
      }
      const { doc, url: pageUrl } = loaded;

      if (site.isSignInPage(doc, pageUrl)) {
        if (page === 1) throw new Error('需要重新登入，請在分頁登入後再試一次');
        break;
      }

      const found = site.findOrders(doc, pageUrl);
      if (!found.length) break;

      const fresh = found.filter((o) => o && !seenOrderIds.has(o.orderId));
      if (!fresh.length) break; // 同樣的一頁重複出現，停止
      for (const order of fresh) {
        seenOrderIds.add(order.orderId);
        orders.push(order);
      }
      progress({ phase: 'parsed', page, orders: orders.length });

      url = site.nextPageUrl(doc, pageUrl, found.length);
      if (url) await sleep(delayMs);
    }

    if (withLookups && orders.length) await runLookups(orders);

    // 一個包裹一筆：同一筆訂單有多個包裹時，注文番号與合計會重複出現
    const entries = orders.flatMap(({ orderId, total, currency, shipments }) =>
      shipments.map(({ carrier, trackingId, items }) =>
        ({ orderId, total, currency, carrier, trackingId, items })));

    const result = {
      ok: true,
      site: site.name,
      version: chrome.runtime.getManifest().version,
      scrapedAt: new Date().toISOString(),
      pages: page,
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
