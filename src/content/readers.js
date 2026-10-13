/* 各站台「需要真的載入才讀得到」的頁面讀取器（前端渲染，抓原始 HTML 看不到值）。
 *
 * 兩種載入方式共用：content script 的隱藏 iframe、background 的背景分頁。
 * 背景分頁那條路會連同 util.js 一起注入，所以這裡可以用共用工具。
 * 每個讀取器回傳 { ok: true, … } 或 { signIn: true }。
 */
globalThis.OrderScraper ??= { sites: [], readers: {} };

(() => {
  'use strict';
  const { sleep, clean, attr, all, cls, parseMoney, climbUnique } = globalThis.OrderScraper.util;

  const RENDER_TIMEOUT_MS = 15000; // 等待前端渲染的上限
  const PARTIAL_WAIT_MS = 2000;    // 只出現部分欄位時，再等其他欄位的時間
  const POLL_MS = 300;

  // 反覆執行 read()，直到 done(info) 為真或逾時。部分欄位先出現時，再多等一下其他欄位
  async function poll(doc, read, done) {
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let firstSeenAt = 0;
    while (Date.now() < deadline) {
      if (doc.querySelector('#ap_email, #authportal-main-section')) return { signIn: true };
      const info = read(doc);
      const state = done(info);
      if (state === true) return info;
      if (state === 'partial') {
        firstSeenAt ||= Date.now();
        if (Date.now() - firstSeenAt > PARTIAL_WAIT_MS) return info;
      }
      await sleep(POLL_MS);
    }
    return read(doc);
  }

  // 兩個欄位都到齊才算完成，只到一個先算 partial（再多等一下另一個）
  const bothReady = (a, b) => (a && b ? true : a || b ? 'partial' : false);

  const register = (name, read, done) => {
    globalThis.OrderScraper.readers[name] = (doc) => poll(doc, read, done);
  };

  /* ---------- Amazon：配送狀況頁 ---------- */

  // 配送業者：配送業者 日本郵便（日）/ Shipped with 日本郵便（英）
  const CARRIER_LABEL_RE = /^(?:配送業者|Shipped\s+with)\s*[:：]?\s*/i;
  // 配送業者：由日本郵便配送（簡中，名稱被前後包住）
  const CARRIER_WRAP_RE = /^由\s*(.+?)\s*配送$/;
  // トラッキングID:（日）/ Tracking ID（英）/ 追踪编码（簡中）。英文與簡中都沒有冒號
  const TRACKING_LABEL_RE = /^(?:トラッキングID|Tracking\s*ID|追踪编码)\s*[:：]?\s*/i;
  const ID_LIKE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{4,}$/;

  const amazonCarrier = (headings) => {
    const labeled = headings.find((t) => CARRIER_LABEL_RE.test(t));
    if (labeled) return clean(labeled.replace(CARRIER_LABEL_RE, ''));
    return clean(headings.map((t) => t.match(CARRIER_WRAP_RE)?.[1]).find(Boolean));
  };

  const amazonTrackingId = (text) => {
    if (!text) return '';
    const label = TRACKING_LABEL_RE.exec(text);
    if (label) return clean(text.slice(label[0].length));
    // 認不得標籤時，取最後一段像編號的字串（例：「XXX 766230862762」）
    const tokens = clean(text).split(' ');
    const last = tokens.at(-1);
    return tokens.length > 1 && ID_LIKE_RE.test(last) ? last : clean(text);
  };

  const readAmazonTracking = (doc) => ({
    ok: true,
    carrier: amazonCarrier(all(doc, 'h1, h2, h3, h4').map((el) => clean(el.textContent))),
    trackingId: amazonTrackingId(clean(doc.querySelector('.pt-delivery-card-trackingId')?.textContent)),
  });

  register('amazonTracking', readAmazonTracking, (i) => bothReady(i.carrier, i.trackingId));

  /* ---------- 楽天：注文詳細頁 ---------- */

  // 詳細頁的標籤（日 / 英）。合計要取「支払い金額」，避開小計與送料
  const RAKUTEN_LABELS = {
    total: /^(?:支払い?金額|お支払い?金額|ご請求金額|total\s*amount)$/i,
    carrier: /^(?:配送業者|shipping\s*company)$/i,
    trackingId: /^(?:伝票番号|tracking\s*number)$/i,
    quantity: /^(?:数量|個数|quantity)\s*[:：]?$/i,
  };

  const RAKUTEN_ITEM_LINK = 'a[href*="item.rakuten.co.jp"]';

  // 出貨狀態區塊。配送業者 / 伝票番号 一定在這裡面，一個包裹一個區塊
  const SHIPPING_BLOCK = cls('shipping-status');
  // 已送達 = 配送進度列的「目前狀態」落在最後一步（與列表頁同一套判斷，見 sites/rakuten.js）
  const ACTIVE_STEP = cls('item-shipping-active');
  const isDelivered = (block) => {
    const active = block.querySelector(ACTIVE_STEP);
    return !!active && active === active.parentElement?.lastElementChild;
  };

  // 標籤與值是同一列的相鄰區塊：<div><span>配送業者</span></div><div>…值…</div>
  // 金額則是 <span>支払い金額</span><div>…<div class="number-display--…">10,660</div></div>
  const labelsIn = (doc, labelRe) =>
    all(doc, 'span, div').filter((el) => !el.children.length && labelRe.test(clean(el.textContent)));
  const valueOf = (label) =>
    clean(label?.nextElementSibling?.textContent || label?.parentElement?.nextElementSibling?.textContent);

  const isExternal = (href) => {
    try { return !/(^|\.)rakuten\.co\.jp$/.test(new URL(href).hostname); } catch { return false; }
  };

  // 伝票番号必須是某個查詢參數的完整值（例：?oku01=568506023470、&no01=391175086374），
  // 不能只是「網址裡剛好有一段長數字」—— 活動頁的網址也常帶流水號
  const trackingInHref = (href) => {
    try {
      for (const value of new URL(href).searchParams.values()) {
        if (/^\d{8,}$/.test(value)) return value;
      }
    } catch { /* 網址解析不了就當作沒有 */ }
    return '';
  };

  // 認不得標籤時（其他語系）的後備：配送業者是連到業者查詢頁的外部連結，aria-label 就是業者名。
  // 範圍一定要限制在出貨狀態區塊內：頁面別處的活動連結（例如「○倍の注意点」）同樣是
  // 帶長數字的外部連結，不限制範圍就會被當成配送業者，產生假的伝票番号
  const carrierLinks = (block) =>
    all(block, 'a[href^="http"]')
      .filter((a) => isExternal(attr(a, 'href')))
      .map((a) => ({ carrier: clean(attr(a, 'aria-label')), trackingId: trackingInHref(attr(a, 'href')) }))
      .filter((s) => s.carrier && s.trackingId);

  // 一筆訂單可能有多個伝票番号（分批出貨），依出現順序配對。
  // block 為真時才用連結後備 —— 那個後備一定要限制在出貨狀態區塊內（見上面的註解）
  function shipmentsIn(scope, block) {
    const carriers = labelsIn(scope, RAKUTEN_LABELS.carrier).map(valueOf);
    const trackingIds = labelsIn(scope, RAKUTEN_LABELS.trackingId).map(valueOf).filter(Boolean);
    if (trackingIds.length) {
      return trackingIds.map((trackingId, i) => ({ carrier: carriers[i] || carriers[0] || '', trackingId }));
    }
    return block ? carrierLinks(scope) : [];
  }

  // 已送達的包裹不擷取。英文版的詳細頁沒有出貨狀態區塊，認不出進度，整份文件照舊讀
  const liveBlocks = (doc) => all(doc, SHIPPING_BLOCK).filter((block) => !isDelivered(block));

  function rakutenShipments(doc) {
    const blocks = all(doc, SHIPPING_BLOCK);
    if (!blocks.length) return shipmentsIn(doc, false);
    return liveBlocks(doc).flatMap((block) => shipmentsIn(block, true));
  }

  // 認不得標籤時取字最大的那個金額（詳細頁用字級區分小計與支払い金額）
  const biggestAmount = (doc) =>
    all(doc, cls('number-display'))
      .filter((b) => /size-custom-2\d--/.test(b.querySelector(cls('value'))?.className || ''))
      .at(-1)?.textContent;

  // 数量：每件商品一個「数量：」標籤，往上爬到只含這一件商品的範圍，取該範圍裡的品名當對照鍵。
  // 列表頁沒有数量，所以要靠這裡回填
  function rakutenQuantities(doc) {
    const countItems = (scope) => scope.querySelectorAll(RAKUTEN_ITEM_LINK).length;
    return labelsIn(doc, RAKUTEN_LABELS.quantity)
      .map((label) => ({
        title: clean(climbUnique(label, doc.body, countItems).querySelector(RAKUTEN_ITEM_LINK)?.textContent),
        quantity: Number(valueOf(label)) || 1,
      }))
      .filter((q) => q.title);
  }

  const readRakutenDetail = (doc) => ({
    ok: true,
    total: parseMoney(valueOf(labelsIn(doc, RAKUTEN_LABELS.total)[0])) ?? parseMoney(biggestAmount(doc)),
    // 包裹全部已送達：這筆不擷取，配送資料不會再出現，別白等
    delivered: !!all(doc, SHIPPING_BLOCK).length && !liveBlocks(doc).length,
    shipments: rakutenShipments(doc),
    quantities: rakutenQuantities(doc),
  });

  register('rakutenDetail', readRakutenDetail,
    (i) => (i.delivered ? !!i.total : bothReady(i.total, i.shipments.length)));

  /* ---------- Shopify：注文詳細頁（/account/orders/…） ---------- */

  /* Shopify 的訂單頁是伺服器渲染的，不必等前端跑完。
   * 但各店的佈景主題差很多（實際看過兩種：Dawn 原版、以及完全重寫的版本），
   * 所以不靠固定的表格選擇器，改以**配送資訊**為錨點：
   * 樣板一律輸出「{{ tracking_company }} #{{ tracking_number }}」，
   * 那個「#」是寫死的字元不是翻譯，可以直接當錨點，再往上找出它所屬的那一列。 */

  const TRACKING_RE = /^(.+?)\s*#\s*([A-Za-z0-9][A-Za-z0-9-]{3,})$/;
  const QTY_CELL = 'td[headers~="ColumnQuantity"], td[class*="qty"], [class*="quantity"]';
  const PRODUCT_LINK = 'a[href*="/products/"]';
  const LEAF = 'span, a, p, div, td, li';

  // Shopify CDN 的縮圖會在副檔名前加尺寸（…_100x.jpg），去掉取原圖
  const fullSize = (src) => {
    if (!src) return null;
    const url = src.startsWith('//') ? `https:${src}` : src;
    return url.replace(/_(?:\d+x\d*|\d*x\d+)(?=\.[a-z]+(?:\?|$))/i, '');
  };

  // 文字剛好是「業者名 #伝票番号」的最內層元素。Dawn 放在 <span>，有的主題放在追蹤連結的 <a> 裡
  const trackingNodes = (doc) =>
    all(doc, LEAF)
      .filter((el) => !el.querySelector(LEAF))
      .map((el) => ({ el, found: TRACKING_RE.exec(clean(el.textContent)) }))
      .filter(({ found }) => found);

  const rowOf = (el) => el.closest('tr') || el.closest('li') || el.parentElement;

  // 品名：商品連結 → 標題元素 →（都沒有就放棄這一列）
  const titleIn = (row) =>
    clean(row.querySelector(PRODUCT_LINK)?.textContent)
    || clean(row.querySelector('h1, h2, h3, h4, h5')?.textContent);

  // 数量：Dawn 標了 headers；其他主題常用 class。都認不得時找「整格只有數字」的欄位
  function quantityIn(row) {
    const cell = row.querySelector(QTY_CELL)
      || all(row, 'td').find((td) => /^\d{1,4}$/.test(clean(td.textContent)));
    return Number(clean(cell?.textContent).replace(/[^\d]/g, '')) || 1;
  }

  function shopifyItems(doc, base) {
    const items = [];
    const seen = new Set();
    for (const { el, found } of trackingNodes(doc)) {
      const row = rowOf(el);
      if (!row || seen.has(row)) continue;
      seen.add(row);
      const title = titleIn(row);
      if (!title) continue;
      const link = row.querySelector(PRODUCT_LINK);
      items.push({
        title,
        quantity: quantityIn(row),
        carrier: clean(found[1]),
        trackingId: found[2],
        // 有的主題訂單頁就有商品圖；沒有的話只能靠商品連結另外要（見 shopifyImages）
        imageUrl: fullSize(attr(row.querySelector('img'), 'src')) || null,
        path: productPath(attr(link, 'href'), base),
      });
    }
    return items;
  }

  // 商品網址 /products/{handle} → 加上 .js 就是商品 JSON（含主圖）。
  // 直接沿用連結自己的路徑，多語系商店的語系前綴（/zh-hant/products/…）才不會掉
  const productPath = (href, base) => {
    try {
      const { pathname } = new URL(href, base);
      return /\/products\/[^/]+$/.test(pathname) ? pathname : '';
    } catch { return ''; }
  };

  // 同一件商品常出現在多筆訂單裡，問過的就記著（存的是 Promise，同時發問也只會送出一次）
  const productImageCache = new Map();

  function shopifyImage(path, base) {
    if (!productImageCache.has(path)) {
      productImageCache.set(path, (async () => {
        try {
          const res = await fetch(new URL(`${path}.js`, base).href, { credentials: 'include' });
          if (!res.ok) return null;
          return fullSize((await res.json()).featured_image);
        } catch { return null; } // 取不到圖就留空，不影響其他欄位
      })());
    }
    return productImageCache.get(path);
  }

  // 只替「訂單頁上沒有圖、但有商品連結」的商品發問
  async function shopifyImages(items, base) {
    const paths = [...new Set(items.filter((i) => !i.imageUrl && i.path).map((i) => i.path))];
    const urls = await Promise.all(paths.map((p) => shopifyImage(p, base)));
    const byPath = new Map(paths.map((p, i) => [p, urls[i]]));
    for (const item of items) item.imageUrl ||= byPath.get(item.path) || null;
  }

  // 合計：Dawn 的表尾標了 RowTotal；其他主題常用 class 標總計那一列。都避開小計 / 送料 / 稅
  const shopifyTotal = (doc) =>
    parseMoney(clean(doc.querySelector('td[headers~="RowTotal"]')?.textContent))
    ?? parseMoney(clean(doc.querySelector('[class*="order_total"], [class*="order-total"]')?.textContent))
    ?? parseMoney(clean(all(doc, 'tfoot td').at(-1)?.textContent));

  globalThis.OrderScraper.readers.shopifyOrder = async (doc) => {
    if (doc.querySelector('form[action*="/account/login"]')) return { signIn: true };
    const base = doc.baseURI || location.href;
    const items = shopifyItems(doc, base);
    await shopifyImages(items, base);
    return { ok: true, total: shopifyTotal(doc), items };
  };
})();
