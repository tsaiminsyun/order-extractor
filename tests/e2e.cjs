/* 真實 Chrome 的端對端測試：載入擴充功能，對模擬站台跑完整擷取流程。
 * 模擬站台的配送 / 詳細頁都是「前端渲染」，驗證隱藏 iframe 讀得到內容。
 * 擴充功能沒有背景程式，任何情況都不該開新分頁。
 *
 *   node tests/e2e.cjs                 一般情況
 *   XFO_DENY=1 node tests/e2e.cjs      站台回 x-frame-options: DENY（rules.json 應讓 iframe 仍可用）
 *   NO_DNR=1 XFO_DENY=1 ...            不套用 rules.json → iframe 真的被擋下，相關欄位留空
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const PORT = Number(process.env.PORT || 8765);
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const EXT = path.join(fs.realpathSync(os.tmpdir()), 'order-scraper-e2e');
const { XFO_DENY, NO_DNR } = process.env;
// 沒套 rules.json 又被 X-Frame-Options 擋下時，iframe 讀不到任何另外載入的頁面
const BLOCKED = Boolean(NO_DNR && XFO_DENY);

/* ---------- 擴充功能副本：只把網域換成本機 ---------- */
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(ROOT, EXT, { recursive: true, filter: (p) => !/node_modules|\.git/.test(p) });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${ORIGIN}/*`];
manifest.content_scripts[0].matches = [`${ORIGIN}/your-orders/*`, `${ORIGIN}/purchase-history/*`];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
// 站台判斷寫死了網域，測試副本改成 localhost
const patch = (file, from, to) => {
  const f = path.join(EXT, file);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
};
patch('src/content/sites/amazon.js', "/(^|\\.)amazon\\.co\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/rakuten.js', "/(^|\\.)rakuten\\.co\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/rakuten.js', "'https://order.my.rakuten.co.jp/purchase-history/'", `'${ORIGIN}/purchase-history/'`);
// DNR 規則（移除 x-frame-options）也改成本機，才能驗證樂天的 iframe 讀得到
const rules = JSON.parse(fs.readFileSync(path.join(EXT, 'rules.json'), 'utf8'));
for (const r of rules) {
  r.condition.urlFilter = r.id === 1 ? '/purchase-history' : '/progress-tracker';
  r.condition.initiatorDomains = ['localhost'];
}
if (!NO_DNR) fs.writeFileSync(path.join(EXT, 'rules.json'), JSON.stringify(rules, null, 2));

/* ---------- 模擬站台 ---------- */
const CARRIERS = { PKG1: ['日本郵便', '421304890904'], PKG2: ['ヤマト運輸', '1234-5678-9012'] };
const RAKUTEN_ORDER = '267575-20260929-0083907767';

const amazonList = `<html><body><div class="your-orders-content-container">
${[1, 2].map((n) => `<div class="order-card js-order-card">
  <div class="order-header"><ul><li class="order-header__header-list-item">
    <div class="a-row a-size-mini"><span class="a-text-caps">合計</span></div>
    <div class="a-row"><span class="a-size-base">￥${n},000</span></div></li></ul>
    <div class="yohtmlc-order-id"><span class="a-text-caps">注文番号</span><span dir="ltr">503-000000${n}-0000001</span></div></div>
  <div class="a-box delivery-box"><div class="a-box-inner">
    <a class="a-link-normal" href="/dp/B00000000${n}?ref=ppx_yo2ov_dt_b_fed_asin_image"><img alt="商品${n}" src="https://m.media-amazon.com/images/I/P${n}._SS142_.jpg"></a>
    <div class="yohtmlc-product-title"><a class="a-link-normal" href="/dp/B00000000${n}?ref=ppx_yo2ov_dt_b_fed_asin_title">商品${n}</a></div>
    <span class="a-button"><a class="a-button-text" href="/progress-tracker/package?orderId=X&shipmentId=PKG${n}&packageIndex=0">配送状況を確認</a></span>
  </div></div></div>`).join('')}
</div></body></html>`;

