/* popup：
 * - 支不支援目前的分頁，要由 content script 回答，不能用寫死的網域清單判斷
 *   （曾經因為網域清單沒有 chiikawamarket.jp，popup 連問都不問就停用擷取按鈕）
 * - 擷取前先列出這一頁的訂單讓使用者勾，預設勾選七天內下單的那些
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Check, JSDOM } = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');

// 以今天為基準往回數 n 天。用中午建構，避開日光節約與時區跨日
const day = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const order = (orderId, orderedAt, extra = {}) =>
  ({ orderId, orderedAt, total: 1000, currency: 'JPY', trackingIds: [], itemCount: 1, needsLookup: true, ...extra });

// popup.js 一載入就會跑 checkTab()，所以每個情境都要重新載入一次（用查詢字串避開模組快取）
let seq = 0;
async function openPopup({ tabUrl, pong, orders = [], injectFails = false, pingThrows = false, previewFails = false }) {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test/popup.html' });
  const injected = [];
  const sent = [];
  let pinged = 0;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
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
        if (msg.type === 'PREVIEW') {
          return previewFails ? { ok: false, error: '解析失敗' } : { ok: true, orders };
        }
        if (msg.type === 'SCRAPE') return { ok: true, site: 'test', orders: [] };
        return undefined;
      },
    },
    scripting: {
      executeScript: async ({ files }) => {
        if (injectFails) throw new Error('無法注入');
        injected.push(...files);
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  await import(`${pathToFileURL(path.join(ROOT, 'popup.js')).href}?v=${seq += 1}`);
  await new Promise((r) => setTimeout(r, 0)); // 等 checkTab() 跑完
  const d = dom.window.document;
  const boxes = () => [...d.querySelectorAll('#candidateList input[type="checkbox"]')];
  return {
    d,
    status: d.getElementById('status').textContent,
    isError: d.getElementById('status').classList.contains('error'),
    scrapeEnabled: !d.getElementById('scrape').disabled,
    scrapeLabel: d.getElementById('scrape').textContent,
    hint: d.getElementById('candidateHint').textContent,
    listed: boxes().map((b) => b.value),
    checked: boxes().filter((b) => b.checked).map((b) => b.value),
    boxes,
    sent,
    // popup.html 本來就有「擷取訂單」「下載 JSON」和「全選」，多出來的就是程式動態加的
    extraButtons: d.querySelectorAll('button').length - 2,
    injected, pinged,
  };
}

const SHOPIFY = { ok: true, onOrderPage: true, site: 'shopify', label: 'Shopify 商店' };

module.exports = async function run() {
  const c = new Check('popup');

  /* 1. 任何網域，只要 content script 說支援就能擷取 */
  {
    const shopify = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account?page=1',
      pong: SHOPIFY,
      orders: [order('A1', day(0))],
    });
    c.eq('不在清單上的網域也會先問 content script', shopify.pinged > 0, true);
    c.eq('狀態顯示站台名稱', shopify.status, '已就緒（Shopify 商店）');
    c.eq('列出這一頁的訂單', shopify.listed, ['A1']);
    c.eq('有勾選就能擷取', shopify.scrapeEnabled, true);
  }

  /* 2. 原本就支援的站台不受影響 */
  {
    const amazon = await openPopup({
      tabUrl: 'https://www.amazon.co.jp/gp/css/order-history',
      pong: { ok: true, onOrderPage: true, site: 'amazon', label: 'Amazon.co.jp' },
      orders: [order('B1', day(1))],
    });
    c.eq('Amazon 可以擷取', [amazon.scrapeEnabled, amazon.status], [true, '已就緒（Amazon.co.jp）']);
  }

  /* 3. 預設勾選七天內下單的訂單 */
  {
    const p = await openPopup({
      tabUrl: 'https://tower.jp/ec/Customer/Order/List',
      pong: { ok: true, onOrderPage: true, site: 'tower', label: 'タワーレコード' },
      orders: [
        order('今天', day(0)),
        order('第6天', day(6)),
        order('第7天', day(7)),
        order('第30天', day(30)),
        order('沒日期', null),
      ],
    });
    c.eq('全部都列出來', p.listed, ['今天', '第6天', '第7天', '第30天', '沒日期']);
    c.eq('只勾七天內的（含今天，第 7 天已經超過）', p.checked, ['今天', '第6天']);
    c.eq('日期不明的不預設勾選', p.checked.includes('沒日期'), false);
    c.eq('提示寫出筆數', p.hint, '共 5 筆，已勾選 7 天內的 2 筆');
    c.eq('按鈕寫出勾了幾筆', p.scrapeLabel, '擷取選取的 2 筆');
  }

  /* 4. 勾選狀態改變時按鈕跟著更新；全部取消就不能擷取 */
  {
    const p = await openPopup({
      tabUrl: 'https://tower.jp/ec/Customer/Order/List',
      pong: { ok: true, onOrderPage: true, site: 'tower', label: 'タワーレコード' },
      orders: [order('X1', day(0)), order('X2', day(20))],
    });
    const [first, second] = p.boxes();

    second.checked = true;
    second.dispatchEvent(new p.d.defaultView.Event('change'));
    c.eq('手動勾選舊訂單', p.d.getElementById('scrape').textContent, '擷取選取的 2 筆');

    first.checked = false;
    second.checked = false;
    for (const b of [first, second]) b.dispatchEvent(new p.d.defaultView.Event('change'));
    c.eq('全部取消 → 不能擷取', p.d.getElementById('scrape').disabled, true);
    c.eq('全部取消 → 按鈕文字還原', p.d.getElementById('scrape').textContent, '擷取選取的訂單');
  }

  /* 5. 全選 */
  {
    const p = await openPopup({
      tabUrl: 'https://tower.jp/ec/Customer/Order/List',
      pong: { ok: true, onOrderPage: true, site: 'tower', label: 'タワーレコード' },
      orders: [order('Y1', day(0)), order('Y2', day(90)), order('Y3', null)],
    });
    const selectAll = p.d.getElementById('selectAll');
    c.eq('部分勾選時全選是未定狀態', [selectAll.checked, selectAll.indeterminate], [false, true]);

    selectAll.checked = true;
    selectAll.dispatchEvent(new p.d.defaultView.Event('change'));
    c.eq('全選把每一筆都勾起來', p.boxes().filter((b) => b.checked).length, 3);
  }

  /* 6. 擷取時只送出勾選的注文番号 */
  {
    const p = await openPopup({
      tabUrl: 'https://tower.jp/ec/Customer/Order/List',
      pong: { ok: true, onOrderPage: true, site: 'tower', label: 'タワーレコード' },
      orders: [order('Z1', day(0)), order('Z2', day(2)), order('Z3', day(60))],
    });
    p.d.getElementById('scrape').click();
    await new Promise((r) => setTimeout(r, 0));
    const scrape = p.sent.find((m) => m.type === 'SCRAPE');
    c.eq('只送出勾選的那幾筆', scrape?.payload?.orderIds, ['Z1', 'Z2']);
    c.eq('沒勾的不會被送出', scrape?.payload?.orderIds.includes('Z3'), false);
  }

  /* 7. content script 說不支援 → 不列清單、不能擷取 */
  {
    const other = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/products/abc',
      pong: { ok: true, onOrderPage: false, site: null, label: null },
    });
    c.eq('不支援就停用擷取', other.scrapeEnabled, false);
    c.eq('顯示錯誤狀態', other.isError, true);
    c.eq('不支援時只給訊息，不加任何按鈕', other.extraButtons, 0);
    c.eq('不支援時不會問 PREVIEW', other.sent.some((m) => m.type === 'PREVIEW'), false);
  }

  /* 8. 這一頁沒有可擷取的訂單 */
  {
    const empty = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      orders: [],
    });
    c.eq('沒有訂單就停用擷取', empty.scrapeEnabled, false);
    c.eq('說清楚是沒有訂單，不是不支援', empty.status, '這一頁沒有可擷取的訂單（Shopify 商店）');
  }

  /* 9. 解析失敗 → 給訊息，不要整個壞掉 */
  {
    const broken = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account',
      pong: SHOPIFY,
      previewFails: true,
    });
    c.eq('解析失敗時停用擷取', broken.scrapeEnabled, false);
    c.eq('解析失敗時顯示錯誤', broken.isError, true);
  }

  /* 10. 分頁裡還沒有 content script → 先注入再問 */
  {
    const fresh = await openPopup({
      tabUrl: 'https://nagano-market.jp/account',
      pong: SHOPIFY,
      orders: [order('N1', day(0))],
      pingThrows: true,
    });
    c.eq('注入了 content script', fresh.injected.includes('src/content/main.js'), true);
    c.eq('注入後可以擷取', fresh.scrapeEnabled, true);
  }

  /* 11. 注入不進去（chrome:// 等頁面）→ 給訊息，不要整個壞掉 */
  {
    const blocked = await openPopup({
      tabUrl: 'chrome://extensions',
      pong: SHOPIFY,
      pingThrows: true,
      injectFails: true,
    });
    c.eq('無法注入時停用擷取', blocked.scrapeEnabled, false);
    c.eq('無法注入時顯示錯誤', blocked.isError, true);
    c.eq('無法注入時也不加任何按鈕', blocked.extraButtons, 0);
  }

  return c.report();
};
