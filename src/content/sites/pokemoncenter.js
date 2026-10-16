/* ポケモンセンターオンライン（www.pokemoncenter-online.com）の注文履歴
 *
 * Salesforce Commerce Cloud 的站台，頁面是伺服器渲染的（HTML 裡有伺服器輸出的 dwMarker 註解），
 * 所以注文詳細頁用 fetch 取回就讀得到，不必開 iframe。
 *
 * 列表頁有：注文番号、注文日、出貨進度（注文受付済み → 発送準備中 → 発送済み）、第一件商品。
 * 送り状番号 / 合計 / 全部商品與個数 只在注文詳細頁（讀取器在 readers.js 的 pokemonDetail）。
 *
 * 進度最多到「発送済み」，**沒有送達狀態** —— 已送達的分不出來，只能靠七天擋（跟 Shopify 一樣）。
 */
(() => {
  'use strict';
  const { textOf, all, parseDate, absUrl, nextPageLink } = globalThis.OrderScraper.util;

  const SEL = {
    order: '.comOrderList > li',
    orderId: '.number span',     // <p class="number">注文番号<span>3000017771706</span></p>
    orderedAt: '.time',          // <p class="time">2026年09月 10日（木）<span>10時17分</span></p>
    status: '.comReceiptBox',    // 出貨進度。発送済み時多一個 .sent
    steps: '.txtList li',        // 注文受付済み / 発送準備中 / 発送済み，目前這一步有 .finish
    detailLink: 'a[href*="/order-details/"]',
  };

  /* 発送済み：進度區塊帶 .sent，或「目前這一步」（.finish）是最後一步。
   * 實際頁面上兩個記號一起出現；任一個在就算，版面小改時比較不會漏 */
  function isShipped(li) {
    if (li.querySelector(SEL.status)?.classList.contains('sent')) return true;
    const steps = all(li, SEL.steps);
    return steps.length > 0 && steps.at(-1).classList.contains('finish');
  }

  /* 還沒出貨的不擷取（回傳空的訂單，注文日留給翻頁判斷七天的界線）。
   * 発送済み的先放一個空的包裹，送り状番号等詳細頁讀回來再填 ——
   * 詳細頁讀不到時，這個包裹會被算進「讀不到配送資料」，不會無聲消失 */
  function buildOrder(li, pageUrl) {
    const orderId = textOf(li.querySelector(SEL.orderId));
    const order = {
      orderId,
      orderedAt: parseDate(textOf(li.querySelector(SEL.orderedAt))),
      total: null,
      currency: 'JPY',
      shipments: [],
      lookups: [],
    };
    const detail = absUrl(li.querySelector(SEL.detailLink)?.getAttribute('href'), pageUrl);
    if (!isShipped(li) || !detail) return order;

    order.shipments = [{ carrier: '', trackingId: '', items: [] }];
    order.lookups.push({
      url: detail,
      reader: 'pokemonDetail',
      via: 'fetch',
      // 一個送り状番号一個包裹。站台不標示哪件商品在哪個包裹，所以每個包裹都掛上全部商品
      apply: (info) => {
        order.total = info.total ?? null;
        if (info.shipments.length) order.shipments = info.shipments.map((s) => ({ ...s, items: info.items }));
      },
    });
    return order;
  }

  // 用頁面特徵判斷，不寫死路徑：有訂單列表、而且列表裡有連到注文詳細頁的連結
  const hasOrders = (doc) => !!doc.querySelector(`${SEL.order} ${SEL.detailLink}`);

  globalThis.OrderScraper.sites.push({
    name: 'pokemoncenter',
    label: 'ポケモンセンターオンライン',
    isOrderPage: (loc, doc) => /(^|\.)pokemoncenter-online\.com$/.test(loc.hostname) && hasOrders(doc),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 伺服器渲染，下一頁用 fetch 取回就好。實際的分頁版面還沒看過，走通用規則
    nextPage: (doc, pageUrl) => {
      const url = nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) =>
      all(doc, SEL.order).map((li) => buildOrder(li, pageUrl)).filter((o) => o.orderId),
  });
})();
