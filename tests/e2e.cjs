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
const { shiftJis } = require('./sjis.cjs');

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
manifest.content_scripts[0].matches = [`${ORIGIN}/your-orders/*`, `${ORIGIN}/purchase-history/*`, `${ORIGIN}/account*`, `${ORIGIN}/ec/*`, `${ORIGIN}/order-history/*`, `${ORIGIN}/mypage/*`, `${ORIGIN}/avx/*`, `${ORIGIN}/_member/*`, `${ORIGIN}/shop/*`];
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
patch('src/content/sites/pokemoncenter.js', "/(^|\\.)pokemoncenter-online\\.com$/.test(loc.hostname)", 'true');
patch('src/content/sites/nijisanji.js', "/(^|\\.)shop\\.nijisanji\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/animate.js', "/(^|\\.)animate-onlineshop\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/mumo.js', "/(^|\\.)mu-mo\\.net$/.test(loc.hostname)", 'true');
patch('src/content/sites/zozo.js', "/(^|\\.)zozo\\.jp$/.test(loc.hostname)", 'true');
patch('src/content/sites/plusmember.js', "/(^|\\.)plusmember\\.jp$/.test(loc.hostname)", 'true');
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

/* ---------- 模擬 ポケモンセンター（伺服器渲染 → 詳細頁走 fetch） ----------
 * 結構照實際頁面（tests/fixtures/pokemoncenter-*）。三筆訂單：
 *   PC1 一天前、発送済み → 讀詳細頁、列出
 *   PC2 兩天前、注文受付済み → 不讀詳細頁
 *   PC3 三十天前、発送済み → 超過七天，不讀詳細頁 */
const POKEMON = { PC1: [1, true], PC2: [2, false], PC3: [30, true] };
const POKEMON_ID = { PC1: '3000000000001', PC2: '3000000000002', PC3: '3000000000003' };
const pcDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月 ${String(d.getDate()).padStart(2, '0')}日（木）`;
};
const pokemonRow = (key) => {
  const [age, shipped] = POKEMON[key];
  const step = (i, label) => `<li${(shipped ? i === 2 : i === 0) ? ' class="finish"' : ''}>${label}</li>`;
  return `<li>
  <div class="subBox"><p class="time">${pcDate(age)}<span>10時17分</span></p>
    <div class="comReceiptBox${shipped ? ' sent' : ''}"><ul class="txtList">${step(0, '注文受付済み')}${step(1, '発送準備中')}${step(2, '発送済み')}</ul></div></div>
  <div class="txtBox"><div class="rBox"><p class="number">注文番号<span>${POKEMON_ID[key]}</span></p><p class="ttl">ぬいぐるみ パモ</p></div>
    <div class="comBtn"><a href="/order-details/?orderID=${POKEMON_ID[key]}&amp;page=1">注文詳細・各種手続き</a></div></div>
</li>`;
};
const pokemonList = `<!doctype html><html><body><ul class="comOrderList">${['PC1', 'PC2', 'PC3'].map(pokemonRow).join('')}</ul></body></html>`;
const pokemonDetail = `<!doctype html><html><body><!-- dwMarker="content" -->
<dl class="info_list">
  <div class="-item"><dt class="-ttl">注文番号</dt><dd class="-data">${POKEMON_ID.PC1}</dd></div>
  <div class="-item mt"><dt class="-ttl">送り状番号</dt><dd class="-data">5040-1844-1522<br /></dd></div>
</dl>
<div class="linkBox"><a href="https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=504018441522" target="_blank"><span>配送状況を確認する</span></a></div>
<ul class="comPriceList"><li class="list01">
  <div class="pho"><img src="https://www.pokemoncenter-online.com/a/img/item/1/S/a.jpg" alt="ぬいぐるみ パモ"></div>
  <div class="txtBox"><a class="ttl ttl02" href="/1.html">ぬいぐるみ パモ</a>
    <select name="num06" disabled aria-label="個数"><option value="2">2</option></select></div>
</li></ul>
<div class="comPriceAll">
  <p class="btmText"><span class="txt">商品合計</span><span class="price"><span class="lato"> 7,920 </span>円<small>税込</small></span></p>
  <p class="tText payAll"><span class="txt">支払合計</span><span class="price"><span class="lato"> 8,470 </span>円<small>税込</small></span></p>
</div></body></html>`;

/* ---------- 模擬 にじさんじ（伺服器渲染 → 詳細頁走 fetch；狀態標籤在每件商品上） ----------
 * 結構照實際頁面（tests/fixtures/nijisanji-*）。三筆訂單：
 *   NJ1 一天前、出荷済み → 讀詳細頁、列出
 *   NJ2 兩天前、着荷済み → 已送達，不讀詳細頁
 *   NJ3 三十天前、出荷済み → 超過七天，不讀詳細頁 */
const NIJI = { NJ1: [1, '出荷済み'], NJ2: [2, '着荷済み'], NJ3: [30, '出荷済み'] };
const NIJI_ID = { NJ1: 'SN000000000001', NJ2: 'SN000000000002', NJ3: 'SN000000000003' };
const njDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日 19:48`;
};
const nijiRow = (key) => `<li>
  <div class="order-history-date"><span class="heading heading3">${njDate(NIJI[key][0])}</span></div>
  <div class="order-history-status is-blue"><span class="order-history-status-label text-bold">お支払い済み</span>
    <span class="order-history-status-id text-s text-sp-xs">ご注文番号　${NIJI_ID[key]}</span></div>
  <div class="order-history-container"><div class="order-history-card"><div class="order-history-detail">
    <div class="order-history-right"><ul class="label-list"><li><span class="label label-gray">${NIJI[key][1]}</span></li></ul>
      <h3><a href="/SSZS-1.html" class="link link-l order-history-product-name">【にじさんじ】マグカップ</a></h3></div>
  </div></div>
  <div class="order-history-button text-right"><a href="/mypage/order-history/detail?orderID=${NIJI_ID[key]}" class="button"><span class="button-inner">詳細を見る</span></a></div></div>
</li>`;
const nijiList = `<!doctype html><html><body><ul class="order-history-list">${['NJ1', 'NJ2', 'NJ3'].map(nijiRow).join('')}</ul></body></html>`;
const nijiDetail = `<!doctype html><html><body>
<table class="table table-total"><tbody>
  <tr><th>商品合計金額（税込）</th><td>¥5,000</td></tr>
  <tr class="total-item"><th>お支払い合計金額（税込）</th><td>¥5,682</td></tr>
</tbody></table>
<div class="order-history-container order-history-summary"><div class="order-history-detail">
  <div class="order-history-left"><a href="/SSZS-1.html" class="order-history-img"><img src="/on/demandware.static/-/x/SSZS-1.png" alt="【にじさんじ】マグカップ"></a></div>
  <div class="order-history-right"><span class="disp-b"><a href="/SSZS-1.html" class="link link-l order-history-product-name">【にじさんじ】マグカップ</a></span></div>
  <div class="cartitem-count is-text"><span class="cartitem-count-num">数量</span><span class="text-bold cartitem-count-text">2</span></div>
</div>
<div class="order-delivery-info bg-lightgray"><h4 class="heading heading4">お届け先</h4><span>山田&nbsp; 太郎</span><span>0312345678</span>
  <h4 class="heading heading4">配送伝票番号</h4><span>366129410824</span></div></div>
</body></html>`;