// 配送狀況頁：空殼 + 1 秒後才渲染，另有一張 3 秒才回應的圖（load 事件會被拖慢）
const trackerPage = (sid) => `<!doctype html><html><body><img src="/slow.png"><div id="app">…</div><script>
setTimeout(() => { document.getElementById('app').innerHTML =
  '<h3>配送業者 ${CARRIERS[sid][0]}</h3><div class="pt-delivery-card-trackingId">トラッキングID: ${CARRIERS[sid][1]}</div>'; }, 1000);
</script></body></html>`;

const rakutenList = `<html><body><div class="history--root"><div class="card--x">
  <a href="https://www.rakuten.co.jp/teddyshop/" aria-label="shop-image"><img class="image--38eoi"
     src="https://thumbnail.image.rakuten.co.jp/@0_mall/teddyshop/logo/logo1.jpg?_ex=96x96" alt="TeddyShop"></a>
  <div class="spacer--1O71j"><span class="text-container--3DrET">注文番号<!-- -->：</span>
    <span class="text-container--3DrET">${RAKUTEN_ORDER}</span></div>
  <a href="https://item.rakuten.co.jp/teddyshop/hys1515/?s-id=ph_pc_itemimage"><img class="image--38eoi"
     src="https://thumbnail.image.rakuten.co.jp/@0_mall/teddyshop/cabinet/a.jpg?_ex=168x168" alt="楽天の商品"></a>
  <div class="running-shipping-icon--1t96k"></div>
  <div><div><span class="text-container--3DrET">配送業者</span></div>
    <div><a aria-label="ヤマト運輸" href="https://jizen.kuronekoyamato.co.jp/?number=391175086374">ヤマト運輸</a></div></div>
  <div><div><span class="text-container--3DrET">伝票番号</span></div>
    <div><span class="text-container--3DrET">391175086374</span></div></div>
  <div><div><span class="text-container--3DrET">配送業者</span></div>
    <div><a aria-label="ヤマト運輸" href="https://jizen.kuronekoyamato.co.jp/?number=391175087995">ヤマト運輸</a></div></div>
  <div><div><span class="text-container--3DrET">伝票番号</span></div>
    <div><span class="text-container--3DrET">391175087995</span></div></div>
  <a class="button--1P0_8" aria-label="注文詳細"
     href="${ORIGIN}/purchase-history/?order_number=${RAKUTEN_ORDER}&shop_id=267575&act=detail_page_view">注文詳細</a>
</div></div></body></html>`;

// 注文詳細頁：空殼 + 1 秒後才渲染（模擬前端渲染），另有一張 3 秒才回應的圖。
// 合計 / 配送業者 / 伝票番号都在這一頁
const rakutenDetail = `<!doctype html><html><body><img src="/slow.png"><div id="app">…</div><script>
setTimeout(() => { document.getElementById('app').innerHTML =
  '<div><span class="text-container--3DrET">小計</span>' +
  '<div class="number-display--1oihd"><div class="value--21p0x size-custom-16--2AAAA">9,800</div></div>' +
  '<span class="text-container--3DrET">円</span></div>' +
  '<div><span class="text-container--3DrET">支払い金額</span>' +
  '<div><div class="number-display--1oihd"><div class="value--21p0x size-custom-24--3JT_U">10,660</div></div>' +
  '<span class="text-container--3DrET">円</span></div></div>' +
  '<div><div><span class="text-container--3DrET">配送業者</span></div>' +
  '<div><a aria-label="佐川急便" href="https://k2k.sagawa-exp.co.jp/cgi-bin/mall.mmcgi?oku01=568506023470">佐川急便</a></div></div>' +
  '<div><div><span class="text-container--3DrET">伝票番号</span></div>' +
  '<div><span class="text-container--3DrET">568506023470</span></div></div>'; }, 1000);
</script></body></html>`;

