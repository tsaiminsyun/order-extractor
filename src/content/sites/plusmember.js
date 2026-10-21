/* plusmember（store.plusmember.jp）の購入履歴
 *
 * 列表頁一筆訂單一列（.list 裡一個 ul）：購入日時、購入店舗、注文番号、お支払い方法、合計金額、詳細。
 * **列表頁上沒有配送狀態**。お問い合わせ番号、配送業者、商品都只在購入履歴詳細（history.php），
 * 讀取器在 readers.js 的 plusmemberDetail —— 所以七天內的每一筆都要讀詳細頁。
 * 詳細頁上也只到「発送完了」，**沒有送達的狀態**，跟 Shopify 一樣只靠七天。
 *
 * 詳細頁是伺服器渲染的，用 fetch 讀，但它**不是一般連結**：「詳細」的 onclick 是
 *   fnChangeAction('./history.php'); fnKeySubmit('order_id', '985530876'); return false;
 * 由頁面自己的 JS 把注文番号填進表單再送出（見 detailRequest）。這裡照做一次。
 */
(() => {
  'use strict';
  const { textOf, attr, all, parseDate, parseMoney, nextPageLink, formRequest } = globalThis.OrderScraper.util;

  const SEL = {
    row: '.list > ul',                            // 一筆訂單；第一個 ul.tit 是欄位名稱
    id: 'li.id',
    time: 'li.time',                              // 「2026/05/19 13:50」
    total: 'li.total',                            // 「￥14,380」
    detail: 'li.detail a[onclick*="fnKeySubmit("]',
  };
  const ACTION_RE = /fnChangeAction\(\s*'([^']*)'/;
  const KEY_RE = /fnKeySubmit\(\s*'(\w+)'\s*,\s*'([^']*)'/;

  /* fnChangeAction / fnKeySubmit 的原始碼不在給的片段裡。照呼叫方式：
   *   fnChangeAction(網址) 換掉表單要送去的網址，fnKeySubmit(欄位名稱, 值) 填好那個欄位再送出
   * 所以找頁面上**有那個欄位**的表單，照瀏覽器送出表單的規則組出同樣的請求（util.formRequest）。
   * method 與其他欄位都照頁面上那張表單，不寫死。
   * 找不到就回 null —— 那筆會被算進「讀不到配送資料」 */
  function detailRequest(doc, pageUrl, onclick) {
    const action = ACTION_RE.exec(onclick)?.[1];
    const [, key, value] = KEY_RE.exec(onclick) || [];
    const form = key && doc.querySelector(`form [name="${key}"]`)?.closest('form');
    if (!action || !form) return null;
    return formRequest(form, new URL(action, pageUrl).href, { [key]: value });
  }

  function buildOrder(row, doc, pageUrl) {
    const order = {
      orderId: textOf(row.querySelector(SEL.id)),
      orderedAt: parseDate(textOf(row.querySelector(SEL.time))),
      total: parseMoney(textOf(row.querySelector(SEL.total))),
      currency: 'JPY',
      /* 列表上看不出寄出了沒：先放一個空的包裹，詳細頁讀到了就換成實際的（還沒寄出的話一個都沒有）；
       * 讀不到時它留著，會被算進「讀不到配送資料」 */
      shipments: [{ carrier: '', trackingId: '', items: [] }],
      lookups: [],
    };
    const request = detailRequest(doc, pageUrl, attr(row.querySelector(SEL.detail), 'onclick'));
    if (!request) return order;
    order.lookups.push({
      ...request,
      reader: 'plusmemberDetail',
      via: 'fetch',
      apply: (info) => { order.shipments = info.parcels; },
    });
    return order;
  }

  // 用頁面特徵判斷：訂單列表裡有「詳細」（fnKeySubmit(…)）。詳細頁沒有這個列表
  const hasOrders = (doc) => !!doc.querySelector(`${SEL.row} ${SEL.detail}`);

  globalThis.OrderScraper.sites.push({
    name: 'plusmember',
    label: 'plusmember',
    isOrderPage: (loc, doc) => /(^|\.)plusmember\.jp$/.test(loc.hostname) && hasOrders(doc),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 實際的分頁還沒看過（給的片段裡沒有分頁區塊），先走通用規則
    nextPage: (doc, pageUrl) => {
      const url = nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) =>
      all(doc, SEL.row).map((row) => buildOrder(row, doc, pageUrl)).filter((o) => o.orderId),
  });
})();
