/* アニメイト通販（www.animate-onlineshop.jp）のご注文履歴（/mypage/history.php）
 *
 * 這個站台跟タワーレコード一樣**不必另外載入任何頁面**：注文番号 / 注文日 / 配送伝票番号 /
 * 出貨進度 / 商品與件數 / 合計 全都在列表頁上（合計在預設收合的「注文の詳細」裡，HTML 裡已經有了）。
 * 頁面是伺服器渲染的 PHP，下一頁用 fetch 取回就好。
 */
(() => {
  'use strict';
  const { clean, textOf, attr, all, parseMoney, parseDate, carrierOf, absUrl, nextPageLink } = globalThis.OrderScraper.util;

  const SEL = {
    order: '.order_histories .order',
    orderId: '.order_id',                        // <p class="order_id"><span>注文番号　</span>55797386</p>
    orderedAt: '.order__date',                   // 「注文日　2026/09/18」
    slip: '.order_slip_number a',                // 配送伝票番号：連結文字是番号，查詢網址寫在 onclick 裡
    timeline: '.order-tracking__timeline',       // 注文受付 → お支払い → 商品準備中 → 出荷作業中 → お届け済
    current: 'li.current',
    item: '.order_item',
    title: '.order_item_info h3 a',
    image: '.order_item_image img',
    count: '.order_item_price, .order_item_privilege_quantity',  // 「1点」（商品那邊還有一個「2,200円」）
    // 「この受注に付与される特典」也是一個 .order_item：沒有圖、名稱在另一個地方，會跟著包裹寄來
    privilegeName: '.order_item_privilege_name',
    total: '.order_bill tr.total td',            // 注文合計金額
    next: '.my-pager .next a[href]',             // 「次へ>>」
  };

  /* 已送達 = 進度列的目前這一步（li.current）是最後一步「お届け済」。用結構判斷不看文字 ——
   * 「お届け済」是進度列最後一步的名稱，每一筆訂單的進度列上都有這幾個字。
   * 認不出進度時當成配送中保留 */
  const isDelivered = (order) => {
    const current = order.querySelector(`${SEL.timeline} ${SEL.current}`);
    return !!current && current === current.parentElement.lastElementChild;
  };

  /* 配送伝票番号的連結是 href="#"，真正的查詢網址在 onclick 的 window.open('https://…') 裡。
   * 業者由那個網址的網域判斷（util.carrierOf），認不得就留空 */
  const trackerUrl = (link) => attr(link, 'onclick').match(/https?:\/\/[^'"\s]+/)?.[0] || '';
  const readSlips = (order) =>
    all(order, SEL.slip)
      .map((link) => ({ carrier: carrierOf(trackerUrl(link)), trackingId: textOf(link).replace(/-/g, '') }))
      .filter((s) => /^[A-Za-z0-9]{8,}$/.test(s.trackingId));

  // 件數：「9点」
  const COUNT_RE = /^(\d+)\s*点$/;
  const findItems = (order) =>
    all(order, SEL.item)
      .map((item) => {
        const img = item.querySelector(SEL.image);
        const count = all(item, SEL.count).map((p) => COUNT_RE.exec(textOf(p))?.[1]).find(Boolean);
        return {
          title: textOf(item.querySelector(SEL.title)) || textOf(item.querySelector(SEL.privilegeName)) || clean(attr(img, 'alt')),
          quantity: Number(count) || 1,
          imageUrl: attr(img, 'src') || null,
        };
      })
      .filter((item) => item.title);

  /* 沒有配送伝票番号的（商品入荷待ち等）還沒出貨、「お届け済」的已經送達，兩種都不擷取，
   * 回傳空的訂單（注文日留給翻頁判斷七天的界線）。
   * 一個伝票番号一個包裹；站台不標示哪件商品在哪個包裹，所以每個包裹都掛上全部商品 */
  function buildOrder(order) {
    const slips = isDelivered(order) ? [] : readSlips(order);
    const items = slips.length ? findItems(order) : [];
    return {
      orderId: textOf(order.querySelector(SEL.orderId)).replace(/^注文番号\s*/, ''),
      orderedAt: parseDate(textOf(order.querySelector(SEL.orderedAt))),
      total: parseMoney(textOf(all(order, SEL.total).at(-1))),
      currency: 'JPY',
      shipments: slips.map((slip) => ({ ...slip, items })),
      lookups: [],
    };
  }

  // 用頁面特徵判斷：有訂單、而且訂單裡有注文番号
  const hasOrders = (doc) => !!doc.querySelector(`${SEL.order} ${SEL.orderId}`);

  globalThis.OrderScraper.sites.push({
    name: 'animate',
    label: 'アニメイト通販',
    isOrderPage: (loc, doc) => /(^|\.)animate-onlineshop\.jp$/.test(loc.hostname) && hasOrders(doc),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 分頁是「次へ>>」，通用規則認不得後面的 >>，所以先找這個站台的分頁區塊
    nextPage: (doc, pageUrl) => {
      const url = absUrl(attr(doc.querySelector(SEL.next), 'href'), pageUrl) || nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc) => all(doc, SEL.order).map(buildOrder).filter((o) => /^\d+$/.test(o.orderId)),
  });
})();
