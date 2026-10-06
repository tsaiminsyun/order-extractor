/* Amazon.co.jp 注文履歴
 *
 * 解析策略：以頁面上穩定存在的元素當錨點（.yohtmlc-order-id、asin_title 品名連結、
 * 配送状況を確認 按鈕），再往上找出它所屬的範圍；不依賴外層卡片的 class 名稱，
 * 因為那一層在 Amazon 改版時最常變動。
 *
 * 列表頁沒有配送業者與トラッキングID（連 HTML 裡都沒有），只能從「配送状況を確認」
 * 按鈕連到的配送狀況頁取得，所以配送中的包裹一定要多讀一頁。
 */
(() => {
  'use strict';
  const { clean, textOf, attr, all, parseMoney, absUrl, climbUnique,
    countContained, countMatches, countOrderIds, cardsByOrderId,
    outermost, byDocumentOrder } = globalThis.OrderScraper.util;

  const PAGE_SIZE = 10;

  const SEL = {
    ordersRoot: '#ordersContainer, .your-orders-content-container, #yourOrdersContent',
    orderId: '.yohtmlc-order-id',
    card: '.order-card, .js-order-card, .a-box-group.order',
    headerItem: '.order-header__header-list-item, .order-header .a-column',
    headerLabel: '.a-text-caps, .a-size-mini',
    title: [
      '.yohtmlc-product-title a',
      'a[href*="asin_title"]',
      '.yohtmlc-item a[href*="/dp/"]',
      '.yohtmlc-item a[href*="/gp/product/"]',
    ].join(','),
    plainTitle: '.yohtmlc-product-title',
    productLink: 'a[href*="/dp/"], a[href*="/gp/product/"]',
    productImage: '.product-image',
    qty: '.product-image__qty',
    deliveryBox: '.delivery-box',
    track: 'a[href*="/progress-tracker/package"]',
    nextPage: 'ul.a-pagination li.a-last a, .a-pagination .a-last a',
    signIn: '#ap_email, #authportal-main-section',
  };

  const ORDER_ID_RE = /[A-Z]?\d{2,3}-\d{7}-\d{7}/;
  // 商品列表裡會出現、但不是商品的連結文字（日 / 英 / 簡中）。
  // 大多數按鈕靠 isButton() 的 .a-button / .a-button-text 就能排除，這裡是額外保險
  const BUTTON_TEXT_RE = /^(?:配送状況を確認|Track package|追踪您的包裹|もう一度買う|Buy it again|再次购买)/i;
  // 合計的標籤：合計（日）/ Total（英）/ 总价（簡中）
  const TOTAL_LABEL_RE = /合計|total|总价/i;
  const ORDER_PAGE_RE = /\/(gp\/css\/order-history|your-orders|gp\/your-account\/order-history)/;

  const asinOf = (href) => String(href || '').match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/)?.[1] || null;
  const idText = (el) => textOf(el).match(ORDER_ID_RE)?.[0] || null;
  const isButton = (el) => !!el.closest('.a-button') || el.classList.contains('a-button-text');
  const countIds = countOrderIds(SEL.orderId, idText);

  /* ---------- 訂單卡片 ---------- */

  function findCards(doc) {
    const root = doc.querySelector(SEL.ordersRoot) || doc.body;
    return cardsByOrderId(all(root, SEL.orderId), idText, (idEl) => {
      const known = idEl.closest(SEL.card);
      const card = known && countIds(known) === 1 ? known : climbUnique(idEl, root, countIds);
      const products = findProducts(card);
      // 已知的卡片外框若沒包到商品，再往外擴到仍只含這一張訂單的最大範圍
      if (products.length) return { card, products };
      const wider = climbUnique(card, root, countIds);
      return wider === card ? { card, products } : { card: wider, products: findProducts(wider) };
    });
  }

  function orderTotal(card) {
    const cols = all(card, SEL.headerItem);
    const labeled = cols.find((c) => TOTAL_LABEL_RE.test(textOf(c.querySelector(SEL.headerLabel))));
    // 認不得標籤時（少見語系），退回標頭裡第一個含金額的欄位
    return parseMoney(textOf(labeled)) ?? parseMoney(textOf(cols.find((c) => parseMoney(textOf(c)))));
  }

  /* ---------- 商品 ---------- */

  const isProduct = ({ title }) => title.length >= 2 && !BUTTON_TEXT_RE.test(title);
  const productEntry = (el, title) => ({ el, title, asin: asinOf(attr(el, 'href')) });

  // 同一 ASIN 或同一品名只留第一個
  function uniqueProducts(entries) {
    const asins = new Set();
    const titles = new Set();
    return entries.filter(({ asin, title }) => {
      if ((asin && asins.has(asin)) || titles.has(title)) return false;
      if (asin) asins.add(asin);
      titles.add(title);
      return true;
    });
  }

  // 先找有文字的品名，再補上「只有圖片」的商品（多商品包裹常只顯示部分品名）
  function findProducts(card) {
    const withText = (els) => els.map((el) => productEntry(el, textOf(el))).filter(isProduct);

    let named = withText([
      ...all(card, SEL.title),
      ...all(card, SEL.plainTitle).filter((el) => !el.querySelector('a')),
    ]);
    if (!named.length) named = withText(all(card, SEL.productLink).filter((a) => !isButton(a)));

    const pictured = all(card, 'img[alt]')
      .filter((img) => /\/images\/I\//.test(attr(img, 'src')) && !isButton(img))
      .map((img) => productEntry(img.closest(SEL.productLink) || img, clean(attr(img, 'alt'))))
      .filter(isProduct);

    return uniqueProducts([...named, ...pictured]).sort(byDocumentOrder);
  }

  // 依序比對：alt 等於品名 → 同 ASIN 連結裡的圖片 → 商品自己範圍內的第一張圖
  const productImage = ({ card, imgs, productEls }, product) =>
    imgs.find((i) => clean(attr(i, 'alt')) === product.title) ||
    (product.asin && imgs.find((i) => asinOf(attr(i.closest(SEL.productLink), 'href')) === product.asin)) ||
    climbUnique(product.el, card, countContained(productEls)).querySelector('img');

  const imageUrlOf = (img) => attr(img, 'data-a-hires') || attr(img, 'src') || null;

  // 數量只有 2 件以上才會顯示（圖片角落的 .product-image__qty），沒有就是 1 件。
  // 只從這張圖自己的 .product-image 裡找，才不會借用到別件商品的數量
  const quantityOf = (img) => Number(textOf(img?.closest(SEL.productImage)?.querySelector(SEL.qty))) || 1;

  /* ---------- 包裹 ---------- */

  // 一個 .delivery-box 就是一個包裹，裡面可能有多件商品，共用同一組配送資訊
  function findShipments(card) {
    const tracks = all(card, SEL.track);
    const boxes = outermost(all(card, SEL.deliveryBox));
    if (!boxes.length) {
      return tracks.map((a) => ({ el: climbUnique(a, card, countMatches(SEL.track)), trackHref: attr(a, 'href') }));
    }

    const hrefs = boxes.map((box) => attr(box.querySelector(SEL.track), 'href'));
    // 配送状況按鈕放在 box 外面時，數量相符就依順序配對
    const pairByIndex = hrefs.every((h) => !h) && tracks.length === boxes.length;
    return boxes.map((el, i) => ({ el, trackHref: pairByIndex ? attr(tracks[i], 'href') : hrefs[i] }));
  }

  // 不在任何包裹內的商品：只有單一包裹時才套用，避免借用別的包裹的配送資料
  const shipmentOf = (el, shipments) =>
    shipments.find((s) => s.el.contains(el)) || (shipments.length === 1 ? shipments[0] : null);

  /* ---------- 組合 ---------- */

  // 只保留配送中的商品：包裹有「配送状況を確認」按鈕才算配送中，
  // 已送達（或尚未出貨）的包裹沒有這個按鈕，整個略過。
  // 一個包裹一筆，配送業者 / トラッキングID 由配送狀況頁補上。
  // 完全沒有配送中的包裹時回傳 null（整筆訂單不擷取）
  function buildOrder({ orderId, card, products }, baseUrl) {
    const shipments = findShipments(card);
    const shipping = products
      .map((product) => ({ product, trackingUrl: absUrl(shipmentOf(product.el, shipments)?.trackHref, baseUrl) }))
      .filter(({ trackingUrl }) => trackingUrl);
    if (!shipping.length) return null;

    const scope = { card, imgs: all(card, 'img'), productEls: products.map((p) => p.el) };
    // 同一個包裹的商品歸成一筆，也只讀一次配送狀況頁
    const byUrl = new Map();
    for (const { product, trackingUrl } of shipping) {
      if (!byUrl.has(trackingUrl)) byUrl.set(trackingUrl, { carrier: '', trackingId: '', items: [] });
      const img = productImage(scope, product);
      byUrl.get(trackingUrl).items.push({
        title: product.title,
        asin: product.asin,
        quantity: quantityOf(img),
        imageUrl: imageUrlOf(img),
      });
    }

    return {
      orderId,
      total: orderTotal(card),
      currency: 'JPY',
      shipments: [...byUrl.values()],
      lookups: [...byUrl].map(([url, shipment]) => ({
        url,
        reader: 'amazonTracking',
        apply: (info) => {
          shipment.carrier = info.carrier || '';
          shipment.trackingId = info.trackingId || '';
        },
      })),
    };
  }

  function nextPageUrl(doc, pageUrl, ordersOnPage) {
    const next = doc.querySelector(SEL.nextPage);
    if (next && !next.closest('li')?.classList.contains('a-disabled')) {
      const href = absUrl(attr(next, 'href'), pageUrl);
      if (href) return href;
    }
    // 沒有分頁連結時，用 startIndex 自行推算（滿頁才繼續）
    if (ordersOnPage < PAGE_SIZE) return null;
    const u = new URL(pageUrl);
    u.searchParams.set('startIndex', String(Number(u.searchParams.get('startIndex') || 0) + PAGE_SIZE));
    return u.href;
  }

  globalThis.OrderScraper.sites.push({
    name: 'amazon',
    label: 'Amazon.co.jp',
    orderListUrl: 'https://www.amazon.co.jp/gp/css/order-history',
    isOrderPage: (loc) => /(^|\.)amazon\.co\.jp$/.test(loc.hostname) && ORDER_PAGE_RE.test(loc.pathname),
    isSignInPage: (doc, url) => /\/ap\/signin/.test(url) || !!doc.querySelector(SEL.signIn),
    // 目前分頁就是第一頁時直接用現有 DOM，不必再發 request
    firstPage: (loc) => {
      const u = new URL(loc.href);
      const useCurrent = Number(u.searchParams.get('startIndex') || 0) === 0;
      u.searchParams.set('startIndex', '0');
      return { url: u.href, useCurrent };
    },
    findOrders: (doc, pageUrl) => findCards(doc).map((card) => buildOrder(card, pageUrl)),
    nextPageUrl,
  });
})();