/* ---------- 模擬 アニメイト通販（全部欄位都在列表頁；分頁是「次へ>>」） ----------
 * 結構照實際頁面（tests/fixtures/animate-*）。
 *   第 1 頁：AN1 一天前、出荷作業中 → 列出；AN2 兩天前、お届け済 → 已送達不列
 *   第 2 頁：AN3 三天前、出荷作業中 → 列出 */
const ANIMATE = { AN1: [1, false, '266000000001'], AN2: [2, true, '266000000002'], AN3: [3, false, '266000000003'] };
const ANIMATE_ID = { AN1: '55000001', AN2: '55000002', AN3: '55000003' };
const anDate = (daysAgo) => isoDate(daysAgo).replace(/-/g, '/');
const animateOrder = (key) => {
  const [age, delivered, slip] = ANIMATE[key];
  const track = `javascript: window.open('https://trackings.post.japanpost.jp/services/srv/search/?requestNo1=${slip}', '_blank');`;
  return `<div class="order_histories"><div class="order">
  <p class="order__date">注文日　${anDate(age)}</p>
  <div class="order_status"><p class="order_id"><span>注文番号　</span>${ANIMATE_ID[key]}</p>
    <p class="order_slip_number"><span>配送伝票番号　<a href="#" onclick="${track}">${slip}</a></span></p><p class="order_contact"></p></div>
  <div class="order-tracking"><ol class="order-tracking__timeline">
    <li class="prev">注文受付</li><li class="prev">お支払い</li><li class="prev">商品準備中</li>
    <li class="${delivered ? 'prev' : 'current'}">出荷作業中</li><li${delivered ? ' class="current"' : ''}>お届け済</li></ol></div>
  <div class="order_inner">
    <div class="order_item"><div class="order_item_image"><a href="/pd/1/"><img src="https://tc-animate.techorus-cdn.com/resize_image/resize_image.php?image=a.jpg" alt="【グッズ】アクリルスタンド"></a></div>
      <div class="order_item_info"><div><h3 class="pb5 text-blue"><a class="text-blue" href="/pd/1/">【グッズ】アクリルスタンド</a></h3>
        <div class="d-flex"><p class="order_item_price me-3">2点</p><p class="order_item_price">3,300円</p></div></div></div></div>
    <div class="order_item order_item_privilege"><h3 class="order_item_privilege_title">この受注に付与される特典</h3>
      <div class="order_item_privilege_name">&nbsp;ミニフォト</div><div class="order_item_privilege_quantity">1点</div></div>
  </div>
  <div class="order_detail_wrap" style="display: none"><div class="order_bill"><table><tbody>
    <tr><td>商品小計</td><td>3,300円</td></tr><tr class="total"><td>注文合計金額</td><td>3,894円</td></tr>
  </tbody></table></div></div>
</div></div>`;
};
const animatePager = '<div class="my-pager"><ul><li class="current"><a href="#">1</a></li><li><a href="/mypage/history.php?pageno=2&amp;order_period=1&amp;ss=1">2</a></li></ul>'
  + '<p class="next"><a href="/mypage/history.php?pageno=2&amp;order_period=1&amp;ss=1">次へ&gt;&gt;</a></p></div>';
