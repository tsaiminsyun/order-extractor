/* 各站台「需要真的載入才讀得到」的頁面讀取器（前端渲染，抓原始 HTML 看不到值）。
 *
 * 兩種載入方式共用：content script 的隱藏 iframe、background 的背景分頁。
 * 背景分頁那條路會連同 util.js 一起注入，所以這裡可以用共用工具。
 * 每個讀取器回傳 { ok: true, … } 或 { signIn: true }。
 */
globalThis.OrderScraper ??= { sites: [], readers: {} };

(() => {
  'use strict';
  const { sleep, clean, textOf, attr, all, cls, parseMoney, parseDate, carrierOf, absUrl, climbUnique } = globalThis.OrderScraper.util;

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

  // 詳細頁的標籤（日 / 英 / 繁中）。合計要取「支払い金額」，避開小計與送料
  const RAKUTEN_LABELS = {
    total: /^(?:支払い?金額|お支払い?金額|ご請求金額|付款金額|total\s*amount)$/i,
    carrier: /^(?:配送業者|物流業者|shipping\s*company)$/i,
    trackingId: /^(?:伝票番号|運單號|tracking\s*number)$/i,
    quantity: /^(?:数量|個数|數量|quantity)\s*[:：]?$/i,
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
  // 帶長數字的外部連結，不限制範圍就會被當成配送業者，產生假的伝票番号。
  // 同一個伝票番号也可能有好幾個連結：業者名稱本身之外，「變更取件地點與時間」這類按鈕
  // 一樣連到業者的查詢頁（繁中頁實際看過）。同一個伝票番号就是同一個包裹，只留第一個 —— 業者名稱排在前面
  const carrierLinks = (block) => {
    const seen = new Set();
    return all(block, 'a[href^="http"]')
      .filter((a) => isExternal(attr(a, 'href')))
      .map((a) => ({ carrier: clean(attr(a, 'aria-label')), trackingId: trackingInHref(attr(a, 'href')) }))
      .filter((s) => s.carrier && s.trackingId && !seen.has(s.trackingId) && seen.add(s.trackingId));
  };

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

  /* ---------- ポケモンセンター：注文詳細頁（/order-details/?orderID=…） ---------- */

  /* 伺服器渲染，fetch 取回就讀得到，不必等。
   *   送り状番号  <dt>送り状番号</dt><dd>5040-1844-1522<br></dd>
   *   配送業者    「配送状況を確認する」連到業者的查詢頁，由網域判斷（util.carrierOf）
   *   商品        .comPriceList 一件一個 li，個数是停用的 <select aria-label="個数">。
   *               特典（キャンペーン景品）也列在這裡、一樣有個数，會跟著包裹寄來，所以照列
   *   合計        「支払合計」（避開商品合計 / 送料 / 手数料） */
  const pokemonValue = (doc, label) => all(doc, 'dt').find((dt) => textOf(dt) === label)?.nextElementSibling;

  // dd 裡一行一個（<br> 分隔）。號碼之間不一定有空白，所以不能用 textContent 再切
  const linesOf = (el) => {
    if (!el) return [];
    const lines = [''];
    for (const node of el.childNodes) {
      if (node.nodeName === 'BR') lines.push('');
      else lines[lines.length - 1] += node.textContent;
    }
    return lines.map(clean).filter(Boolean);
  };

  /* 頁面上顯示成 5040-1844-1522，業者查詢網址用的是 504018441522。
   * 其他站台的伝票番号也都是純數字，所以去掉連字號，WMS 那邊才對得起來 */
  function pokemonShipments(doc) {
    const trackers = all(doc, 'a[href^="http"]').map((a) => attr(a, 'href')).filter(carrierOf);
    return linesOf(pokemonValue(doc, '送り状番号'))
      .map((line) => line.replace(/-/g, ''))
      .filter((no) => /^[A-Za-z0-9]{8,}$/.test(no))
      // 有好幾個包裹時，業者取網址裡帶著這個號碼的查詢連結；找不到就用第一個
      .map((trackingId) => ({ carrier: carrierOf(trackers.find((h) => h.includes(trackingId)) || trackers[0] || ''), trackingId }));
  }

  const pokemonItems = (doc) =>
    all(doc, '.comPriceList > li')
      .map((li) => {
        const img = li.querySelector('.pho img');
        return {
          title: textOf(li.querySelector('.ttl')) || clean(attr(img, 'alt')),
          quantity: Number(li.querySelector('select[aria-label="個数"]')?.value) || 1,
          imageUrl: attr(img, 'src') || null,
        };
      })
      .filter((item) => item.title);

  const pokemonTotal = (doc) =>
    parseMoney(textOf(all(doc, '.comPriceAll p').find((p) => textOf(p.querySelector('.txt')) === '支払合計')?.querySelector('.price')));

  globalThis.OrderScraper.readers.pokemonDetail = async (doc) => {
    // 登入逾時會被導到登入頁
    if (doc.querySelector('input[type="password"]')) return { signIn: true };
    return { ok: true, total: pokemonTotal(doc), shipments: pokemonShipments(doc), items: pokemonItems(doc) };
  };

  /* ---------- にじさんじ：注文詳細頁（/mypage/order-history/detail?orderID=…） ---------- */

  /* 伺服器渲染，fetch 取回就讀得到，不必等。
   *   配送伝票番号  お届け先區塊裡 <h4>配送伝票番号</h4><span>366129410824</span>
   *                 **頁面上沒有配送業者**（沒有業者名，也沒有查詢連結），所以業者留空
   *   商品          .order-history-detail 一件一個，「数量」旁邊是件數。
   *                 組合商品底下另外列的內容物（.order-history-product-detail，例如特典カード）
   *                 是那件商品的一部分、沒有数量，不另列
   *   合計          「お支払い合計金額（税込）」（避開商品合計金額 / 配送料） */
  function nijisanjiTrackingIds(doc) {
    const ids = [];
    for (const head of all(doc, 'h4').filter((h) => textOf(h) === '配送伝票番号')) {
      for (let el = head.nextElementSibling; el && el.tagName === 'SPAN'; el = el.nextElementSibling) {
        const no = textOf(el).replace(/-/g, '');
        if (/^[A-Za-z0-9]{8,}$/.test(no) && !ids.includes(no)) ids.push(no);
      }
    }
    return ids;
  }

  const nijisanjiItems = (doc) =>
    all(doc, '.order-history-detail')
      .map((row) => {
        const img = row.querySelector('.order-history-img img');
        const src = attr(img, 'src');
        return {
          title: textOf(row.querySelector('.order-history-product-name')) || clean(attr(img, 'alt')),
          quantity: Number(textOf(row.querySelector('.cartitem-count-text'))) || 1,
          // 圖片是站內的相對路徑
          imageUrl: src ? absUrl(src, doc.baseURI || location.href) : null,
        };
      })
      .filter((item) => item.title);

  const nijisanjiTotal = (doc) =>
    parseMoney(textOf(all(doc, 'tr').find((tr) => /^お支払い合計金額/.test(textOf(tr.querySelector('th'))))?.querySelector('td')));

  globalThis.OrderScraper.readers.nijisanjiDetail = async (doc) => {
    if (doc.querySelector('input[type="password"]')) return { signIn: true };
    return { ok: true, total: nijisanjiTotal(doc), trackingIds: nijisanjiTrackingIds(doc), items: nijisanjiItems(doc) };
  };

  /* ---------- mu-mo ショップ：購入履歴・配送状況詳細 ---------- */

  /* 商品表（table.tableCart）一列一件商品。配送狀況那一格（td.cellDeliv）用 rowspan 跨過
   * 同一個包裹的所有商品，所以照列的順序走：遇到 cellDeliv 就是新的包裹，之後的商品都歸它。
   * 這個站台**知道哪件商品在哪個包裹**，不必把全部商品掛到每個包裹上。
   *   配送狀況格  「出荷待ち」/「配達完了<br>配送会社：ヤマト運輸<br>408273350844」
   *   商品格      「TVXV-4763<br>アクリルスタンド …」（商品代碼、品名）
   *   個数        單價（第一個 td.cellPrice）右邊那一格
   *   合計        「お支払い合計 ¥45,680」 */
  const MUMO_DELIVERED_RE = /配達完了/;
  const MUMO_CARRIER_RE = /^配送会社\s*[:：]\s*(.+)$/;

  function mumoItem(row, cell) {
    const lines = linesOf(cell);
    return {
      title: lines.slice(1).join(' ') || lines[0] || '',
      quantity: Number(textOf(row.querySelector('td.cellPrice')?.nextElementSibling)) || 1,
      imageUrl: null, // 頁面上沒有商品圖
    };
  }

  function mumoParcels(doc) {
    const groups = [];
    for (const row of all(doc, 'table.tableCart tr')) {
      const deliv = row.querySelector('td.cellDeliv');
      if (deliv) groups.push({ lines: linesOf(deliv), items: [] });
      const item = row.querySelector('td.cellItem');
      if (item && groups.length) groups.at(-1).items.push(mumoItem(row, item));
    }
    // 已送達的包裹不擷取；沒有伝票番号的（出荷待ち）本來就不會有號碼
    return groups
      .filter((g) => !MUMO_DELIVERED_RE.test(g.lines[0] || ''))
      .flatMap((g) => {
        const carrier = g.lines.map((l) => MUMO_CARRIER_RE.exec(l)?.[1]).find(Boolean) || '';
        return g.lines
          .map((l) => l.replace(/-/g, ''))
          .filter((l) => /^[A-Za-z0-9]{8,}$/.test(l))
          .map((trackingId) => ({ carrier, trackingId, items: g.items.filter((i) => i.title) }));
      });
  }

  globalThis.OrderScraper.readers.mumoDetail = async (doc) => {
    if (doc.querySelector('input[type="password"]')) return { signIn: true };
    return { ok: true, total: parseMoney(textOf(doc.querySelector('.txtTotal'))), parcels: mumoParcels(doc) };
  };

  /* ---------- ZOZOTOWN：注文内容の詳細（detail.html?oid=…） ---------- */

  /* 伺服器渲染，fetch 取回就讀得到。商品與包裹的對應在列表頁就知道了，這裡只要：
   *   伝票番号  <th>伝票番号</th><td>293252106335<a>詳細</a></td>（「詳細」只是打開配送歷程，要拿掉）
   *   合計      <th>支払い金額</th><td>¥9,240</td>（避開商品合計 / 送料 / ZOZOポイント） */
  const zozoValue = (doc, label) => all(doc, 'th').find((th) => textOf(th) === label)?.nextElementSibling;

  function zozoTrackingIds(doc) {
    const cell = zozoValue(doc, '伝票番号');
    if (!cell) return [];
    const copy = cell.cloneNode(true);
    copy.querySelectorAll('a').forEach((a) => a.remove());
    const ids = linesOf(copy).flatMap((line) => line.split(/\s+/)).map((t) => t.replace(/-/g, ''));
    return [...new Set(ids.filter((t) => /^[A-Za-z0-9]{8,}$/.test(t)))];
  }

  globalThis.OrderScraper.readers.zozoDetail = async (doc) => {
    if (doc.querySelector('input[type="password"]')) return { signIn: true };
    return { ok: true, total: parseMoney(textOf(zozoValue(doc, '支払い金額'))), trackingIds: zozoTrackingIds(doc) };
  };

  /* ---------- plusmember：購入履歴詳細（history.php） ---------- */

  /* 伺服器渲染，fetch 取回就讀得到。標籤與值是同一個 ul.tit 裡相鄰的兩個 li：
   *   お問い合わせ番号  <li>お問い合わせ番号</li><li>353912840945</li>。還沒寄出時整組是空的
   *                     （頁面用 JS 把空的 ul.empty 藏起來）
   *   配送業者          「追跡確認」那一格連到業者的查詢頁，由網域判斷（util.carrierOf）
   *   商品              .item 裡一件一個 ul（ul.tit 是欄位名稱）：品名是商品連結（底下那串 JAN 不收），
   *                     個数是 li.quantity。頁面上沒有商品圖
   * 合計列表頁就有，這裡不讀。お問い合わせ番号只看過一個，所以一筆訂單就是一個包裹 */
  const plusmemberValue = (doc, label) =>
    all(doc, '.data ul.tit > li').find((li) => textOf(li) === label)?.nextElementSibling;

  function plusmemberParcels(doc) {
    const trackingId = textOf(plusmemberValue(doc, 'お問い合わせ番号')).replace(/-/g, '');
    if (!/^[A-Za-z0-9]{8,}$/.test(trackingId)) return [];
    const carrier = carrierOf(attr(plusmemberValue(doc, '追跡確認')?.querySelector('a[href]'), 'href'));
    const items = all(doc, '.item ul:not(.tit)')
      .map((ul) => ({
        title: textOf(ul.querySelector('a')),
        quantity: Number(textOf(ul.querySelector('li.quantity'))) || 1,
        imageUrl: null,
      }))
      .filter((item) => item.title);
    return [{ carrier, trackingId, items }];
  }

  globalThis.OrderScraper.readers.plusmemberDetail = async (doc) => {
    if (doc.querySelector('input[type="password"]')) return { signIn: true };
    return { ok: true, parcels: plusmemberParcels(doc) };
  };

  /* ---------- ちいかわくじ：購入履歴詳細（/mypage/history/…）與配送情報（/exchange/history/…） ---------- */

  /* Angular 前端渲染，只能在隱藏 iframe 裡等它畫出來。兩頁的網址都帶列表頁上沒有的 ID，
   * 由站台轉接層在 iframe 裡點過去（見 sites/kuji.js），這裡只負責讀。
   *   購入履歴詳細  .info-item 一格一個：.info-item-heading 是標籤（購入番号 / 購入日時 / 購入金額），
   *                 .info-item-body 是值。「配送情報を見る」是 div.shipment 裡的按鈕，沒有連結
   *   配送情報      引き換え番号 .shipment-number-value；配送業者 .carrier-name（「佐川急便 宅配便」）、
   *                 伝票番号 .carrier-tracking-code；這個包裹裡的獎品依くじ分組（sl-shipment-loots）。
   *                 配送情報頁上也有 .info-item（配送依頼日、配送料），但沒有「購入番号」，所以兩頁分得開 */
  const kujiInfo = (doc, heading) =>
    all(doc, '.info-item').find((item) => textOf(item.querySelector('.info-item-heading')) === heading)
      ?.querySelector('.info-item-body');

  // 還在 iframe 裡用（轉接層接著要點它），所以直接給按鈕元素
  const readKujiCheckout = (doc) => ({
    ok: true,
    purchaseNo: textOf(kujiInfo(doc, '購入番号')),
    orderedAt: parseDate(textOf(kujiInfo(doc, '購入日時'))),
    total: parseMoney(textOf(kujiInfo(doc, '購入金額'))),
    shipButton: doc.querySelector('div.shipment button'),
  });
  register('kujiCheckout', readKujiCheckout, (i) => bothReady(i.purchaseNo, i.shipButton));

  // 品名帶上くじ名與賞：「あくび」這種獎品名單獨看不出是哪一件
  const kujiPrizes = (doc) =>
    all(doc, 'sl-shipment-loots .lottery').flatMap((lottery) => {
      const name = textOf(lottery.querySelector('.lottery-name'));
      return all(lottery, '.lottery-prize-item').map((prize) => ({
        title: [
          name,
          textOf(prize.querySelector('.label-value')) + textOf(prize.querySelector('.label-suffix')),
          textOf(prize.querySelector('.name')),
        ].filter(Boolean).join(' '),
        quantity: 1,
        imageUrl: attr(prize.querySelector('.thumbnail-image'), 'src') || null,
      }));
    });

  const kujiTrackingId = (doc) => {
    const no = textOf(doc.querySelector('.carrier-tracking-code')).replace(/-/g, '');
    return /^[A-Za-z0-9]{8,}$/.test(no) ? no : '';
  };

  const readKujiExchange = (doc) => ({
    ok: true,
    exchangeNo: textOf(doc.querySelector('.shipment-number-value')),
    carrier: textOf(doc.querySelector('.carrier-name')),
    trackingId: kujiTrackingId(doc),
    items: kujiPrizes(doc),
  });
  register('kujiExchange', readKujiExchange, (i) => bothReady(i.exchangeNo, i.trackingId));
})();