const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, ORIGIN);
  hits.push(u.pathname);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (u.pathname === '/slow.png') return setTimeout(() => { res.statusCode = 404; res.end(''); }, 3000);
  if (u.pathname === '/your-orders/orders') return res.end(amazonList);
  if (u.pathname === '/progress-tracker/package') {
    if (XFO_DENY) res.setHeader('X-Frame-Options', 'DENY');
    return res.end(trackerPage(u.searchParams.get('shipmentId')));
  }
  if (u.pathname === '/purchase-history/order-list/') return res.end(rakutenList);
  if (u.pathname === '/purchase-history/') {
    if (XFO_DENY) res.setHeader('X-Frame-Options', 'DENY');
    return res.end(rakutenDetail);
  }
  res.statusCode = 404; res.end('');
});

/* ---------- 執行 ---------- */
const fails = [];
const eq = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fails.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  const openedTabs = [];
  browser.on('targetcreated', (t) => { if (t.type() === 'page') openedTabs.push(t.url()); });
  try {
    const page = await browser.newPage();
    // 擴充功能已經沒有 service worker，改用它自己的 popup 頁當測試驅動
    // （未封裝擴充功能的 ID 是「真實絕對路徑」的 SHA-256 前 16 bytes，每個 nibble 轉成 a–p）
    const extId = [...crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
      .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    const driver = await browser.newPage();
    await driver.goto(`chrome-extension://${extId}/popup.html`);
    const scrape = async (url) => {
      await page.goto(url, { waitUntil: 'load' });
      const started = Date.now();
      const result = await driver.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        return chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE', payload: { delayMs: 0 } });
      }, url);
      return { result, secs: ((Date.now() - started) / 1000).toFixed(1) };
    };

    // Amazon
    {
      const { result, secs } = await scrape(`${ORIGIN}/your-orders/orders`);
      console.log(`Amazon：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('Amazon 站台', result.site, 'amazon');
      eq('Amazon 訂單', result.orders.map((o) => [o.orderId, o.total]), [['503-0000001-0000001', 1000], ['503-0000002-0000001', 2000]]);
      // 讀不到配送狀況頁時訂單仍保留，只是配送欄位留空（不會另開分頁硬讀）
      eq('Amazon 配送資料（包裹層）', result.orders.map((o) => [o.carrier, o.trackingId]),
        BLOCKED ? [['', ''], ['', '']] : [CARRIERS.PKG1, CARRIERS.PKG2]);
    }

    // 楽天
    {
      const { result, secs } = await scrape(`${ORIGIN}/purchase-history/order-list/`);
      console.log(`楽天：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('楽天 站台', result.site, 'rakuten');
      eq('楽天 一個伝票番号一筆', result.orders.map((o) => o.trackingId), ['391175086374', '391175087995']);
      eq('楽天 注文番号重複出現', [...new Set(result.orders.map((o) => o.orderId))], [RAKUTEN_ORDER]);
      // 詳細頁讀不到時合計留空；伝票番号本來就在列表頁，所以還在
      eq('楽天 合計（來自詳細頁）', result.orders.map((o) => o.total), BLOCKED ? [null, null] : [10660, 10660]);
      eq('楽天 配送業者', [...new Set(result.orders.map((o) => o.carrier))], ['ヤマト運輸']);
      eq('楽天 品名 / 圖片（不含商店 logo）', [result.orders[0].items.length, result.orders[0].items[0].title, result.orders[0].items[0].imageUrl],
        [1, '楽天の商品', 'https://thumbnail.image.rakuten.co.jp/@0_mall/teddyshop/cabinet/a.jpg']);
    }

    // 只用 iframe，任何情況都不該開新分頁
    const extra = openedTabs.filter((u) => /progress-tracker|purchase-history\/\?/.test(u));
    console.log(`另開的分頁：${extra.length} 個`);
    eq('不開新分頁', extra, []);
    eq('沒有背景程式', (await browser.targets()).some((t) => t.type() === 'service_worker'), false);
  } catch (err) {
    fails.push(`例外：${err.message}`);
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n--- E2E ---');
  fails.forEach((f) => console.log('FAIL ' + f));
  console.log(fails.length ? 'E2E 失敗' : 'E2E 通過');
  process.exit(fails.length ? 1 : 0);
})();