const animateList = (n) => `<!doctype html><html><body><section>${n === 1 ? animateOrder('AN1') + animateOrder('AN2') + animatePager : animateOrder('AN3')}</section></body></html>`;
const animateHits = [];  // 讀了アニメイト的哪幾頁

/* ---------- 模擬 mu-mo ショップ（詳細頁要送 POST 表單打開，回應是 Shift_JIS） ----------
 * 結構照實際頁面（tests/fixtures/mumo-*）。jumpdetail 表單照頁面的 detail() 原始碼造。
 *   MU1 一天前、出荷済み → 送表單讀詳細頁、列出
 *   MU2 兩天前、配達完了 → 不讀
 *   MU3 三十天前、出荷済み → 超過七天，不讀 */
const MUMO = { MU1: [1, '出荷済み'], MU2: [2, '配達完了'], MU3: [30, '出荷済み'] };
const MUMO_ID = { MU1: ['36000001', 'tokA1--'], MU2: ['36000002', 'tokA2--'], MU3: ['36000003', 'tokA3--'] };
const MUMO_TEL = 'telZ9--';
const mumoBlock = (key) => `<tr><th colspan="5" class="cellHead"><p class="tit"><strong>▼P</strong> ${isoDate(MUMO[key][0]).replace(/-/g, '/')}ご注文（<a href="#.#" onclick="javascript: detail('${MUMO_ID[key][1]}','${MUMO_TEL}');">履歴詳細</a>）</p></th></tr>
<tr><th>注文番号</th><th>商品</th><th>配送先</th><th>配送状況</th><th>レビューを書く</th></tr>
<tr><td rowspan="1">${MUMO_ID[key][0]}</td><td class="cellItem">アクリルスタンド他1商品</td><td>山田太郎</td><td>${MUMO[key][1]}</td><td class="cellBtn"><em>&nbsp;</em></td></tr>`;
const mumoList = `<!doctype html><html><body><table class="tableCart tablePager"><tbody>${['MU1', 'MU2', 'MU3'].map(mumoBlock).join('')}</tbody></table>
<form name="jumpdetail" method="post" action=""><input type="hidden" name="order_id" value=""><input type="hidden" name="order_tel" value=""><input type="hidden" name="jsiteid" value="mumo"></form></body></html>`;
const mumoDetail = `<!doctype html><html><head><meta charset="Shift_JIS"></head><body><table class="tableCart"><tbody>
<tr><th colspan="8" class="cellHead"><p class="tit">▼配送セットA</p></th></tr>
<tr><td class="cellItem">TVXV-4763<br />アクリルスタンド (A)</td><td class="cellDeliv" rowspan="2">出荷済み<br />配送会社：ヤマト運輸<br />408273350844</td><td></td><td class="cellPrice">\\1,870</td><td>3</td><td class="cellPrice">\\5,610</td></tr>
<tr><td class="cellItem">TVXV-4764<br />アクリルスタンド (B)</td><td></td><td class="cellPrice">\\1,870</td><td>1</td><td class="cellPrice">\\1,870</td></tr>
</tbody></table><p class="txtTotal"><strong>お支払い合計&nbsp;&nbsp;\\8,280</strong></p></body></html>`;
const mumoHits = [];  // 送了哪些詳細頁的請求

