/* にじさんじオフィシャルストア（shop.nijisanji.jp）のご注文履歴（/mypage/order-history）
 *
 * Salesforce Commerce Cloud 的站台（素材路徑是 /on/demandware.static/），伺服器渲染，
 * 注文詳細頁用 fetch 取回就讀得到（讀取器在 readers.js 的 nijisanjiDetail）。
 *
 * 列表頁有：ご注文番号、ご注文日、商品（品名 / 画像），以及**每件商品各自的狀態標籤**
 * （「出荷済み」/「着荷済み」）。配送伝票番号 / 合計 / 数量 只在注文詳細頁。
 * 「着荷済み」就是已送達，所以這個站台擋得掉已送達的訂單。
 */
(() => {
  'use strict';
  const { textOf, all, parseDate, absUrl, nextPageLink } = globalThis.OrderScraper.util;

  const SEL = {
    order: '.order-history-list > li',
    orderId: '.order-history-status-id',       // 「ご注文番号　SN000012372064」
    orderedAt: '.order-history-date',          // 「2026年07月22日 19:48」
    label: '.label-list .label',               // 每件商品的狀態。class 都是 label-gray，只能看文字
    detailLink: 'a[href*="/order-history/detail"]',
  };

  // 注文番号實際看過兩種：SN000012372064（2026 年）、N2206240877900（2022 年）
  const ORDER_ID_RE = /[A-Z]*\d{8,}/;
  const SHIPPED_RE = /出荷済/;
  const DELIVERED_RE = /着荷済/;

  /* 狀態看的是這筆訂單裡**所有**商品的標籤：
   *   全部「着荷済み」     → 已送達，不擷取
   *   有任何「出荷済み」   → 出貨了，讀詳細頁
   *   其他（沒有標籤、或沒看過的字樣）→ 認不出來，照樣讀詳細頁，有伝票番号就列 */
  function statusOf(li) {
    const labels = all(li, SEL.label).map(textOf).filter(Boolean);
    if (labels.length && labels.every((t) => DELIVERED_RE.test(t))) return 'delivered';
    if (labels.some((t) => SHIPPED_RE.test(t))) return 'shipped';
    return 'unknown';
  }

  /* 已送達的回傳空的訂單（注文日留給翻頁判斷七天的界線）。
   * 出荷済み的先放一個空的包裹：詳細頁讀不到時，它會被算進「讀不到配送資料」，不會無聲消失。
   * 認不出狀態的不放 —— 那多半是還沒出貨，不該被報成「讀不到」 */
  function buildOrder(li, pageUrl) {
    const orderId = textOf(li.querySelector(SEL.orderId)).match(ORDER_ID_RE)?.[0] || '';
    const order = {
      orderId,
      orderedAt: parseDate(textOf(li.querySelector(SEL.orderedAt))),
      total: null,
      currency: 'JPY',
      shipments: [],
      lookups: [],
    };
    const status = statusOf(li);
    const detail = absUrl(li.querySelector(SEL.detailLink)?.getAttribute('href'), pageUrl);
    if (status === 'delivered' || !detail) return order;

    if (status === 'shipped') order.shipments = [{ carrier: '', trackingId: '', items: [] }];
    order.lookups.push({
      url: detail,
      reader: 'nijisanjiDetail',
      via: 'fetch',
      // 站台不標示哪件商品在哪個包裹，所以每個包裹都掛上全部商品
      apply: (info) => {
        order.total = info.total ?? null;
        if (info.trackingIds.length) {
          order.shipments = info.trackingIds.map((trackingId) => ({ carrier: '', trackingId, items: info.items }));
        }
      },
    });
    return order;
  }

  // 用頁面特徵判斷：有訂單列表、而且列表裡有連到注文詳細頁的連結
  const hasOrders = (doc) => !!doc.querySelector(`${SEL.order} ${SEL.detailLink}`);

  globalThis.OrderScraper.sites.push({
    name: 'nijisanji',
    label: 'にじさんじオフィシャルストア',
    isOrderPage: (loc, doc) => /(^|\.)shop\.nijisanji\.jp$/.test(loc.hostname) && hasOrders(doc),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 實際的分頁還沒看過（列表帶 data-show-count="12"，可能是「もっと見る」按鈕）。先走通用規則
    nextPage: (doc, pageUrl) => {
      const url = nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) =>
      all(doc, SEL.order).map((li) => buildOrder(li, pageUrl)).filter((o) => o.orderId),
  });
})();
