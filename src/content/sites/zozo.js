/* ZOZOTOWN（zozo.jp）の注文履歴（default.html）
 *
 * 列表頁**一個區塊（.orderList）是一個包裹**，不是一筆訂單：
 *   - 一筆訂單的好幾件商品可以在同一個包裹裡
 *   - 好幾筆訂單也可以合併成一個包裹（「まとめて発送」）
 * 包裹的狀態（発送準備中 → 発送処理中 → 発送済み → 配達中 → 配達完了）、商品、所屬訂單都在列表頁；
 * 伝票番号與合計只在注文詳細頁（讀取器在 readers.js 的 zozoDetail），伺服器渲染，用 fetch 讀。
 *
 * 輸出還是「一筆訂單底下幾個包裹」：合併寄送的包裹，每筆訂單各一列、伝票番号相同、
 * 商品只放那筆訂單自己的。
 */
(() => {
  'use strict';
  const { textOf, attr, all, parseDate, absUrl, nextPageLink } = globalThis.OrderScraper.util;

  const SEL = {
    pack: '.orderList',                          // 一個包裹
    status: '.orderDetailHeader-h',              // 目前狀態（一個標籤，不是進度列上那一串步驟名稱）
    steps: '.delivery-info__status',             // data-step="4" data-max-step="5"（9 月以前的包裹沒有）
    row: '.orderDetailBody table.orderDetail tr',
    goods: 'td.goodsBox',                        // 一件商品
    orderCell: 'td.orderTime',                   // 這一列開始是哪一筆訂單：注文日 / 注文番号 / 詳細頁連結
    detailLink: 'a[href*="detail.html?oid="]',
    brand: '.brandName',
    name: '.itemName',
    variant: '.colorName',                       // 「インディゴブルー / FREE」
    price: '.tax',                               // 「税込 / 数量：1」
    image: '.thumb .img img',
    next: '.pager li.next a[href]',              // 下一頁：只有圖示沒有文字，通用規則認不得
  };

  /* 已送達：目前狀態是「配達完了」，或進度列走到最後一步。
   * 這裡比對文字是安全的 —— .orderDetailHeader-h 只放目前的狀態，不是步驟名稱的清單 */
  function isDelivered(pack) {
    if (/配達完了/.test(textOf(pack.querySelector(SEL.status)))) return true;
    const steps = pack.querySelector(SEL.steps);
    const step = Number(attr(steps, 'data-step'));
    return step > 0 && step >= Number(attr(steps, 'data-max-step'));
  }

  // 品名帶上品牌與顏色 / 尺寸 —— 衣服同一款會有好幾個顏色尺寸，WMS 要對得出是哪一件
  const QTY_RE = /数量\s*[:：]\s*(\d+)/;
  function readItem(goods) {
    const img = goods.querySelector(SEL.image);
    const name = [textOf(goods.querySelector(SEL.brand)), textOf(goods.querySelector(SEL.name))].filter(Boolean).join(' ');
    const variant = textOf(goods.querySelector(SEL.variant));
    return {
      title: variant ? `${name}（${variant}）` : name,
      quantity: Number(QTY_RE.exec(textOf(goods.querySelector(SEL.price)))?.[1]) || 1,
      imageUrl: attr(img, 'src') || null,
    };
  }

  /* 照列的順序走：有 td.orderTime 的列開始一筆訂單，之後沒有 orderTime 的列都還是那一筆。
   * 同一筆訂單可能出現在好幾個包裹裡，所以依注文番号收攏；
   * 只收**沒送達**的包裹裡的商品，live 表示這筆訂單有包裹還在路上（或還沒寄出） */
  function collect(doc, pageUrl) {
    const byId = new Map();
    for (const pack of all(doc, SEL.pack)) {
      const delivered = isDelivered(pack);
      let current = null;
      for (const row of all(pack, SEL.row)) {
        const cell = row.querySelector(SEL.orderCell);
        if (cell) {
          const text = textOf(cell);
          const orderId = /注文番号\s*[:：]\s*(\d+)/.exec(text)?.[1];
          if (!orderId) continue;
          if (!byId.has(orderId)) {
            byId.set(orderId, {
              orderId,
              orderedAt: parseDate(/注文日\s*[:：]\s*([\d./]+)/.exec(text)?.[1]),
              detail: absUrl(attr(cell.querySelector(SEL.detailLink), 'href'), pageUrl),
              items: [],
              live: false,
            });
          }
          current = byId.get(orderId);
          if (!delivered) current.live = true;
        }
        const goods = row.querySelector(SEL.goods);
        if (goods && current && !delivered) current.items.push(readItem(goods));
      }
    }
    return [...byId.values()];
  }

  /* 全部包裹都送達了 → 不擷取（空的訂單，注文日留給翻頁判斷七天的界線）。
   * 還有沒送達的 → 先放一個空的包裹，讀詳細頁：讀到了就換成實際的伝票番号（還沒寄出的話一個都沒有）；
   * 讀不到時它留著，會被算進「讀不到配送資料」。
   * 詳細頁上沒有配送業者（「詳細」只是打開配送歷程，「発送元」是 ZOZO 自己），所以業者留空 */
  function buildOrder({ orderId, orderedAt, detail, items, live }) {
    const order = { orderId, orderedAt, total: null, currency: 'JPY', shipments: [], lookups: [] };
    if (!live) return order;
    order.shipments = [{ carrier: '', trackingId: '', items: [] }];
    if (!detail) return order;
    order.lookups.push({
      url: detail,
      reader: 'zozoDetail',
      via: 'fetch',
      apply: (info) => {
        order.total = info.total ?? null;
        order.shipments = info.trackingIds.map((trackingId) => ({ carrier: '', trackingId, items }));
      },
    });
    return order;
  }

  // 用頁面特徵判斷：有包裹區塊，而且裡面有連到注文詳細頁的連結
  const hasOrders = (doc) => !!doc.querySelector(`${SEL.pack} ${SEL.orderCell} ${SEL.detailLink}`);

  globalThis.OrderScraper.sites.push({
    name: 'zozo',
    label: 'ZOZOTOWN',
    isOrderPage: (loc, doc) => /(^|\.)zozo\.jp$/.test(loc.hostname) && hasOrders(doc),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    nextPage: (doc, pageUrl) => {
      const url = absUrl(attr(doc.querySelector(SEL.next), 'href'), pageUrl) || nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) => collect(doc, pageUrl).map(buildOrder),
  });
})();
