/* mu-mo ショップ（shop.mu-mo.net）の購入履歴・配送状況一覧（/avx/sv/mypordhist05）
 *
 * 列表頁有：注文日、注文番号、商品摘要（「…他6商品」）、配送先、配送状況。
 * 配送会社 / 伝票番号 / 個数 / 合計 只在詳細頁（讀取器在 readers.js 的 mumoDetail）。
 * 詳細頁是伺服器渲染的，用 fetch 讀，但它**不是一般連結**：「履歴詳細」呼叫頁面自己的
 * detail(id, tel)，把注文的代碼填進表單再送出（見 detailRequest）。這裡照做一次。
 */
(() => {
  'use strict';
  const { textOf, attr, all, parseDate, nextPageLink, formRequest } = globalThis.OrderScraper.util;

  const SEL = {
    row: 'table.tableCart tr',
    head: 'th.cellHead',                       // 「▼P 2026/10/06ご注文（履歴詳細）」，一筆訂單從這裡開始
    detailLink: 'a[onclick*="detail("]',       // onclick="javascript: detail('<order_id>', '<order_tel>');"
    form: 'form[name="jumpdetail"]',
  };
  // 只比對前兩個參數：存下來的頁面被格式化過，第二個參數後面多了逗號（detail('…', '…',\n)）
  const DETAIL_ARGS_RE = /detail\(\s*'([^']*)'\s*,\s*'([^']*)'/;

  /* 列表上的配送状況。這兩種確定沒有東西在路上；其他的（包括還沒看過的字樣，
   * 例如配送中的寫法）一律去讀詳細頁，由詳細頁逐個包裹判斷 */
  const SETTLED_RE = /^(?:出荷待ち|配達完了)$/;

  /* 頁面的 detail()（使用者從 DevTools 取得的原始碼）：
   *   document.jumpdetail.action = "https://shop.mu-mo.net/avx/sv/mypordhist03usr?ordid=" + id;
   *   document.jumpdetail.order_id.value = id;
   *   document.jumpdetail.order_tel.value = tel;
   *   document.jumpdetail.submit();
   * 表單的 method 與其他欄位沒寫在裡面，所以不寫死，直接讀頁面上那張表單，
   * 照瀏覽器送出表單的規則組出同樣的請求（util.formRequest）。
   * 頁面上沒有那張表單就回 null（detail() 本身也會失敗） */
  function detailRequest(doc, pageUrl, id, tel) {
    const form = doc.querySelector(SEL.form);
    if (!form) return null;
    // detail() 寫的是 https://shop.mu-mo.net/…，在那個網站上就等於以目前頁面為基準的這個路徑
    const action = new URL(`/avx/sv/mypordhist03usr?ordid=${id}`, pageUrl).href;
    return formRequest(form, action, { order_id: id, order_tel: tel });
  }

  /* 一筆訂單：th.cellHead 那一列 → 欄位名稱列 → 一或多列資料。
   * 一筆訂單分成好幾個配送時，注文番号那格用 rowspan 跨列，之後的列少了左邊幾格，
   * 所以欄位一律從右邊對齊 */
  function readBlocks(doc) {
    const blocks = [];
    let columns = [];
    for (const row of all(doc, SEL.row)) {
      const head = row.querySelector(SEL.head);
      if (head) {
        blocks.push({ head, orderId: '', statuses: [] });
        continue;
      }
      const block = blocks.at(-1);
      const cells = [...row.children];
      if (!block || !cells.length) continue;
      if (cells.every((c) => c.tagName === 'TH')) {
        columns = cells.map(textOf);
        continue;
      }
      const at = (name) => {
        const i = columns.indexOf(name);
        return i < 0 ? null : cells[cells.length - (columns.length - i)];
      };
      if (cells.length === columns.length) block.orderId ||= textOf(at('注文番号'));
      const status = textOf(at('配送状況'));
      if (status) block.statuses.push(status);
    }
    return blocks;
  }

  function buildOrder(block, doc, pageUrl) {
    const order = {
      orderId: block.orderId,
      orderedAt: parseDate(textOf(block.head)),
      total: null,
      currency: 'JPY',
      shipments: [],
      lookups: [],
    };
    // 全部是出荷待ち / 配達完了 → 沒有東西在路上，連詳細頁都不讀（空的訂單，注文日留給翻頁判斷）
    if (block.statuses.length && block.statuses.every((s) => SETTLED_RE.test(s))) return order;

    /* 可能有東西在路上：先放一個空的包裹。詳細頁讀到了就換成實際的包裹（可能一個都沒有，
     * 例如還沒看過的「入金待ち」之類）；讀不到時它留著，會被算進「讀不到配送資料」 */
    order.shipments = [{ carrier: '', trackingId: '', items: [] }];
    const [, id, tel] = DETAIL_ARGS_RE.exec(attr(block.head.querySelector(SEL.detailLink), 'onclick')) || [];
    const request = id ? detailRequest(doc, pageUrl, id, tel) : null;
    if (!request) return order;
    order.lookups.push({
      ...request,
      reader: 'mumoDetail',
      via: 'fetch',
      apply: (info) => {
        order.total = info.total ?? null;
        order.shipments = info.parcels;
      },
    });
    return order;
  }

  // 用頁面特徵判斷：表格裡有「履歴詳細」（detail(…)）的訂單標頭。詳細頁的表格沒有這個連結
  const hasOrders = (doc) => !!doc.querySelector(`${SEL.row} ${SEL.head} ${SEL.detailLink}`);

  globalThis.OrderScraper.sites.push({
    name: 'mumo',
    label: 'mu-mo ショップ',
    isOrderPage: (loc, doc) => /(^|\.)mu-mo\.net$/.test(loc.hostname) && hasOrders(doc),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 實際的分頁還沒看過（表格帶 tablePager，分頁區塊不在給的片段裡），先走通用規則
    nextPage: (doc, pageUrl) => {
      const url = nextPageLink(doc, pageUrl);
      return url ? { url, via: 'fetch' } : null;
    },
    findOrders: (doc, pageUrl) =>
      readBlocks(doc).map((block) => buildOrder(block, doc, pageUrl)).filter((o) => /^\d+$/.test(o.orderId)),
  });
})();