/* ---------- 模擬 ZOZOTOWN（一個區塊是一個包裹；伝票番号在詳細頁，fetch） ----------
 * 結構照實際頁面（tests/fixtures/zozo-*）。
 *   ZP1 配達中：ZO1（一天前）→ 讀詳細頁、列出
 *   ZP2 配達完了、まとめて発送：ZO2、ZO3（兩天前）→ 不讀
 *   ZP3 配達中：ZO4（三十天前）→ 超過七天，不讀 */
const ZOZO_ID = { ZO1: '421000001', ZO2: '421000002', ZO3: '421000003', ZO4: '421000004' };
const zoDate = (daysAgo) => isoDate(daysAgo).replace(/-/g, '.');
const zozoRow = (key, daysAgo, item) => `<tr class="thumbBox"><td class="goodsBox"><div class="thumb"><p class="img"><img src="https://c.imgz.jp/1/${key}.jpg"></p></div>
  <div class="thumbDetail"><p class="brandName">hellam</p><p class="itemName"><a href="#">${item}</a></p><div class="colorName">ブルー / FREE</div>
  <p class="price"><span class="priceNum">¥8,910</span><span class="tax">税込 / 数量：2</span></p></div></td>
  <td rowspan="2" class="orderTime"><p><span class="orderItemTh">注文日</span>：${zoDate(daysAgo)}</p><p><span class="orderItemTh">注文番号</span>：${ZOZO_ID[key]}</p>
  <p class="btn"><a href="./detail.html?oid=${ZOZO_ID[key]}&amp;isold=0">注文詳細・各種手続き</a></p></td></tr>`;
const zozoPack = (status, rows) => `<div class="orderList"><div class="orderDetailHeader"><p class="orderDetailHeader-h">${status}</p></div>
  <div class="orderDetailBody"><table class="orderDetail resist"><tbody>${rows}</tbody></table></div></div>`;
const zozoList = `<!doctype html><html><body><div class="listBlock clearfix">
${zozoPack('配達中', zozoRow('ZO1', 1, 'デニムジャケット'))}
${zozoPack('配達完了', zozoRow('ZO2', 2, 'トート') + zozoRow('ZO3', 2, 'デニムパンツ'))}
${zozoPack('配達中', zozoRow('ZO4', 30, 'シャツ'))}
</div></body></html>`;
const zozoDetail = `<!doctype html><html><body><table class="resist"><tbody>
  <tr><th>注文番号</th><td>${ZOZO_ID.ZO1}</td></tr>
  <tr><th>伝票番号</th><td>293252106335<a href="#" data-toggle="modalbox">詳細</a></td></tr>
</tbody></table><div class="bottomTbl"><table class="resist"><tbody>
  <tr><th>商品合計</th><td>¥17,820</td></tr><tr><th>支払い金額</th><td><span class="ttlPrice">¥18,150</span></td></tr>
</tbody></table></div></body></html>`;
const zozoHits = [];

