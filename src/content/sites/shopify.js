/* Shopify 商店的訂單歷史（classic customer accounts：/account）
 *
 * 一個轉接層吃下所有 Shopify 商店 —— 站台是用頁面特徵判斷的，不是網域白名單，
 * 所以新增一家 Shopify 店不必改程式。
 *
 * 版面依據 Dawn（Shopify 官方開源佈景主題）的 sections/main-account.liquid
 * 與 main-order.liquid。重點是 Dawn 用 id / headers 屬性標示欄位
 * （ColumnOrder、ColumnTotal、ColumnQuantity、RowTotal…），這些屬性**不會被翻譯**，
 * 所以多語系不必比對字樣。其他佈景主題可能改過版面，因此每個欄位都再退一層結構判斷。
 *
 * 訂單列表只有注文番号 / 日期 / 狀態 / 合計，沒有商品與配送資訊，
 * 所以這一頁上的每筆訂單都要讀一次詳細頁。那些頁面是伺服器渲染的，用 fetch 就夠（不必 iframe）。
 */
(() => {
  'use strict';
  const { clean, textOf, attr, all, parseMoney, parseDate, absUrl, nextPageLink, bumpPageParam,
    climbUnique, countMatches } = globalThis.OrderScraper.util;

  const SEL = {
    orderTable: 'table.order-history',
    orderLink: 'a[href*="/account/orders/"]',
    total: 'td[headers~="ColumnTotal"]',
    time: 'time[datetime]',
    signIn: 'form[action*="/account/login"]',
  };

  /* 多語系商店的路徑會帶語系前綴：/zh-hant/account、/zh-hans/account、/en/account。
   * 前綴是 Shopify 的「語系網址代碼」，不一定是兩個字母（zh-hant 就不是），
   * 所以不能寫死成 [a-z]{2}。?page=N 是查詢字串，不影響 pathname。 */
  const ACCOUNT_PATH_RE = /^\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})*\/)?account(?:\/orders)?\/?$/i;

  // 是不是 Shopify 站：看頁面特徵，不看網域。
  // 先用選擇器（快），都沒中才掃行內 script —— 不要序列化整份 DOM
  const isShopify = (doc) =>
    !!doc.querySelector([
      'link[href*="cdn.shopify.com"]',
      'script[src*="cdn.shopify.com"]',
      'meta[name="shopify-digital-wallet"]',
      'meta[name="shopify-checkout-api-token"]',
    ].join(','))
    || all(doc, 'script:not([src])').some((el) => /Shopify\.(shop|theme)\s*=/.test(el.textContent));

  /* ---------- 訂單列表 ---------- */

  // 以「連到訂單詳細頁的連結」為錨點：任何佈景主題都會有這個連結
  function findCards(doc) {
    const root = doc.querySelector(SEL.orderTable) || doc.body;
    const links = all(root, SEL.orderLink);
    const seen = new Set();
    const cards = [];
    for (const link of links) {
      const href = attr(link, 'href');
      if (!href || seen.has(href)) continue;
      seen.add(href);
      // 往上爬到仍然只含這一筆訂單的範圍（Dawn 是 <tr>）
      const card = link.closest('tr') || climbUnique(link, root, countMatches(SEL.orderLink));
      cards.push({ orderId: textOf(link).replace(/^#/, ''), href, card });
    }
    return cards;
  }

  // 合計：Dawn 標了 headers="… ColumnTotal"；其他主題退回該列最後一個含金額的欄位。
  // 退回時一定要有幣別標記 —— 不然日期欄的「2024年12月28日」會被當成金額 2024
  const MONEY_TEXT_RE = /[¥￥]|JPY|円/i;
  const orderTotal = (card) => {
    const labelled = parseMoney(textOf(card.querySelector(SEL.total)));
    if (labelled != null) return labelled;
    const cell = all(card, 'td, div').reverse().find((el) => MONEY_TEXT_RE.test(textOf(el)) && parseMoney(textOf(el)) != null);
    return parseMoney(textOf(cell));
  };

  /* ---------- 組合 ---------- */

  // 一個伝票番号就是一個包裹：同一筆訂單裡追蹤號相同的商品歸成一筆。
  // 沒有追蹤號的商品不輸出（跟其他站台一致：只擷取配送中的）
  function toShipments(items) {
    const byTracking = new Map();
    for (const { carrier, trackingId, title, quantity, imageUrl } of items) {
      if (!trackingId) continue;
      if (!byTracking.has(trackingId)) byTracking.set(trackingId, { carrier, trackingId, items: [] });
      byTracking.get(trackingId).items.push({ title, quantity, imageUrl });
    }
    return [...byTracking.values()];
  }

  /* 注文日：<time datetime="2026-10-05T14:53:07Z">2026年10月5日</time>，兩種佈景主題都有。
   * 先讀顯示的文字（那是商店所在時區的日期），認不得才退回 datetime —— datetime 是 UTC，
   * 日本時間凌晨下的單換算成 UTC 會變成前一天 */
  const orderDate = (card) => {
    const el = card.querySelector(SEL.time);
    return parseDate(textOf(el)) ?? parseDate(attr(el, 'datetime'));
  };

  function buildOrder({ orderId, href, card }, baseUrl) {
    const order = { orderId, orderedAt: orderDate(card), total: orderTotal(card),
      currency: 'JPY', shipments: [], lookups: [] };
    order.lookups.push({
      url: absUrl(href, baseUrl),
      reader: 'shopifyOrder',
      via: 'fetch', // 伺服器渲染，不必用 iframe
      apply: (info) => {
        if (info.total != null) order.total = info.total;
        order.shipments = toShipments(info.items || []);
      },
    });
    return order;
  }

  globalThis.OrderScraper.sites.push({
    name: 'shopify',
    label: 'Shopify 商店',
    isOrderPage: (loc, doc) => ACCOUNT_PATH_RE.test(loc.pathname) && isShopify(doc),
    isSignInPage: (doc, url) => /\/account\/login/.test(url) || !!doc.querySelector(SEL.signIn),
    /* 佈景主題有畫分頁就照著走；沒有的話直接把 ?page=N 加一 —— Shopify 的帳戶頁一律吃這個參數。
     * 加過頭也不會有事：回來的是同一頁或空頁，上層發現沒有新的注文番号就會停。
     * 訂單頁是伺服器渲染的，用 fetch 就夠 */
    nextPage: (doc, pageUrl) => {
      const url = nextPageLink(doc, pageUrl) || bumpPageParam(pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) => findCards(doc).map((card) => buildOrder(card, pageUrl)),
  });
})();
