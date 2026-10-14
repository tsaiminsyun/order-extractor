/* Amazon.co.jp 訂單列表解析 */
const { setup, Check } = require('./harness.cjs');

const URL_LIST = 'https://www.amazon.co.jp/your-orders/orders';
const TRACK = (sid, text = '配送状況を確認') => `<li data-csa-c-item-id="ppx_yo2ov_dt_b_fed_track_package">
  <span class="a-button"><span class="a-button-inner"><a class="a-button-text" role="button"
    href="/progress-tracker/package?ref=ppx_yo2ov_dt_b_fed_track_package&amp;orderId=X&amp;shipmentId=${sid}&amp;packageIndex=0">${text}</a>
  </span></span></li>`;
const IMG = (asin, name, pic = asin, qty = 0) =>
  `<div class="product-image"><a class="a-link-normal" href="/dp/${asin}?ref=ppx_yo2ov_dt_b_fed_asin_image"><img alt="${name}"
     src="https://m.media-amazon.com/images/I/${pic}._SS142_.jpg" data-a-hires="https://m.media-amazon.com/images/I/${pic}._SS284_.jpg"></a>
     ${qty ? `<span class="product-image__qty">${qty}</span>` : ''}</div>`;
const TITLE = (asin, name) =>
  `<div class="yohtmlc-product-title"><a class="a-link-normal" href="/dp/${asin}?ref=ppx_yo2ov_dt_b_fed_asin_title">${name}</a></div>`;
const HEADER = (id, label, money, dup = false) => `
  <div class="order-header"><ul>
    <li class="order-header__header-list-item"><div class="a-row a-size-mini"><span class="a-text-caps">${label}</span></div>
      <div class="a-row"><span class="a-size-base">${money}</span></div></li></ul>
    <div class="yohtmlc-order-id"><span class="a-text-caps">注文番号</span><span dir="ltr">${id}</span></div>
    ${dup ? `<div class="a-mobile-only"><div class="yohtmlc-order-id"><span dir="ltr">${id}</span></div></div>` : ''}
  </div>`;
// 包裹的狀態標題（お届け済み / お届け予定 …）。結構取自實際頁面
const STATUS = (text) => `<div class="yohtmlc-shipment-status-primaryText"><h3>
  <span class="a-size-medium delivery-box__primary-text a-text-bold">${text}</span></h3></div>`;
const CARD = (inner) => `<div class="order-card js-order-card">${inner}</div>`;
const BOX = (inner) => `<div class="a-box delivery-box"><div class="a-box-inner">${inner}</div></div>`;
const PAGE = (inner) => `<html><body><div class="your-orders-content-container">${inner}</div></body></html>`;

// 配送狀況頁（iframe 會真的載入這份 HTML，再由 readers.js 解析）
const TRACKING_PAGE = (carrier, trackingId) => `<html><body>
  <section class="pt-card delivery-card"><div class="pt-delivery-card-wrapper">
    <h3 class="a-spacing-small">配送業者 ${carrier}</h3>
    <div class="pt-delivery-card-trackingId">トラッキングID: ${trackingId}</div>
  </div></section></body></html>`;

const TRACKING = { S1: ['日本郵便', '421304890904'], S2: ['ヤマト運輸', '1234-5678-9012'], S3: ['佐川急便', '360012345678'] };
// 認不得的 shipmentId 回傳空值 → 模擬 iframe 被擋下
const trackingPages = (url) => {
  const pair = TRACKING[new URL(url).searchParams.get('shipmentId')];
  return pair && TRACKING_PAGE(...pair);
};

