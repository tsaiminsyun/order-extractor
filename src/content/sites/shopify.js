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
  const { clean, textOf, attr, all, parseMoney, absUrl, climbUnique, countMatches } = globalThis.OrderScraper.util;

  const SEL = {
    orderTable: 'table.order-history',
    orderLink: 'a[href*="/account/orders/"]',
    total: 'td[headers~="ColumnTotal"]',
    signIn: 'form[action*="/account/login"]',
  };

  // 訂單列表可能帶 ?page=N，那是查詢字串不影響 pathname
  const ACCOUNT_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?account(?:\/orders)?\/?$/i;

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

  // 合計：Dawn 標了 headers="… ColumnTotal"；其他主題退回該列最後一個含金額的欄位
  const orderTotal = (card) =>
    parseMoney(textOf(card.querySelector(SEL.total)))
    ?? parseMoney(textOf(all(card, 'td, div').reverse().find((el) => parseMoney(textOf(el)))));

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

  function buildOrder({ orderId, href, card }, baseUrl) {
    const order = { orderId, total: orderTotal(card), currency: 'JPY', shipments: [], lookups: [] };
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
    orderListUrl: '/account',
    isOrderPage: (loc, doc) => ACCOUNT_PATH_RE.test(loc.pathname) && isShopify(doc),
    isSignInPage: (doc, url) => /\/account\/login/.test(url) || !!doc.querySelector(SEL.signIn),
    findOrders: (doc, pageUrl) => findCards(doc).map((card) => buildOrder(card, pageUrl)),
  });
})();
