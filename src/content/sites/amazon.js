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
  const { clean, textOf, attr, all, parseMoney, parseDate, absUrl, climbUnique,
    countContained, countMatches, countOrderIds, cardsByOrderId,
    outermost, byDocumentOrder } = globalThis.OrderScraper.util;

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
    status: '.yohtmlc-shipment-status-primaryText, .delivery-box__primary-text',
    signIn: '#ap_email, #authportal-main-section',
  };

  const ORDER_ID_RE = /[A-Z]?\d{2,3}-\d{7}-\d{7}/;
  // 商品列表裡會出現、但不是商品的連結文字（日 / 英 / 簡中）。
  // 大多數按鈕靠 isButton() 的 .a-button / .a-button-text 就能排除，這裡是額外保險
  const BUTTON_TEXT_RE = /^(?:配送状況を確認|Track package|追踪您的包裹|もう一度買う|Buy it again|再次购买)/i;
  // 合計的標籤：合計（日）/ Total（英）/ 总价（簡中）
  const TOTAL_LABEL_RE = /合計|total|总价/i;
  // 注文日的標籤：注文日（日）/ Order placed（英）/ 已下订单（簡中）
  const DATE_LABEL_RE = /注文日|order\s*placed|已下订单/i;
  const ORDER_PAGE_RE = /\/(gp\/css\/order-history|your-orders|gp\/your-account\/order-history)/;
  /* 已送達的包裹狀態文字（日 / 英 / 簡中）。送達後「配送状況を確認」按鈕還會留著好一陣子，
   * 光看按鈕分不出在途或已送達，只能讀包裹的狀態文字。
   * 簡中一定要連「已」一起比對 —— 在途顯示的是「预计…送达」，只比「送达」會把在途的也濾掉 */
  const DELIVERED_RE = /お届け済み|^delivered\b|^已.{0,12}送达/i;

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

  // 注文日。認不得標籤時退回標頭裡第一個解析得出日期的欄位
  // （合計 / お届け先 / 注文番号 都不會被當成日期）
  function orderDate(card) {
    const cols = all(card, SEL.headerItem);
    const labeled = cols.find((c) => DATE_LABEL_RE.test(textOf(c.querySelector(SEL.headerLabel))));
    return parseDate(textOf(labeled)) ?? cols.map((c) => parseDate(textOf(c))).find(Boolean) ?? null;
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

  // 已送達的包裹不擷取。讀不到狀態（其他語系、或版面沒有這一行）時一律當成配送中保留 ——
  // 漏抓一個在途的包裹，比多抓一個已送達的嚴重
  const isDelivered = (el) => DELIVERED_RE.test(textOf(el?.querySelector(SEL.status)));

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

  // 只保留配送中的商品：包裹要有「配送状況を確認」按鈕（尚未出貨的沒有），
  // 而且狀態不是已送達。兩個條件都不符的包裹整個略過。
  // 一個包裹一筆，配送業者 / トラッキングID 由配送狀況頁補上。
  // 完全沒有配送中的包裹時回傳 null（整筆訂單不擷取）
  function buildOrder({ orderId, card, products }, baseUrl) {
    const shipments = findShipments(card);
    // 先把商品配對到包裹，再濾掉已送達的那些 —— 順序不能反過來：
    // shipmentOf 的「只有一個包裹就直接用」是看整張訂單，先濾掉會讓已送達那箱的商品錯配到剩下那箱
    const shipping = products
      .map((product) => ({ product, shipment: shipmentOf(product.el, shipments) }))
      .filter(({ shipment }) => shipment && !isDelivered(shipment.el))
      .map(({ product, shipment }) => ({ product, trackingUrl: absUrl(shipment.trackHref, baseUrl) }))
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
      orderedAt: orderDate(card),
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

  globalThis.OrderScraper.sites.push({
    name: 'amazon',
    label: 'Amazon.co.jp',
    isOrderPage: (loc) => /(^|\.)amazon\.co\.jp$/.test(loc.hostname) && ORDER_PAGE_RE.test(loc.pathname),
    isSignInPage: (doc, url) => /\/ap\/signin/.test(url) || !!doc.querySelector(SEL.signIn),
    findOrders: (doc, pageUrl) => findCards(doc).map((card) => buildOrder(card, pageUrl)),
  });
})();
