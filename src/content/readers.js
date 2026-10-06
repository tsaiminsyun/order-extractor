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

  // 出貨狀態區塊。配送業者 / 伝票番号 一定在這裡面
  const SHIPPING_BLOCK = cls('shipping-status');

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
  const carrierLinks = (doc) =>
    all(doc, `${SHIPPING_BLOCK} a[href^="http"]`)
      .filter((a) => isExternal(attr(a, 'href')))
      .map((a) => ({ carrier: clean(attr(a, 'aria-label')), trackingId: trackingInHref(attr(a, 'href')) }))
      .filter((s) => s.carrier && s.trackingId);

  // 一筆訂單可能有多個伝票番号（分批出貨），依出現順序配對
  function rakutenShipments(doc) {
    const carriers = labelsIn(doc, RAKUTEN_LABELS.carrier).map(valueOf);
    const trackingIds = labelsIn(doc, RAKUTEN_LABELS.trackingId).map(valueOf).filter(Boolean);
    if (trackingIds.length) {
      return trackingIds.map((trackingId, i) => ({ carrier: carriers[i] || carriers[0] || '', trackingId }));
    }
    return carrierLinks(doc);
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
    shipments: rakutenShipments(doc),
    quantities: rakutenQuantities(doc),
  });

  register('rakutenDetail', readRakutenDetail, (i) => bothReady(i.total, i.shipments.length));
})();