module.exports = async function run() {
  const c = new Check('Amazon 訂單列表');

  /* 1. 基本：合計、品名、圖片、配送資料，注文番号重複出現也能解析 */
  {
    const html = PAGE(CARD(HEADER('503-7097018-1651051', '合計', '￥2,322', true) +
      BOX(IMG('B0DZ1VTY4W', '爪切り') + TITLE('B0DZ1VTY4W', '爪切り') + TRACK('S1'))));
    const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('訂單數', orders.length, 1);
    c.eq('注文番号', orders[0].orderId, '503-7097018-1651051');
    c.eq('合計', orders[0].total, 2322);
    c.eq('通貨', orders[0].currency, 'JPY');
    c.eq('品名', orders[0].items.map((i) => i.title), ['爪切り']);
    c.eq('圖片取 data-a-hires', orders[0].items[0].imageUrl, 'https://m.media-amazon.com/images/I/B0DZ1VTY4W._SS284_.jpg');
    c.eq('配送業者 / 追蹤番号（包裹層）', [orders[0].carrier, orders[0].trackingId], ['日本郵便', '421304890904']);
  }

  /* 2. 多包裹多商品：同包裹共用配送資料，只有圖片的商品也要收 */
  {
    const html = PAGE(CARD(HEADER('503-0000000-0000001', '合計', '￥9,999') +
      BOX(IMG('B0AAAAAAA1', '商品一') + TITLE('B0AAAAAAA1', '商品一') + IMG('B0AAAAAAA2', '只有圖片的商品') + TRACK('S1')) +
      BOX(IMG('B0BBBBBBB1', '商品三') + TITLE('B0BBBBBBB1', '商品三') + TRACK('S2')) +
      BOX(IMG('B0CCCCCCC1', '已送達的商品') + TITLE('B0CCCCCCC1', '已送達的商品')))); // 無按鈕
    const { scrape, asked } = setup(html, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('一個包裹一筆', orders.length, 2);
    c.eq('注文番号重複出現', orders.map((o) => o.orderId), ['503-0000000-0000001', '503-0000000-0000001']);
    c.eq('合計重複填入', orders.map((o) => o.total), [9999, 9999]);
    c.eq('包裹1 的商品（含只有圖片的）', orders[0].items.map((i) => i.title), ['商品一', '只有圖片的商品']);
    c.eq('包裹1 的配送資料', [orders[0].carrier, orders[0].trackingId], ['日本郵便', '421304890904']);
    c.eq('包裹2 的商品與配送資料', [orders[1].items.map((i) => i.title), orders[1].trackingId], [['商品三'], '1234-5678-9012']);
    c.eq('沒有配送按鈕的包裹不讀取', asked.length, 2);
  }

  /* 3. 只擷取配送中：整筆沒有配送按鈕的訂單不出現 */
  {
    const html = PAGE(
      CARD(HEADER('503-0000000-0000002', '合計', '￥1,000') + BOX(TITLE('B0DELIVER1', '已送達'))) +
      CARD(HEADER('503-0000000-0000003', '合計', '￥2,000') + BOX(TITLE('B0SHIPPING', '配送中') + TRACK('S1'))));
    const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('只留配送中的訂單', orders.map((o) => o.orderId), ['503-0000000-0000003']);
  }

  /* 4. 多語系的合計標籤與金額寫法 */
  {
    for (const [name, label, money, want] of [
      ['日', '合計', '￥2,322', 2322],
      ['英', 'Total', '¥2,322', 2322],
      ['簡中', '总价', 'JP¥2,322', 2322],
      ['未知語系（退回第一個含金額欄位）', 'XXXX', '￥18,685', 18685],
    ]) {
      const html = PAGE(CARD(HEADER('503-0000000-0000004', label, money) + BOX(TITLE('B0I18N0001', '商品') + TRACK('S1'))));
      const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
      const { orders } = await scrape();
      c.eq(`合計 ${name}`, orders[0]?.total, want);
    }
  }

  /* 5. 三種語言的配送按鈕文字都能判斷（判斷用的是網址） */
  {
    for (const [name, text] of [['日', '配送状況を確認'], ['英', 'Track package'], ['簡中', '追踪您的包裹']]) {
      const html = PAGE(CARD(HEADER('503-0000000-0000005', '合計', '￥1,000') +
        BOX(TITLE('B0BTN00001', '商品') + TRACK('S1', text))));
      const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
      const { orders } = await scrape();
      c.eq(`按鈕文字 ${name}`, orders[0]?.items.length, 1);
    }
  }

  /* 6. 品名只有純文字（不是連結）時也要收 */
  {
    const html = PAGE(CARD(HEADER('503-0000000-0000006', '合計', '￥500') +
      BOX('<div class="yohtmlc-product-title">文字品名商品</div>' + TRACK('S1'))));
    const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('純文字品名', orders[0]?.items.map((i) => i.title), ['文字品名商品']);
  }

  /* 7. 「もう一度買う」等按鈕不會被當成商品 */
  {
    const html = PAGE(CARD(HEADER('503-0000000-0000007', '合計', '￥800') +
      BOX(TITLE('B0BUY00001', '商品') +
        '<span class="a-button"><a class="a-button-text" href="/dp/B0BUY00001?ref=buyagain">もう一度買う</a></span>' + TRACK('S1'))));
    const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('排除按鈕連結', orders[0]?.items.map((i) => i.title), ['商品']);
  }

  /* 8. 讀取配送狀況頁失敗時：沒有 tracking ID 就不列出來，但要報個數 ——
   *    它確實在配送中（有配送状況を確認按鈕），只是 ID 讀不到，不能無聲無息地消失 */
  {
    const html = PAGE(CARD(HEADER('503-0000000-0000008', '合計', '￥700') +
      BOX(TITLE('B0FAIL0001', '商品') + TRACK('S9'))));
    const { scrape } = setup(html, URL_LIST, { pages: () => null });
    const result = await scrape();
    c.eq('讀不到 tracking ID 的包裹不列出來', result.orders.length, 0);
    c.eq('但有報出讀不到幾個', result.missingTracking, 1);
  }

  /* 9. PING 回報站台 */
  {
    const { ping } = setup(PAGE(''), URL_LIST);
    const pong = await ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'amazon', 'Amazon.co.jp']);
  }

  /* 10. 数量：同一個包裹裡各商品的數量不可互相沾染，沒有角標就是 1 件 */
  {
    const html = PAGE(CARD(HEADER('503-0000000-0000009', '合計', '￥5,000') +
      BOX(IMG('B0QTY00001', '三件的商品', 'B0QTY00001', 3) + TITLE('B0QTY00001', '三件的商品') +
          IMG('B0QTY00002', '一件的商品') + TITLE('B0QTY00002', '一件的商品') +
          IMG('B0QTY00003', '兩件的商品', 'B0QTY00003', 2) + TITLE('B0QTY00003', '兩件的商品') + TRACK('S1'))));
    const { scrape } = setup(html, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('各商品的数量', orders[0]?.items.map((i) => [i.title, i.quantity]),
      [['三件的商品', 3], ['一件的商品', 1], ['兩件的商品', 2]]);
  }

  /* 11. 只擷取配送中：已送達的包裹略過，但在途的文案不可被誤判
   *     （三個語系的已送達字樣取自實際頁面，見 amazon-real.test.cjs 第 5 項） */
  {
    const withStatus = (status) => PAGE(CARD(HEADER('503-7097018-1651051', '合計', '￥2,322') +
      BOX(STATUS(status) + IMG('B0DZ1VTY4W', '爪切り') + TITLE('B0DZ1VTY4W', '爪切り') + TRACK('S1'))));
    const count = async (status) => {
      const { scrape } = setup(withStatus(status), URL_LIST, { pages: trackingPages });
      return (await scrape()).orders.length;
    };

    for (const status of ['8月23日にお届け済み', 'Delivered August 23', '已于 8月23日 送达']) {
      c.eq(`已送達不擷取：${status}`, await count(status), 0);
    }

    // 在途的文案一樣有「お届け」「delivery」「送达」，不能跟著被濾掉
    for (const status of ['8月25日にお届け予定', 'Arriving tomorrow', 'Out for delivery', '预计 8月25日 送达']) {
      c.eq(`配送中仍擷取：${status}`, await count(status), 1);
    }

    c.eq('沒有狀態那一行時保留', await count(''), 1);

    // 同一筆訂單兩個包裹，一個已送達一個在途：已送達那箱的商品不可混進來
    const mixed = PAGE(CARD(HEADER('503-0000000-0000011', '合計', '￥9,000') +
      BOX(STATUS('8月23日にお届け済み') + IMG('B0DONE00001', '已送達的商品') + TITLE('B0DONE00001', '已送達的商品') + TRACK('S1')) +
      BOX(STATUS('8月25日にお届け予定') + IMG('B0LIVE00001', '在途的商品') + TITLE('B0LIVE00001', '在途的商品') + TRACK('S2'))));
    const { scrape } = setup(mixed, URL_LIST, { pages: trackingPages });
    const { orders } = await scrape();
    c.eq('兩個包裹只留在途那箱', orders.map((o) => [o.trackingId, o.items.map((i) => i.title)]),
      [['1234-5678-9012', ['在途的商品']]]);
  }

  /* 12. 自動翻頁（前端渲染的站台走隱藏 iframe）。
   *     實際的 Amazon 分頁區塊沒拿到，所以這裡用通用規則認得的形式：帶 href 的「次へ」連結。
   *     規則本身在 util 的 nextPageLink —— 認不出來就停在目前這一頁，不會出錯 */
  {
    const NEXT = (href) => `<a href="${href}">次へ</a>`;
    const card = (n) => CARD(HEADER(`503-000000${n}-0000001`, '合計', '￥2,322') +
      BOX(IMG(`B0PAGE0000${n}`, `第${n}頁的商品`) + TITLE(`B0PAGE0000${n}`, `第${n}頁的商品`) + TRACK('S1')));

    const pages = {
      '/your-orders/orders': PAGE(card(1) + NEXT('/your-orders/orders?page=2')),
      '/your-orders/orders?page=2': PAGE(card(2) + NEXT('/your-orders/orders?page=3')),
      '/your-orders/orders?page=3': PAGE(''),   // 空頁 → 停
    };
    const serve = (url) => {
      const u = new URL(url);
      return pages[u.pathname + u.search] ?? trackingPages(url);
    };

    const s = setup(pages['/your-orders/orders'], URL_LIST, { pages: serve });
    const result = await s.scrape();
    c.eq('兩頁的訂單都擷取到', result.orders.map((o) => o.orderId), ['503-0000001-0000001', '503-0000002-0000001']);
    c.eq('翻到空頁就停', result.pages, 3);
    c.eq('翻頁是用 iframe 載入的',
      s.asked.filter((a) => a.url.includes('/your-orders/')).map((a) => new URL(a.url).search), ['?page=2', '?page=3']);
    c.eq('第 2 頁的包裹也讀到配送資料', result.orders[1]?.trackingId, '421304890904');

    // 認不出下一頁時停在目前這一頁，行為跟沒有分頁功能一樣
    const alone = setup(PAGE(card(1)), URL_LIST, { pages: trackingPages });
    const only = await alone.scrape();
    c.eq('沒有下一頁就只掃一頁', [only.pages, only.orders.length], [1, 1]);
  }

  return c.report();
};
