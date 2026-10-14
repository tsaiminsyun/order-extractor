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
manifest.content_scripts[0].matches = [`${ORIGIN}/your-orders/*`, `${ORIGIN}/purchase-history/*`, `${ORIGIN}/account*`, `${ORIGIN}/ec/*`];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
// 站台判斷寫死了網域，測試副本改成 localhost
const patch = (file, from, to) => {
  const f = path.join(EXT, file);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
};
patch('src/content/sites/amazon.js', "/(^|\\.)amazon\\.co\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/rakuten.js', "/(^|\\.)rakuten\\.co\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/rakuten.js', "'https://order.my.rakuten.co.jp/purchase-history/'", `'${ORIGIN}/purchase-history/'`);
patch('src/content/sites/tower.js', "/(^|\\.)tower\\.jp$/.test(loc.hostname)", 'true');
// DNR 規則（移除 x-frame-options）也改成本機，才能驗證樂天的 iframe 讀得到
const rules = JSON.parse(fs.readFileSync(path.join(EXT, 'rules.json'), 'utf8'));
for (const r of rules) {
  r.condition.urlFilter = r.id === 1 ? '/purchase-history' : '/progress-tracker';
  r.condition.initiatorDomains = ['localhost'];
}
if (!NO_DNR) fs.writeFileSync(path.join(EXT, 'rules.json'), JSON.stringify(rules, null, 2));

/* ---------- 模擬站台 ---------- */
const CARRIERS = { PKG1: ['日本郵便', '421304890904'], PKG2: ['ヤマト運輸', '1234-5678-9012'], PKG3: ['佐川急便', '360000000003'] };
// 注文日要相對於今天，七天的規則才驗得準：第 1、2 筆是一兩天前，第 3 筆是三十天前（不該出現）
const AGES = { 1: 1, 2: 2, 3: 30 };
const jaDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
const isoDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const RAKUTEN_ORDER = '267575-20260929-0083907767';

const amazonList = `<html><body><div class="your-orders-content-container">
${[1, 2, 3].map((n) => `<div class="order-card js-order-card">
  <div class="order-header"><ul><li class="order-header__header-list-item">
    <div class="a-row a-size-mini"><span class="a-text-caps">注文日</span></div>
    <div class="a-row"><span class="a-size-base">${jaDate(AGES[n])}</span></div></li>
  <li class="order-header__header-list-item">
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

/* ---------- 模擬 Shopify 商店（伺服器渲染，走 fetch 而非 iframe） ---------- */
const SHOPIFY_TRACK = ['ヤマト運輸', '9876543210987'];
const shopifyAccount = `<!doctype html><html><head>
<script src="https://cdn.shopify.com/s/files/1/0001/assets/theme.js"></script></head><body>
<table role="table" class="order-history"><thead><tr>
  <th id="ColumnOrder">注文</th><th id="ColumnTotal">合計</th></tr></thead><tbody>
  <tr><td id="RowOrder" headers="ColumnOrder"><a href="/account/orders/tok1?key=k1">#1001</a></td>
      <td headers="RowOrder ColumnTotal">¥4,400</td></tr>
  <tr><td id="RowOrder" headers="ColumnOrder"><a href="/account/orders/tok2?key=k2">#1002</a></td>
      <td headers="RowOrder ColumnTotal">¥1,980</td></tr>
</tbody></table></body></html>`;

const shopifyOrderPage = (token) => `<!doctype html><html><body>
<table role="table" class="order-details"><thead><tr>
  <th id="ColumnProduct">商品</th><th id="ColumnQuantity">数量</th></tr></thead><tbody>
  <tr><td id="Row1" headers="ColumnProduct"><div><a href="/products/plush-a">ぬいぐるみA</a>
      ${token === 'tok1' || token === 'tok3' ? `<div class="fulfillment"><span>発送済み</span>
        <span>${SHOPIFY_TRACK[0]} #${SHOPIFY_TRACK[1]}</span></div>` : ''}</div></td>
      <td headers="Row1 ColumnQuantity">3</td></tr>
</tbody><tfoot>
  <tr><td id="RowSubtotal" colspan="4">小計</td><td headers="RowSubtotal">¥4,000</td></tr>
  <tr><td id="RowTotal" colspan="3">合計</td><td headers="RowTotal" colspan="2">¥4,400 JPY</td></tr>
</tfoot></table></body></html>`;

/* ---------- 模擬 タワーレコード（所有欄位都在列表頁，完全不另外載入） ---------- */
const TOWER_TRACK = ['日本郵便', '320443645421'];
/* 一筆訂單分成三次配送：第一次在途、第二次還沒出貨（沒有伝票番号）、
 * 第三次已送達（出荷表示後面多了「（受取済）」）→ 只該輸出第一次 */
const towerBox = (no, tracking, received) => `<div class="deliveryBox">
  <div class="deliveryAbout">
    <table><tbody><tr><td class="ttl">注文番号</td><td>：26J08212058264<span class="dlvrIcon">配送${no}</span></td></tr></tbody></table>
    <table><tbody><tr><td class="ttl">注文合計</td><td>：￥1,870</td></tr></tbody></table>
  </div>
  <div class="deliveryStArea"><span class="deliverySt">2026/10/09 に出荷しました${received ? '（受取済）' : ''}</span></div>
  <div><div class="deliveryDetail">
    <div class="deliveryItemArea"><div class="deliveryItemBox">
      <figure class="deliveryThum"><a href="/item/8057086"><img src="https://cdn.tower.jp/za/l/9W/a.JPG" alt="祈り、終われば"></a></figure>
      <div class="deliveryItmDtl"><p class="title"><a href="/item/8057086">祈り、終われば</a></p>
        <p class="pDetail">￥1,650　数量：1</p>
        <div class="ship-num">数量：<span>1</span></div></div>
    </div></div>
    <div class="deliveryRightClm">
      <p>配送問い合わせ番号：${tracking ? `<a href="http://tracking.post.japanpost.jp/service/singleSearch.do?reqCodeNo1=${tracking}">${tracking}</a>` : ''}</p>
      <p><a href="/ec/Customer/Receipt.aspx?orderId=26J08212058264"><span class="blueTxt">領収書/購入明細書</span></a></p>
    </div>
  </div></div>
</div>`;
const towerList = `<!doctype html><html><body>${towerBox(1, TOWER_TRACK[1], false)}${towerBox(2, '', false)}${towerBox(3, '320443645499', true)}</body></html>`;

// 第 2 頁：再一筆有追蹤號的訂單。第 3 頁是空的 —— Shopify 翻過頭就長這樣
const shopifyAccount2 = `<!doctype html><html><head>
<script src="https://cdn.shopify.com/s/files/1/0001/assets/theme.js"></script></head><body>
<table role="table" class="order-history"><thead><tr>
  <th id="ColumnOrder">注文</th><th id="ColumnTotal">合計</th></tr></thead><tbody>
  <tr><td id="RowOrder" headers="ColumnOrder"><a href="/account/orders/tok3?key=k3">#1003</a></td>
      <td headers="RowOrder ColumnTotal">¥2,200</td></tr>
</tbody></table></body></html>`;

const shopifyEmpty = `<!doctype html><html><head>
<script src="https://cdn.shopify.com/s/files/1/0001/assets/theme.js"></script></head><body>
<table role="table" class="order-history"><tbody></tbody></table></body></html>`;

const hits = [];
const trackerHits = [];  // 讀了哪幾個包裹的配送狀況頁
const server = http.createServer((req, res) => {
  const u = new URL(req.url, ORIGIN);
  hits.push(u.pathname);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (u.pathname === '/slow.png') return setTimeout(() => { res.statusCode = 404; res.end(''); }, 3000);
  if (u.pathname === '/your-orders/orders') return res.end(amazonList);
  if (u.pathname === '/progress-tracker/package') {
    trackerHits.push(u.searchParams.get('shipmentId'));
    if (XFO_DENY) res.setHeader('X-Frame-Options', 'DENY');
    return res.end(trackerPage(u.searchParams.get('shipmentId')));
  }
  if (u.pathname === '/account') {
    const n = Number(u.searchParams.get('page') || 1);
    return res.end(n === 1 ? shopifyAccount : n === 2 ? shopifyAccount2 : shopifyEmpty);
  }
  if (u.pathname.startsWith('/account/orders/')) return res.end(shopifyOrderPage(u.pathname.split('/').pop()));
  if (u.pathname === '/products/plush-a.js') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ title: 'ぬいぐるみA', featured_image: '//cdn.example.com/plush-a.jpg' }));
  }
  if (u.pathname === '/ec/Customer/Order/List') return res.end(towerList);
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
        return chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE' });
      }, url);
      return { result, secs: ((Date.now() - started) / 1000).toFixed(1) };
    };

    // Amazon
    {
      const { result, secs } = await scrape(`${ORIGIN}/your-orders/orders`);
      console.log(`Amazon：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('Amazon 站台', result.site, 'amazon');
      eq('Amazon 三十天前那筆連配送狀況頁都不讀', trackerHits.includes('PKG3'), false);
      if (BLOCKED) {
        // 配送狀況頁被擋下：讀不到 tracking ID 的包裹不列出來，但要報個數（不會另開分頁硬讀）
        eq('Amazon 讀不到 tracking ID 就不列', result.orders, []);
        eq('Amazon 報出讀不到幾個', result.missingTracking, 2);
      } else {
        eq('Amazon 只列七天內的', result.orders.map((o) => [o.orderId, o.total]),
          [['503-0000001-0000001', 1000], ['503-0000002-0000001', 2000]]);
        eq('Amazon 注文日', result.orders.map((o) => o.orderedAt), [isoDate(1), isoDate(2)]);
        eq('Amazon 配送資料（包裹層）', result.orders.map((o) => [o.carrier, o.trackingId]), [CARRIERS.PKG1, CARRIERS.PKG2]);
      }
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

    // Shopify（伺服器渲染 → 走 fetch，並在 content script 內抓商品 JSON 取圖）
    {
      const { result, secs } = await scrape(`${ORIGIN}/account`);
      console.log(`Shopify：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('Shopify 站台', result.site, 'shopify');
      eq('Shopify 兩頁都掃到，只輸出有追蹤號的', result.orders.map((o) => o.orderId), ['1001', '1003']);
      eq('Shopify 翻頁走 ?page=', hits.filter((h) => h === '/account').length >= 3, true);
      eq('Shopify 合計取詳細頁的 RowTotal', result.orders[0].total, 4400);
      eq('Shopify 配送業者 / 追蹤番号', [result.orders[0].carrier, result.orders[0].trackingId], SHOPIFY_TRACK);
      eq('Shopify 品名 / 数量', [result.orders[0].items[0].title, result.orders[0].items[0].quantity], ['ぬいぐるみA', 3]);
      eq('Shopify 商品圖（來自 /products/{handle}.js）', result.orders[0].items[0].imageUrl, 'https://cdn.example.com/plush-a.jpg');
    }

    // タワーレコード（列表頁就有全部欄位 → 一頁都不該多讀）
    {
      const before = hits.length;
      const { result, secs } = await scrape(`${ORIGIN}/ec/Customer/Order/List`);
      console.log(`タワーレコード：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('タワー 站台', result.site, 'tower');
      eq('タワー 只輸出在途的那次配送（略過未出荷與受取済）', result.orders.map((o) => o.trackingId), [TOWER_TRACK[1]]);
      eq('タワー 注文番号 / 合計', [result.orders[0].orderId, result.orders[0].total], ['26J08212058264', 1870]);
      eq('タワー 配送業者（由查詢網址判斷）', result.orders[0].carrier, TOWER_TRACK[0]);
      eq('タワー 品名 / 数量 / 画像', [result.orders[0].items[0].title, result.orders[0].items[0].quantity,
        result.orders[0].items[0].imageUrl], ['祈り、終われば', 1, 'https://cdn.tower.jp/za/l/9W/a.JPG']);
      // 擷取期間只該打那一次列表頁，沒有任何額外請求
      eq('タワー 不另外載入頁面', hits.slice(before), ['/ec/Customer/Order/List']);
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
