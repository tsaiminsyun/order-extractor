/* ちいかわくじ（online-kuji.chiikawamarket.jp）の購入履歴（/mypage/history）
 *
 * Angular 的單頁應用，三頁都是前端渲染：
 *   購入履歴      一次購入一張卡片（sl-lottery-checkout）：くじ名、回數、狀態。**沒有購入番号、日期，也沒有連結**
 *   購入履歴詳細  /mypage/history/{uuid}：購入番号、購入日時、購入金額、「配送情報を見る」按鈕（也沒有連結）
 *   配送情報      /exchange/history/{uuid}：引き換え番号、配送業者、伝票番号、這個包裹裡的獎品
 * 網址裡的 uuid 頁面上都找不到，所以照使用者的操作：在隱藏 iframe 裡打開購入履歴，點那張卡片，
 * 再點「配送情報を見る」—— 點擊會觸發頁面自己的程式，Angular 在 iframe 裡換頁。讀取器在 readers.js。
 *
 * くじ是抽完之後另外申請配送，一次配送可以包含好幾次購入的獎品，所以**一個包裹（引き換え番号）一列**。
 * 七天看的跟其他站台一樣是購入日時，但它只在詳細頁上：由新到舊一張一張打開，打開到第一張超過七天的就停。
 * 一般的翻頁流程（findOrders / nextPage）用不上，改由 scan 自己跑。
 * 狀態只看過「発送されました」（2025 年 5 月寄出的現在也還是），沒有送達的狀態。
 */
(() => {
  'use strict';
  const { sleep, all, readInFrame } = globalThis.OrderScraper.util;
  const { readers } = globalThis.OrderScraper;

  const LIST_TIMEOUT_MS = 15000;  // iframe 裡的列表畫出來的上限
  const POLL_MS = 200;

  const SEL = {
    card: 'sl-lottery-checkout.checkouts-item',  // 列表的一張卡片（詳細頁上那張是 .checkout）
    cardText: '.machine',                        // 點くじ名，事件會一路冒泡到卡片本身
  };

  async function until(get) {
    const deadline = Date.now() + LIST_TIMEOUT_MS;
    let found = get();
    while (!found && Date.now() < deadline) {
      await sleep(POLL_MS);
      found = get();
    }
    return found;
  }

  /* 在 iframe 裡：等列表畫出來 → 點第 index 張 → 讀詳細頁 → 七天內而且有「配送情報を見る」就點 → 讀配送情報。
   * 走不到詳細頁回 null */
  async function openPurchase(doc, index, isOld) {
    const card = await until(() => all(doc, SEL.card)[index]);
    if (!card) return null;
    (card.querySelector(SEL.cardText) || card).click();
    const checkout = await readers.kujiCheckout(doc);
    if (!checkout.purchaseNo) return null;
    if (isOld(checkout.orderedAt) || !checkout.shipButton) return { checkout, exchange: null };
    checkout.shipButton.click();
    return { checkout, exchange: await readers.kujiExchange(doc) };
  }

  // 讀不到的那一筆：放一個空的包裹，會被算進「讀不到配送資料」
  const unreadable = (orderedAt = null) => ({
    orderId: '', orderedAt, total: null, currency: 'JPY', shipments: [{ carrier: '', trackingId: '', items: [] }], lookups: [],
  });

  async function scan({ isOld, progress }) {
    const listUrl = location.href;
    const count = all(document, SEL.card).length;
    const byExchange = new Map();
    const scanned = [];
    for (let index = 0; index < count; index += 1) {
      progress({ phase: 'lookup', done: index, total: count });
      const got = await readInFrame(listUrl, (doc) => openPurchase(doc, index, isOld));
      // 打不開（iframe 被擋、逾時、需要重新登入）：報一個讀不到就停 —— 下一張多半也一樣，不必每張都等到逾時
      if (!got) {
        scanned.push(unreadable());
        break;
      }
      const { checkout, exchange } = got;
      if (isOld(checkout.orderedAt)) break;
      if (!exchange) continue; // 還沒申請配送
      if (!exchange.exchangeNo) {
        scanned.push(unreadable(checkout.orderedAt)); // 配送情報那頁沒畫出來
        continue;
      }
      // 同一個包裹含好幾次購入：只列一次，合計是這幾次的購入金額加總（不含配送料）
      const known = byExchange.get(exchange.exchangeNo);
      if (known) {
        if (checkout.total != null) known.total = (known.total ?? 0) + checkout.total;
        continue;
      }
      const order = {
        orderId: exchange.exchangeNo,
        orderedAt: checkout.orderedAt,
        total: checkout.total,
        currency: 'JPY',
        // 還沒寄出（沒有伝票番号）就沒有包裹可列，也不算讀不到
        shipments: exchange.trackingId
          ? [{ carrier: exchange.carrier, trackingId: exchange.trackingId, items: exchange.items }]
          : [],
        lookups: [],
      };
      byExchange.set(order.orderId, order);
      scanned.push(order);
    }
    return { scanned, pages: 1, atPageCap: false };
  }

  globalThis.OrderScraper.sites.push({
    name: 'kuji',
    label: 'ちいかわくじ',
    isOrderPage: (loc, doc) => /(^|\.)online-kuji\.chiikawamarket\.jp$/.test(loc.hostname) && !!doc.querySelector(SEL.card),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    scan,
  });
})();
