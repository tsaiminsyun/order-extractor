/* タワーレコード オンライン（tower.jp）の注文履歴
 *
 * 這個站台**不必另外載入任何頁面**：注文番号 / 合計 / 品名 / 画像 / 数量 / 伝票番号
 * 全都在列表頁上（Amazon 與樂天都得多讀一頁）。
 *
 * 一個 .deliveryBox 就是一次配送 —— 注文番号旁邊的「配送1」就是這個意思。
 * 同一筆訂單分批出貨時會有多個 .deliveryBox，所以依注文番号把它們併成一筆訂單，
 * 每個 .deliveryBox 各自是一個包裹。
 */
(() => {
  'use strict';
  const { clean, textOf, attr, all, parseMoney } = globalThis.OrderScraper.util;

  const SEL = {
    box: '.deliveryBox',
    about: '.deliveryAbout',   // 注文番号 / 注文日 / 数量 / 注文合計 的那幾張小表
    label: 'td.ttl',
    shipmentNo: '.dlvrIcon',   // 「配送1」：跟在注文番号後面，不是番号的一部分
    item: '.deliveryItemBox',
    title: '.title a',
    image: '.deliveryThum img',
    qty: '.ship-num span',
    itemDetail: '.pDetail',    // 「￥1,650　数量：1」
    tracking: '.deliveryRightClm',
  };

  const LABELS = { orderId: '注文番号', total: '注文合計' };

  /* 配送業者由伝票番号的查詢網址判斷。頁面上也有「配送業者」欄位，但那是下單時的
   * 指定（實際頁面上是「指定なし」），不是真正送件的業者，不能拿來用 */
  const CARRIERS = [
    [/(^|\.)japanpost\.jp$/, '日本郵便'],
    [/(^|\.)kuronekoyamato\.co\.jp$/, 'ヤマト運輸'],
    [/(^|\.)sagawa-exp\.co\.jp$/, '佐川急便'],
  ];
  const carrierOf = (href) => {
    try { return CARRIERS.find(([host]) => host.test(new URL(href).hostname))?.[1] || ''; }
    catch { return ''; }
  };

  /* ---------- 欄位 ---------- */

  // 標籤與值是同一列的兩格：<td class="ttl">注文番号</td><td>：26J08212058264<span>配送1</span></td>
  function valueOf(box, label) {
    const scope = box.querySelector(SEL.about) || box;
    const cell = all(scope, SEL.label).find((td) => textOf(td) === label)?.nextElementSibling;
    if (!cell) return '';
    const copy = cell.cloneNode(true);
    copy.querySelectorAll(SEL.shipmentNo).forEach((el) => el.remove());
    return clean(copy.textContent).replace(/^[：:]\s*/, '');
  }

  // 数量：「数量：1」（.ship-num）→ 商品明細的「￥1,650　数量：1」→ 都沒有就當 1 件
  const QTY_RE = /数量\s*[:：]\s*(\d+)/;
  const quantityIn = (item) =>
    Number(textOf(item.querySelector(SEL.qty)))
    || Number(QTY_RE.exec(textOf(item.querySelector(SEL.itemDetail)))?.[1])
    || 1;

  function findItems(box) {
    return all(box, SEL.item)
      .map((item) => {
        const img = item.querySelector(SEL.image);
        return {
          title: textOf(item.querySelector(SEL.title)) || clean(attr(img, 'alt')),
          quantity: quantityIn(item),
          imageUrl: attr(img, 'src') || null,
        };
      })
      .filter((item) => item.title);
  }

  /* 配送問い合わせ番号：連到配送業者查詢頁的那個連結，連結文字就是伝票番号。
   * 同一區塊裡的「領収書」連結是站內的相對路徑，所以只看絕對網址就排除得掉 */
  const TRACKING_RE = /^[A-Za-z0-9-]{8,}$/;
  function readShipment(box) {
    const scope = box.querySelector(SEL.tracking) || box;
    for (const link of all(scope, 'a[href^="http"]')) {
      const trackingId = textOf(link);
      if (TRACKING_RE.test(trackingId)) return { carrier: carrierOf(attr(link, 'href')), trackingId };
    }
    return null;
  }

  /* ---------- 組合 ---------- */

  // 同一個注文番号的多次配送併成一筆訂單（main.js 會依注文番号去重，分開回傳會被吃掉）
  function groupByOrderId(doc) {
    const byId = new Map();
    for (const box of all(doc, SEL.box)) {
      const orderId = valueOf(box, LABELS.orderId);
      if (!orderId) continue;
      if (!byId.has(orderId)) byId.set(orderId, []);
      byId.get(orderId).push(box);
    }
    return byId;
  }

  // 沒有伝票番号的配送還沒出貨，不擷取；整筆訂單都沒有就回傳 null
  function buildOrder(orderId, boxes) {
    const shipments = boxes
      .map((box) => ({ shipment: readShipment(box), items: findItems(box) }))
      .filter(({ shipment }) => shipment)
      .map(({ shipment, items }) => ({ ...shipment, items }));
    if (!shipments.length) return null;
    return { orderId, total: parseMoney(valueOf(boxes[0], LABELS.total)), currency: 'JPY', shipments, lookups: [] };
  }

  // 用頁面特徵判斷，不寫死路徑 —— 會員頁的網址可能改，版面上的這幾個記號比較穩
  const hasOrders = (doc) =>
    all(doc, `${SEL.box} ${SEL.label}`).some((td) => textOf(td) === LABELS.orderId);

  globalThis.OrderScraper.sites.push({
    name: 'tower',
    label: 'タワーレコード',
    isOrderPage: (loc, doc) => /(^|\.)tower\.jp$/.test(loc.hostname) && loc.pathname.startsWith('/ec/') && hasOrders(doc),
    isSignInPage: (doc, url) => /\/ec\/.*(?:login|signin)/i.test(url),
    findOrders: (doc) => [...groupByOrderId(doc)].map(([orderId, boxes]) => buildOrder(orderId, boxes)),
  });
})();
