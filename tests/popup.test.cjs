/* popup：支不支援目前的分頁，要由 content script 回答，不能用寫死的網域清單判斷。
 * （曾經因為網域清單沒有 chiikawamarket.jp，popup 連問都不問就停用擷取按鈕） */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Check, JSDOM } = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');

// popup.js 一載入就會跑 checkTab()，所以每個情境都要重新載入一次（用查詢字串避開模組快取）
let seq = 0;
async function openPopup({ tabUrl, pong, injectFails = false, pingThrows = false }) {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test/popup.html' });
  const injected = [];
  let pinged = 0;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [{ id: 7, url: tabUrl }],
      create: () => {},
      sendMessage: async (_id, msg) => {
        if (msg.type !== 'PING') return;
        pinged += 1;
        if (pingThrows && !injected.length) throw new Error('沒有 content script');
        return pong;
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
  return {
    status: d.getElementById('status').textContent,
    isError: d.getElementById('status').classList.contains('error'),
    scrapeEnabled: !d.getElementById('scrape').disabled,
    shortcuts: [...d.querySelectorAll('.open-site')].map((b) => b.textContent),
    injected, pinged,
  };
}

module.exports = async function run() {
  const c = new Check('popup');

  /* 1. 任何網域，只要 content script 說支援就能擷取 */
  {
    const shopify = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/account?page=1',
      pong: { ok: true, onOrderPage: true, site: 'shopify', label: 'Shopify 商店' },
    });
    c.eq('不在清單上的網域也會先問 content script', shopify.pinged > 0, true);
    c.eq('content script 說支援 → 可以擷取', shopify.scrapeEnabled, true);
    c.eq('狀態顯示站台名稱', shopify.status, '已就緒（Shopify 商店）');
    c.eq('可以擷取時不顯示捷徑按鈕', shopify.shortcuts, []);
  }

  /* 2. 原本就支援的站台不受影響 */
  {
    const amazon = await openPopup({
      tabUrl: 'https://www.amazon.co.jp/gp/css/order-history',
      pong: { ok: true, onOrderPage: true, site: 'amazon', label: 'Amazon.co.jp' },
    });
    c.eq('Amazon 可以擷取', [amazon.scrapeEnabled, amazon.status], [true, '已就緒（Amazon.co.jp）']);
  }

  /* 3. content script 說不支援 → 停用並提供捷徑 */
  {
    const other = await openPopup({
      tabUrl: 'https://chiikawamarket.jp/products/abc',
      pong: { ok: true, onOrderPage: false, site: null, label: null },
    });
    c.eq('不支援就停用擷取', other.scrapeEnabled, false);
    c.eq('顯示錯誤狀態', other.isError, true);
    c.eq('提供快速開啟的捷徑', other.shortcuts.length > 0, true);
  }

  /* 4. 分頁裡還沒有 content script → 先注入再問 */
  {
    const fresh = await openPopup({
      tabUrl: 'https://nagano-market.jp/account',
      pong: { ok: true, onOrderPage: true, site: 'shopify', label: 'Shopify 商店' },
      pingThrows: true,
    });
    c.eq('注入了 content script', fresh.injected.includes('src/content/main.js'), true);
    c.eq('注入後可以擷取', fresh.scrapeEnabled, true);
  }

  /* 5. 注入不進去（chrome:// 等頁面）→ 給訊息，不要整個壞掉 */
  {
    const blocked = await openPopup({
      tabUrl: 'chrome://extensions',
      pong: { ok: true, onOrderPage: true, site: 'shopify', label: 'Shopify 商店' },
      pingThrows: true,
      injectFails: true,
    });
    c.eq('無法注入時停用擷取', blocked.scrapeEnabled, false);
    c.eq('無法注入時顯示錯誤', blocked.isError, true);
    c.eq('無法注入時仍提供捷徑', blocked.shortcuts.length > 0, true);
  }

  return c.report();
};
