/* OFFICIAL GOODS STORE（official-goods-store.jp）の注文履歴
 *
 * 一個網域底下好幾家店，路徑帶店名（/parkeunbin/mypage/…）。伺服器渲染（jQuery 的舊式頁面）。
 * 列表頁一筆訂單一張卡片，整張是連到注文詳細（/{店}/mypage/order/detail/{受注番号}）的連結：
 * ご注文状況（「注文確定」）、注文日時、受注番号、總額。
 * **配送狀態只在詳細頁**（讀取器在 readers.js 的 ogsDetail），所以七天內的每一筆都要讀詳細頁。
 * 配送状況只看過「出荷済み」（三個月前的訂單也還是），沒有送達的狀態，跟 Shopify 一樣只靠七天。
 */
(() => {
  'use strict';
  const { textOf, attr, all, parseDate, parseMoney, absUrl, nextPageLink } = globalThis.OrderScraper.util;

  const SEL = {
    card: 'a[href*="/mypage/order/detail/"]',  // 一筆訂單（詳細頁上沒有這種連結）
  };
  const ID_RE = /\/mypage\/order\/detail\/([^/?#]+)/;
  const ORDERED_RE = /に注文$/;                // 「2026-07-30 16:04:40に注文」
  const MONEY_RE = /^[¥￥]\s*[\d,]+$/;         // 「¥14,280」

  function buildOrder(card, pageUrl) {
    const href = attr(card, 'href');
    const texts = all(card, 'p').map(textOf);
    const order = {
      orderId: ID_RE.exec(href)?.[1] || '',
      orderedAt: parseDate(texts.find((t) => ORDERED_RE.test(t))),
      total: parseMoney(texts.find((t) => MONEY_RE.test(t))),
      currency: 'JPY',
      /* 列表上看不出寄出了沒：先放一個空的包裹，詳細頁讀到了就換成實際的（還沒寄出的話一個都沒有）；
       * 讀不到時它留著，會被算進「讀不到配送資料」 */
      shipments: [{ carrier: '', trackingId: '', items: [] }],
      lookups: [],
    };
    order.lookups.push({
      url: absUrl(href, pageUrl),
      reader: 'ogsDetail',
      via: 'fetch',
      apply: (info) => { order.shipments = info.parcels; },
    });
    return order;
  }

  globalThis.OrderScraper.sites.push({
    name: 'officialgoods',
    label: 'OFFICIAL GOODS STORE',
    isOrderPage: (loc, doc) => /(^|\.)official-goods-store\.jp$/.test(loc.hostname) && !!doc.querySelector(SEL.card),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 實際的分頁還沒看過（給的片段只有一筆），先走通用規則
    nextPage: (doc, pageUrl) => {
      const url = nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) => all(doc, SEL.card).map((card) => buildOrder(card, pageUrl)).filter((o) => o.orderId),
  });
})();