/* ---------- 模擬 plusmember（列表頁沒有配送狀態；詳細頁要送表單打開，fetch） ----------
 * 結構照實際頁面（tests/fixtures/plusmember-*）。表單是造的（實際的沒拿到）。
 *   PM1 一天前 → 讀詳細頁：佐川急便、お問い合わせ番号 → 列出
 *   PM2 兩天前 → 讀詳細頁：還沒寄出（お問い合わせ番号那一組是空的）→ 不列
 *   PM3 三十天前 → 超過七天，不讀 */
const PLUS = { PM1: ['985000001', 1], PM2: ['985000002', 2], PM3: ['985000003', 30] };
const plusRow = (key) => `<ul><li class="time">${isoDate(PLUS[key][1]).replace(/-/g, '/')} 13:50</li><li class="shop">Artist Goods Store</li>
<li class="centertd id">${PLUS[key][0]}</li><li class="centertd payment">クレジットカード決済</li><li class="centertd total">￥14,380</li>
<li class="centertd detail"><a href="/mypage/index.php" onclick="fnChangeAction('./history.php'); fnKeySubmit('order_id', '${PLUS[key][0]}'); return false;">詳細</a></li></ul>`;
const plusList = `<!doctype html><html><body><div class="list"><ul class="tit"><li>購入日時</li><li>購入店舗</li><li>注文番号</li><li>お支払い方法</li><li>合計金額</li><li></li></ul>
${['PM1', 'PM2', 'PM3'].map(plusRow).join('')}</div>
<form name="form1" method="post" action="?"><input type="hidden" name="order_id" value=""><input type="hidden" name="token" value="tok1"></form></body></html>`;
const plusDetail = (sent) => `<!doctype html><html><body><div class="mypage detail"><div class="data">
<ul class="tit empty">${sent ? '<li>お問い合わせ番号</li><li>353912840945</li><li>追跡確認</li><li><a href="http://k2k.sagawa-exp.co.jp/p/sagawa/web/okurijoinput.jsp">お荷物のお問い合わせはコチラ</a></li>' : ''}</ul></div>
<div class="item"><ul class="tit"><li>商品</li><li>単価(税込)</li><li>個数</li><li>小計</li></ul>
<ul><li><a href="/shop/products/detail.php?product_id=1">【fromis_9】froming≪A Ver.≫</a><br /><span>8800000000001</span></li>
<li class="price"><p>￥2,700</p></li><li class="quantity">2</li><li class="total">￥5,400</li></ul></div></div></body></html>`;
const plusHits = [];  // 送了哪些詳細頁的請求

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
const pokemonHits = [];  // 讀了哪幾筆ポケモンセンター的詳細頁
const nijiHits = [];     // 讀了哪幾筆にじさんじ的詳細頁
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
  if (u.pathname === '/order-history/') return res.end(pokemonList);
  if (u.pathname === '/mypage/order-history') return res.end(nijiList);
  if (u.pathname === '/avx/sv/mypordhist05') return res.end(mumoList);
  if (u.pathname === '/_member/orderhistory/default.html') return res.end(zozoList);
  if (u.pathname === '/_member/orderhistory/detail.html') {
    zozoHits.push(u.searchParams.get('oid'));
    return res.end(u.searchParams.get('oid') === ZOZO_ID.ZO1 ? zozoDetail : '');
  }
  if (u.pathname === '/shop/mypage/index.php') return res.end(plusList);
  if (u.pathname === '/shop/mypage/history.php') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      plusHits.push(`${req.method} ${body}`);
      const id = new URLSearchParams(body).get('order_id');
      res.end(id === PLUS.PM1[0] ? plusDetail(true) : id === PLUS.PM2[0] ? plusDetail(false) : '');
    });
    return undefined;
  }
  if (u.pathname === '/avx/sv/mypordhist03usr') {
    // 詳細頁只接受 detail() 送的那張表單；回應用 Shift_JIS（舊式日本網站常見），驗證不會變亂碼
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      mumoHits.push([req.method, u.searchParams.get('ordid'), body]);
      res.setHeader('Content-Type', 'text/html; charset=Shift_JIS');
      res.end(Buffer.from(shiftJis(mumoDetail)));
    });
    return undefined;
  }
  if (u.pathname === '/mypage/history.php') {
    animateHits.push(u.search);
    return res.end(animateList(Number(u.searchParams.get('pageno') || 1)));
  }
  if (u.pathname === '/mypage/order-history/detail') {
    nijiHits.push(u.searchParams.get('orderID'));
    if (XFO_DENY) res.setHeader('X-Frame-Options', 'DENY');
    return res.end(u.searchParams.get('orderID') === NIJI_ID.NJ1 ? nijiDetail : '');
  }
  if (u.pathname === '/order-details/') {
    pokemonHits.push(u.searchParams.get('orderID'));
    // fetch 不受 X-Frame-Options 影響：三種模式結果都該一樣
    if (XFO_DENY) res.setHeader('X-Frame-Options', 'DENY');
    return res.end(u.searchParams.get('orderID') === POKEMON_ID.PC1 ? pokemonDetail : '');
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

    // ポケモンセンター（伺服器渲染 → 詳細頁走 fetch，X-Frame-Options 擋不到）
    {
      const { result, secs } = await scrape(`${ORIGIN}/order-history/`);
      console.log(`ポケモンセンター：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('ポケモン 站台', result.site, 'pokemoncenter');
      eq('ポケモン 只讀七天內発送済み那筆的詳細頁', pokemonHits, [POKEMON_ID.PC1]);
      eq('ポケモン 列出那筆', result.orders.map((o) => [o.orderId, o.orderedAt]), [[POKEMON_ID.PC1, isoDate(1)]]);
      eq('ポケモン 配送業者 / 送り状番号（去掉連字號）', result.orders.map((o) => [o.carrier, o.trackingId]), [['ヤマト運輸', '504018441522']]);
      eq('ポケモン 合計（支払合計）', result.orders[0]?.total, 8470);
      eq('ポケモン 品名 / 個数 / 画像', result.orders[0]?.items.map((i) => [i.title, i.quantity, i.imageUrl]),
        [['ぬいぐるみ パモ', 2, 'https://www.pokemoncenter-online.com/a/img/item/1/S/a.jpg']]);
    }

    // にじさんじ（伺服器渲染 → 詳細頁走 fetch；着荷済み的不讀）
    {
      const { result, secs } = await scrape(`${ORIGIN}/mypage/order-history`);
      console.log(`にじさんじ：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('にじさんじ 站台', result.site, 'nijisanji');
      eq('にじさんじ 只讀七天內出荷済み那筆的詳細頁', nijiHits, [NIJI_ID.NJ1]);
      eq('にじさんじ 列出那筆', result.orders.map((o) => [o.orderId, o.orderedAt]), [[NIJI_ID.NJ1, isoDate(1)]]);
      eq('にじさんじ 配送業者（頁面上沒有，留空）/ 伝票番号', result.orders.map((o) => [o.carrier, o.trackingId]), [['', '366129410824']]);
      eq('にじさんじ 合計（お支払い合計金額）', result.orders[0]?.total, 5682);
      // 圖片是相對路徑：fetch 回來的文件要以目前頁面為基準轉成完整網址
      eq('にじさんじ 品名 / 数量 / 画像', result.orders[0]?.items.map((i) => [i.title, i.quantity, i.imageUrl]),
        [['【にじさんじ】マグカップ', 2, `${ORIGIN}/on/demandware.static/-/x/SSZS-1.png`]]);
    }

    // アニメイト通販（全部欄位都在列表頁；「次へ>>」翻到第 2 頁）
    {
      const { result, secs } = await scrape(`${ORIGIN}/mypage/history.php`);
      console.log(`アニメイト：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('アニメイト 站台', result.site, 'animate');
      eq('アニメイト 翻到第 2 頁，沒有讀其他頁', [result.pages, animateHits], [2, ['', '?pageno=2&order_period=1&ss=1']]);
      eq('アニメイト 只列配送中的（お届け済不列）', result.orders.map((o) => [o.orderId, o.orderedAt, o.trackingId]),
        [[ANIMATE_ID.AN1, isoDate(1), ANIMATE.AN1[2]], [ANIMATE_ID.AN3, isoDate(3), ANIMATE.AN3[2]]]);
      eq('アニメイト 配送業者（onclick 裡的查詢網址）', [...new Set(result.orders.map((o) => o.carrier))], ['日本郵便']);
      eq('アニメイト 合計（注文合計金額）', result.orders[0]?.total, 3894);
      eq('アニメイト 品名 / 件數（含特典）', result.orders[0]?.items.map((i) => [i.title, i.quantity]),
        [['【グッズ】アクリルスタンド', 2], ['ミニフォト', 1]]);
    }

    // mu-mo ショップ（送 POST 表單讀詳細頁，回應是 Shift_JIS）
    {
      const { result, secs } = await scrape(`${ORIGIN}/avx/sv/mypordhist05`);
      console.log(`mu-mo：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('mu-mo 站台', result.site, 'mumo');
      eq('mu-mo 只對七天內、沒送達的那筆送出表單（POST、欄位照 detail()）', mumoHits,
        [['POST', MUMO_ID.MU1[1], `order_id=${MUMO_ID.MU1[1]}&order_tel=${MUMO_TEL}&jsiteid=mumo`]]);
      eq('mu-mo 列出那筆（Shift_JIS 解碼正確）', result.orders.map((o) => [o.orderId, o.orderedAt, o.carrier, o.trackingId, o.total]),
        [[MUMO_ID.MU1[0], isoDate(1), 'ヤマト運輸', '408273350844', 8280]]);
      eq('mu-mo 品名 / 個数', result.orders[0]?.items.map((i) => [i.title, i.quantity]), [['アクリルスタンド (A)', 3], ['アクリルスタンド (B)', 1]]);
    }

    // ZOZOTOWN（一個區塊是一個包裹；只讀七天內、沒送達的訂單的詳細頁）
    {
      const { result, secs } = await scrape(`${ORIGIN}/_member/orderhistory/default.html`);
      console.log(`ZOZOTOWN：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('ZOZO 站台', result.site, 'zozo');
      eq('ZOZO 只讀七天內、沒送達的那筆詳細頁', zozoHits, [ZOZO_ID.ZO1]);
      eq('ZOZO 列出那筆', result.orders.map((o) => [o.orderId, o.orderedAt, o.carrier, o.trackingId, o.total]),
        [[ZOZO_ID.ZO1, isoDate(1), '', '293252106335', 18150]]);
      eq('ZOZO 品名 / 数量 / 画像', result.orders[0]?.items.map((i) => [i.title, i.quantity, i.imageUrl]),
        [['hellam デニムジャケット（ブルー / FREE）', 2, 'https://c.imgz.jp/1/ZO1.jpg']]);
    }

    // plusmember（列表頁沒有配送狀態 → 七天內的每一筆都送表單讀詳細頁）
    {
      const { result, secs } = await scrape(`${ORIGIN}/shop/mypage/index.php`);
      console.log(`plusmember：${result.orders.length} 筆訂單、耗時 ${secs}s`);
      eq('plusmember 站台', result.site, 'plusmember');
      // 兩筆同時送出，到達順序不固定
      eq('plusmember 七天內的兩筆都送出表單（POST、欄位照頁面上的表單）', [...plusHits].sort(),
        [`POST order_id=${PLUS.PM1[0]}&token=tok1`, `POST order_id=${PLUS.PM2[0]}&token=tok1`]);
      eq('plusmember 只列出有お問い合わせ番号的那筆', result.orders.map((o) => [o.orderId, o.orderedAt, o.carrier, o.trackingId, o.total]),
        [[PLUS.PM1[0], isoDate(1), '佐川急便', '353912840945', 14380]]);
      eq('plusmember 品名 / 個数', result.orders[0]?.items.map((i) => [i.title, i.quantity]), [['【fromis_9】froming≪A Ver.≫', 2]]);
      eq('plusmember 還沒寄出的不算「讀不到」', result.missingTracking, 0);
    }

    // 只用 iframe，任何情況都不該開新分頁
    const extra = openedTabs.filter((u) => /progress-tracker|purchase-history\/\?|order-details|order-history\/detail|mypordhist03|orderhistory\/detail|shop\/mypage\/history/.test(u));
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
