/* popup：
 * - 支不支援目前的分頁，要由 content script 回答，不能用寫死的網域清單判斷
 *   （曾經因為網域清單沒有 chiikawamarket.jp，popup 連問都不問就停用擷取按鈕）
 * - 一打開就整套跑完：表格上就是最終結果（注文番号 / 品名 / 合計 / 配送業者・ID），
 *   每一列可以勾選，按「下載 JSON」只下載勾選的那幾列。中間沒有「擷取」這一步
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Check, JSDOM } = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
// popup.html 本來就只有「下載 JSON」一顆按鈕，多出來的才是程式動態加的
const BUILT_IN_BUTTONS = 1;

// content script 回傳的包裹（main.js 已經過濾成七天內、有 tracking ID 的）
const parcel = (orderId, trackingId, extra = {}) => ({
  orderId,
  orderedAt: '2026-10-12',
  total: 1000,
  currency: 'JPY',
  carrier: 'ヤマト運輸',
  trackingId,
  items: [{ title: `${orderId} の商品`, quantity: 1, imageUrl: null }],
  ...extra,
});

const result = (orders, extra = {}) =>
  ({ ok: true, site: 'shopify', recentDays: 7, pages: 1, missingTracking: 0, orders, ...extra });

// popup.js 一載入就會跑 start()，所以每個情境都要重新載入一次（用查詢字串避開模組快取）
let seq = 0;
async function openPopup({ tabUrl, pong, scraped, injectFails = false, pingThrows = false }) {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test/popup.html' });
  const injected = [];
  const sent = [];
  const downloads = [];
  let pinged = 0;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  // 下載：攔下 Blob 的內容，看實際存出去的是哪幾筆
  globalThis.URL.createObjectURL = (blob) => { downloads.push(blob); return 'blob:test'; };
  globalThis.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function click() {};
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [{ id: 7, url: tabUrl }],
      sendMessage: async (_id, msg) => {
        sent.push(msg);
        if (msg.type === 'PING') {
          pinged += 1;
          if (pingThrows && !injected.length) throw new Error('沒有 content script');
          return pong;
        }
        if (msg.type === 'SCRAPE') return scraped;
        return undefined;
      },
    },
    scripting: {
      executeScript: async ({ files }) => {
        if (injectFails) throw new Error('無法注入');
        injected.push(...files);
      },
    },
  };
  await import(`${pathToFileURL(path.join(ROOT, 'popup.js')).href}?v=${seq += 1}`);
  await new Promise((r) => setTimeout(r, 0)); // 等 start() 跑完
  const d = dom.window.document;
  const boxes = () => [...d.querySelectorAll('#preview tbody input[type="checkbox"]')];
  const fire = (el) => el.dispatchEvent(new dom.window.Event('change'));
  const downloaded = async () => JSON.parse(await downloads.at(-1).text());
  return {
    d, boxes, fire, sent, injected, downloads, downloaded,
    pinged: () => pinged,
    get status() { return d.getElementById('status').textContent; },
    get isError() { return d.getElementById('status').classList.contains('error'); },
    get warning() {
      const w = d.getElementById('warning');
      return w.classList.contains('hidden') ? '' : w.textContent;
    },
    get rows() { return [...d.querySelectorAll('#preview tbody tr')]; },
    get headers() { return [...d.querySelectorAll('#preview thead th')].map((th) => th.textContent); },
    get checked() { return boxes().filter((b) => b.checked).length; },
    get saveBtn() { return d.getElementById('saveJson'); },
    get resultShown() { return !d.getElementById('result').classList.contains('hidden'); },
    get extraButtons() { return d.querySelectorAll('button').length - BUILT_IN_BUTTONS; },
  };
}

const SHOPIFY = { ok: true, onOrderPage: true, site: 'shopify', label: 'Shopify 商店' };

module.exports = async function run() {
  const c = new Check('popup');

  /* 1. 打開就跑完，表格就是最終結果 —— 沒有「擷取」那一步 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account?page=1',
      pong: SHOPIFY,
      scraped: result([parcel('A1', '111'), parcel('A2', '222')]),
    });
    c.eq('不在清單上的網域也會先問 content script', p.pinged() > 0, true);
    c.eq('打開就送出擷取', p.sent.some((m) => m.type === 'SCRAPE'), true);
    c.eq('沒有「擷取」按鈕，只有下載', p.d.getElementById('scrape'), null);
    c.eq('狀態顯示站台名稱', p.status, '已就緒（Shopify 商店）');
    c.eq('欄位依序是 注文番号 / 品名 / 合計 / 配送業者・ID',
      p.headers.slice(1), ['注文番号', '品名', '合計', '配送業者 / ID']);
    c.eq('一個包裹一列', p.rows.length, 2);
    c.eq('每一列都有 checkbox', p.boxes().length, 2);
  }

  /* 2. 每一列的內容 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('B1', '510965337234', {
        total: 3410,
        carrier: 'Yamato (JA)',
        items: [{ title: 'ステッカー', quantity: 1 }, { title: 'マスコット', quantity: 3 }],
      })]),
    });
    const cells = [...p.rows[0].querySelectorAll('td')].map((td) => td.textContent.trim());
    c.eq('注文番号', cells[1], 'B1');
    c.eq('品名一件一行，2 件以上才標數量',
      [...p.rows[0].querySelectorAll('.title')].map((t) => t.textContent), ['ステッカー', 'マスコット ×3']);
    c.eq('合計', cells[3], '¥3,410');
    c.eq('配送業者 / ID', cells[4], 'Yamato (JA) 510965337234');
  }

  /* 3. 預設全部勾選，下載按鈕寫出筆數 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('C1', '1'), parcel('C2', '2'), parcel('C3', '3')]),
    });
    c.eq('預設全部勾選', p.checked, 3);
    c.eq('下載按鈕寫出筆數', p.saveBtn.textContent, '下載 JSON（3 筆）');
    c.eq('提示寫出天數與包裹數', p.d.getElementById('summary').textContent, '7 天內 3 個包裹');
  }

  /* 4. 只下載勾選的 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('D1', '111'), parcel('D2', '222'), parcel('D3', '333')]),
    });
    const [, second] = p.boxes();
    second.checked = false;
    p.fire(second);
    c.eq('取消一筆後按鈕跟著變', p.saveBtn.textContent, '下載 JSON（2 筆）');

    p.saveBtn.click();
    const json = await p.downloaded();
    c.eq('只下載勾選的那幾筆', json.map((o) => o.trackingId), ['111', '333']);
    c.eq('下載的是匯出格式（不是畫面上的文字）', Object.keys(json[0]),
      ['orderId', 'orderedAt', 'total', 'currency', 'carrier', 'trackingId', 'items']);
  }

  /* 5. 全選 / 全不選 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('E1', '1'), parcel('E2', '2')]),
    });
    const selectAll = p.d.getElementById('selectAll');
    c.eq('全部勾著時全選也是勾的', [selectAll.checked, selectAll.indeterminate], [true, false]);

    selectAll.checked = false;
    p.fire(selectAll);
    c.eq('全不選', p.checked, 0);
    c.eq('沒勾任何一筆就不能下載', p.saveBtn.disabled, true);
    c.eq('按鈕文字還原', p.saveBtn.textContent, '下載 JSON');

    const [first] = p.boxes();
    first.checked = true;
    p.fire(first);
    c.eq('部分勾選時全選是未定狀態', [selectAll.checked, selectAll.indeterminate], [false, true]);
  }

  /* 6. 注文日讀不到的包裹：列出來但不預設勾選（不知道是不是七天內，別替使用者決定） */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('F1', '1'), parcel('F2', '2', { orderedAt: null })]),
    });
    c.eq('兩筆都列出來', p.rows.length, 2);
    c.eq('日期不明的不預設勾選', p.boxes().map((b) => b.checked), [true, false]);
    c.eq('標出日期不明', p.rows[1].textContent.includes('日期不明'), true);
  }

  /* 7. 翻了幾頁要講出來，不然使用者會以為只來自眼前這一頁 */
  {
    const many = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('G1', '1')], { pages: 3 }),
    });
    c.eq('狀態寫出翻了幾頁', many.status, '已就緒（Shopify 商店，翻了 3 頁）');
  }

  /* 8. 配送中卻讀不到 tracking ID 的包裹：不列，但要說 */
  {
    const p = await openPopup({
      tabUrl: 'https://www.amazon.co.jp/your-orders/orders',
      pong: { ok: true, onOrderPage: true, site: 'amazon', label: 'Amazon.co.jp' },
      scraped: result([parcel('H1', '1')], { missingTracking: 2 }),
    });
    c.eq('有警告', p.warning, '另有 2 個配送中的包裹讀不到配送資料，沒有列出來');
    c.eq('其餘照常列出', p.rows.length, 1);
  }

  /* 9. 七天內沒有配送中的訂單 */
  {
    const p = await openPopup({ tabUrl: 'https://chiikawamarket.jp/account', pong: SHOPIFY, scraped: result([]) });
    c.eq('說清楚是沒有，不是壞掉', p.status, '7 天內沒有配送中的訂單（Shopify 商店）');
    c.eq('不顯示表格', p.resultShown, false);
  }

  /* 10. 擷取失敗 → 給訊息，不要整個壞掉 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      scraped: { ok: false, error: '需要重新登入，請在分頁登入後再試一次' },
    });
    c.eq('顯示錯誤', [p.isError, p.status], [true, '擷取失敗：需要重新登入，請在分頁登入後再試一次']);
    c.eq('不顯示表格', p.resultShown, false);
  }

  /* 11. content script 說不支援 → 不擷取 */
  {
    const p = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/products/abc',
      pong: { ok: true, onOrderPage: false, site: null, label: null },
    });
    c.eq('顯示錯誤狀態', [p.isError, p.status], [true, '目前的分頁不是支援的訂單紀錄頁']);
    c.eq('不支援時不會送出擷取', p.sent.some((m) => m.type === 'SCRAPE'), false);
    c.eq('不支援時不加任何按鈕', p.extraButtons, 0);
  }

  /* 12. 分頁裡還沒有 content script → 先注入再問 */
  {
    const p = await openPopup({
      tabUrl: 'https://nagano-market.jp/account',
      pong: SHOPIFY,
      scraped: result([parcel('N1', '1')]),
      pingThrows: true,
    });
    c.eq('注入了 content script', p.injected.includes('src/content/main.js'), true);
    c.eq('注入後照常擷取', p.rows.length, 1);
  }

  /* 13. 注入不進去（chrome:// 等頁面）→ 給訊息，不要整個壞掉 */
  {
    const p = await openPopup({ tabUrl: 'chrome://extensions', pong: SHOPIFY, pingThrows: true, injectFails: true });
    c.eq('無法注入時顯示錯誤', [p.isError, p.status], [true, '這個分頁無法擷取，請開啟訂單紀錄頁後重試']);
    c.eq('無法注入時不加任何按鈕', p.extraButtons, 0);
  }

  return c.report();
};
