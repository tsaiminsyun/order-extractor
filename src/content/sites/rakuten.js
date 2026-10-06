/* 楽天市場 購入履歴（order.my.rakuten.co.jp）
 *
 * 樂天的 class 名稱帶雜湊（ellipsis--3QFZf），雜湊每次改版都會變，所以只比對前綴或用結構判斷。
 * 列表頁有：注文番号、商品（名稱 / 圖片），日文介面還有配送業者 / 伝票番号。
 * 合計（支払い金額）只在注文詳細頁，英文介面的列表頁連配送資訊都沒有，
 * 所以要擷取的訂單仍得載入一次詳細頁（該頁為前端渲染，用隱藏 iframe 載入後讀取）。
 */
(() => {
  'use strict';
  const { clean, textOf, attr, all, cls, absUrl, climbUnique,
    countOrderIds, cardsByOrderId, byDocumentOrder } = globalThis.OrderScraper.util;

  const ORDER_ID_RE = /\d{4,8}-\d{8}-\d{8,12}/;
  const DETAIL_LINK = 'a[href*="act=detail_page_view"]';
  const ITEM_LINK = 'a[href*="item.rakuten.co.jp"]';   // 商品連結（商店 logo 連的是 www.rakuten.co.jp）
  const DETAIL_BASE = 'https://order.my.rakuten.co.jp/purchase-history/';

  // 配送業者 / 伝票番号 的標籤（日 / 英）
  const LABELS = {
    carrier: /^(?:配送業者|shipping\s*company)$/i,
    trackingId: /^(?:伝票番号|tracking\s*number)$/i,
  };

  const idText = (el) => textOf(el).match(ORDER_ID_RE)?.[0] || null;
  // 只取「整個元素就是注文番号」的 span 當錨點，避免抓到外層容器
  const exactId = (el) => (idText(el) === textOf(el) ? idText(el) : null);
  const countIds = countOrderIds('span, div', idText);
  // 只有一層文字的元素才可能是標籤
  const leafText = (card, labelRe) => all(card, 'span').filter((el) => !el.children.length && labelRe.test(textOf(el)));

  // 一筆訂單的範圍：以注文番号為錨點往上爬，直到再往上就會含到第二筆訂單
  const findCards = (doc) =>
    cardsByOrderId(all(doc.body, 'span'), exactId, (idEl) => ({ card: climbUnique(idEl, doc.body, countIds) }));

  // 商品：商品連結（item.rakuten.co.jp）裡的圖片與名稱。alt 就是完整品名
  function findProducts(card) {
    // 同一件商品有圖片連結和名稱連結兩個，合併成一筆（有圖片的優先）
    const byTitle = new Map();
    for (const link of all(card, ITEM_LINK)) {
      const img = link.querySelector('img');
      const title = clean(attr(img, 'alt')) || textOf(link.querySelector(cls('ellipsis'))) || textOf(link);
      if (title.length < 2) continue;
      // 縮圖網址的 ?_ex=168x168 是尺寸參數，去掉取原圖
      const imageUrl = img ? attr(img, 'src').split('?')[0] : null;
      const found = byTitle.get(title);
      if (!found) byTitle.set(title, { el: link, title, imageUrl });
      else if (!found.imageUrl) found.imageUrl = imageUrl;
    }
    return [...byTitle.values()].sort(byDocumentOrder);
  }

  // 列表頁是否顯示配送區塊。日文介面會顯示（出貨進度 / 配送業者 / 伝票番号），
  // 英文介面不顯示，這時只能進詳細頁才知道有沒有伝票番号
  const hasShippingBlock = (card) =>
    !!card.querySelector(cls('shipping-status')) ||
    !!leafText(card, LABELS.carrier).length ||
    !!leafText(card, LABELS.trackingId).length;

  // 列表頁上的配送資訊（日文介面）：配送業者 / 伝票番号 的標籤旁邊就是值，可能有多組
  function readShipments(card) {
    const valuesOf = (labelRe) =>
      leafText(card, labelRe).map((el) => textOf(el.parentElement?.nextElementSibling)).filter(Boolean);
    const carriers = valuesOf(LABELS.carrier);
    return valuesOf(LABELS.trackingId).map((trackingId, i) => ({ carrier: carriers[i] || carriers[0] || '', trackingId }));
  }

  // 詳細頁網址：列表頁的「注文詳細」連結；找不到時用注文番号自行組出來
  function detailUrl(card, orderId, baseUrl) {
    const link = absUrl(attr(card.querySelector(DETAIL_LINK), 'href'), baseUrl);
    if (link) return link;
    const shopId = orderId.split('-')[0];
    return `${DETAIL_BASE}?order_number=${orderId}&shop_id=${shopId}&act=detail_page_view`;
  }

  // 一個伝票番号就是一個包裹。樂天不會標示哪件商品在哪個包裹，
  // 所以同一筆訂單的商品會掛在它的每個伝票番号下
  const toShipments = (pairs, items) => pairs.map(({ carrier, trackingId }) => ({ carrier, trackingId, items }));

  // 沒有伝票番号的訂單不擷取（回傳 null）。列表頁看得出沒有時，連詳細頁都不載入
  // 数量只在詳細頁，用品名對回列表頁的商品；品名對不上時依出現順序，都對不上就當 1 件
  function applyQuantities(items, quantities) {
    const byTitle = new Map(quantities.map((q) => [q.title, q.quantity]));
    items.forEach((item, i) => { item.quantity = byTitle.get(item.title) ?? quantities[i]?.quantity ?? 1; });
  }

  function buildOrder({ orderId, card }, baseUrl) {
    const onList = readShipments(card);
    if (hasShippingBlock(card) && !onList.length) return null;

    // 列表頁沒有数量，先當 1 件，讀到詳細頁再回填
    const items = findProducts(card).map(({ title, imageUrl }) => ({ title, quantity: 1, imageUrl }));
    const order = { orderId, total: null, currency: 'JPY', shipments: toShipments(onList, items), lookups: [] };
    // 合計只在詳細頁；英文介面的列表頁沒有配送資訊，也要靠詳細頁補
    order.lookups.push({
      url: detailUrl(card, orderId, baseUrl),
      reader: 'rakutenDetail',
      apply: (info) => {
        order.total = info.total ?? null;
        applyQuantities(items, info.quantities || []);
        if (!order.shipments.length) order.shipments = toShipments(info.shipments || [], items);
      },
    });
    return order;
  }

  globalThis.OrderScraper.sites.push({
    name: 'rakuten',
    label: '楽天市場',
    orderListUrl: 'https://order.my.rakuten.co.jp/purchase-history/order-list/',
    isOrderPage: (loc) => /(^|\.)rakuten\.co\.jp$/.test(loc.hostname) && loc.pathname.includes('/purchase-history'),
    isSignInPage: (doc, url) => /grp\d+\.id\.rakuten\.co\.jp|\/login/.test(url) || !!doc.querySelector('#loginInner, input[name="u"]'),
    firstPage: (loc) => ({ url: loc.href, useCurrent: true }),
    findOrders: (doc, pageUrl) => findCards(doc).map((card) => buildOrder(card, pageUrl)),
    nextPageUrl: () => null, // 分頁規則待確認
  });
})();
