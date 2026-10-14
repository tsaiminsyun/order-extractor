/* Shopify 商店的訂單歷史：以兩家店的**實際頁面**為測試資料
 *
 * shopify-dawn-*    ちいかわマーケット：Dawn 原版結構（id / headers 屬性標示欄位），
 *                   合計寫成「5,940.00JPY」，列表多一欄ノベルティ
 * shopify-custom-*  jypj-store：大幅客製的佈景主題 —— 沒有 headers 屬性、
 *                   沒有商品連結（但列表上就有商品圖）、追蹤號在 <a> 裡、
 *                   合計在 <dl> 不在表格裡、列表頁根本沒有合計欄
 *
 * 兩者結構差很多，所以解析不靠固定的表格選擇器，而是以配送資訊的
 * 「業者名 #伝票番号」為錨點往上找所屬的那一列。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check } = require('./harness.cjs');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const page = (body) => `<html><head><script>Shopify.theme = {"schema_name":"Dawn"};</script></head><body>${body}</body></html>`;

const DAWN = { shop: 'https://chiikawamarket.jp', list: fixture('shopify-dawn-list-ja.html'), order: fixture('shopify-dawn-order-ja.html') };
const CUSTOM = { shop: 'https://jypj-store.com', list: fixture('shopify-custom-list-ja.html'), order: fixture('shopify-custom-order-ja.html') };

// 詳細頁 fixture 對應的那一筆訂單；其他訂單一律當成「還沒出貨」
const DAWN_TOKEN = 'a5aa27b3e87290fe94801401095805aa';   // CHIIKAWA-4099569（詳細頁 fixture 就是這一筆）
const CUSTOM_TOKEN = '085e737a69857d9e7ca5a25cfaff4add'; // #1501755
const noTracking = (html) => html.replace(/#\s*\d{6,}/g, '');

const serve = ({ order }, token, images = {}) => (url) => {
  const { pathname } = new URL(url);
  if (pathname.includes('/account/orders/')) {
    return pathname.includes(token) ? order : noTracking(order);
  }
  const key = pathname.replace(/\.js$/, '');
  return images[key] ? JSON.stringify({ featured_image: images[key] }) : null;
};

module.exports = async function run() {
  const c = new Check('Shopify 商店（實際 HTML）');

  /* 1. 站台判斷：看頁面特徵，不看網域 */
  {
    for (const { shop, list } of [DAWN, CUSTOM]) {
      const { ping } = setup(page(list), `${shop}/account?page=1`, { pages: () => null });
      c.eq(`${new URL(shop).hostname} 認得出站台`, (await ping()).site, 'shopify');
    }
    // 多語系商店的語系前綴
    for (const locale of ['zh-hant', 'zh-hans', 'en']) {
      const { ping } = setup(page(DAWN.list), `${DAWN.shop}/${locale}/account?page=1`, { pages: () => null });
      c.eq(`/${locale}/account 認得出站台`, (await ping()).onOrderPage, true);
    }
    const notShopify = setup(`<html><body>${DAWN.list}</body></html>`, 'https://example.com/account');
    c.eq('沒有 Shopify 特徵的 /account 不處理', (await notShopify.ping()).onOrderPage, false);
    const notAccount = setup(page(DAWN.list), `${DAWN.shop}/shop/account`);
    c.eq('/shop/account 不是訂單頁', (await notAccount.ping()).onOrderPage, false);
  }

  /* 2. Dawn 原版（ちいかわマーケット） */
  {
    const images = { '/products/4571609404910': '//cdn.shopify.com/s/files/sticker_100x.jpg' };
    const { scrape, asked } = setup(page(DAWN.list), `${DAWN.shop}/account?page=1`, { pages: serve(DAWN, DAWN_TOKEN, images) });
    const { orders } = await scrape();

    c.eq('只輸出有追蹤號的那筆', orders.map((o) => o.orderId), ['CHIIKAWA-4099569']);
    c.eq('合計（詳細頁的 RowTotal，避開小計 / 送料 / 稅）', orders[0]?.total, 3410);
    c.eq('配送業者 / 伝票番号', [orders[0]?.carrier, orders[0]?.trackingId], ['Yamato (JA)', '510965337234']);
    c.eq('三件商品同一個伝票番号 → 歸成一筆', orders[0]?.items.length, 3);
    c.eq('品名', orders[0]?.items[0]?.title, 'ちいかわ 映画ちいかわ 大きめステッカー（ちいかわと島二郎）');
    c.eq('数量', orders[0]?.items.map((i) => i.quantity), [1, 1, 1]);
    c.eq('訂單頁沒有商品圖 → 另外要商品 JSON（去掉尺寸後綴）',
      orders[0]?.items[0]?.imageUrl, 'https://cdn.shopify.com/s/files/sticker.jpg');
    c.eq('列表上 10 筆訂單都各讀一次詳細頁', asked.filter((a) => a.url.includes('/account/orders/')).length, 10);
    c.eq('商品連結帶 ?variant= 也取得到路徑',
      asked.some((a) => a.url.endsWith('/products/4571609404910.js')), true);
  }

  /* 3. Dawn：列表頁自己的合計欄（寫成 5,940.00JPY，沒有幣別符號） */
  {
    const { scrape } = setup(page(DAWN.list), `${DAWN.shop}/account`, { pages: () => null });
    const { orders } = await scrape({ withLookups: false });
    c.eq('詳細頁還沒讀時列表頁的合計', orders.length, 0); // 沒有包裹就不輸出
    // 直接驗轉接層讀到的列表頁合計
    const site = globalThis.OrderScraper.sites.find((s) => s.name === 'shopify');
    const totals = site.findOrders(globalThis.document, `${DAWN.shop}/account`).map((o) => o.total);
    c.eq('列表頁合計（5,940.00JPY → 5940）', totals.slice(0, 3), [5940, 4620, 2090]);
  }

  /* 4. 客製佈景主題（jypj-store）：結構完全不同，輸出格式要一樣 */
  {
    const { scrape, asked } = setup(page(CUSTOM.list), `${CUSTOM.shop}/account`, { pages: serve(CUSTOM, CUSTOM_TOKEN) });
    const { orders } = await scrape();

    c.eq('只輸出有追蹤號的那筆', orders.map((o) => o.orderId), ['1501755']);
    c.eq('合計（<dl class="order_total">，不是表格）', orders[0]?.total, 7400);
    c.eq('配送業者 / 伝票番号（在 <a> 裡）', [orders[0]?.carrier, orders[0]?.trackingId], ['Sagawa (JA)', '364694555713']);
    c.eq('兩件商品同一個伝票番号', orders[0]?.items.length, 2);
    c.eq('品名取自 <h4>（沒有商品連結）', orders[0]?.items[0]?.title.startsWith('SMARTPHONE HOLDER'), true);
    c.eq('数量取自 td.qty', orders[0]?.items.map((i) => i.quantity), [1, 1]);
    c.eq('商品圖直接用列表上的 img（去掉 _100x 尺寸）',
      orders[0]?.items[0]?.imageUrl, 'https://jypj-store.com/cdn/shop/files/sk24-ate-0087-01.jpg?v=1734425232');
    c.eq('已經有圖就不問商品 JSON', asked.some((a) => a.url.endsWith('.js')), false);
  }

  /* 5. 列表頁沒有合計欄時不可把日期當成金額 */
  {
    const { scrape } = setup(page(CUSTOM.list), `${CUSTOM.shop}/account`, { pages: () => null });
    await scrape({ withLookups: false });
    const site = globalThis.OrderScraper.sites.find((s) => s.name === 'shopify');
    const totals = site.findOrders(globalThis.document, `${CUSTOM.shop}/account`).map((o) => o.total);
    c.eq('沒有合計欄 → null（不是把 2024年12月28日 當成 2024）', [...new Set(totals)], [null]);
  }

  /* 6. 多語系：Dawn 的 id / headers 不會被翻譯，只換文字結果要完全一樣 */
  {
    const translate = (html) => html
      .replace(/注文履歴/g, 'Order history').replace(/注文番号/g, 'Order number').replace(/注文日/g, 'Order date')
      .replace(/支払い状況/g, 'Payment status').replace(/発送状況/g, 'Fulfillment status')
      .replace(/支払い済/g, 'Paid').replace(/未発送/g, 'Unfulfilled').replace(/発送済/g, 'Fulfilled')
      .replace(/商品コード/g, 'SKU').replace(/商品名/g, 'Product').replace(/合計金額/g, 'Total')
      .replace(/数量/g, 'Quantity').replace(/金額/g, 'Price').replace(/小計/g, 'Subtotal')
      .replace(/送料/g, 'Shipping').replace(/発送日/g, 'Fulfilled on').replace(/荷物を追跡する/g, 'Track shipment')
      .replace(/ノベルティ/g, 'Novelty').replace(/日付/g, 'Date').replace(/注文/g, 'Order');

    const ja = await setup(page(DAWN.list), `${DAWN.shop}/account`, { pages: serve(DAWN, DAWN_TOKEN) }).scrape();
    const en = await setup(page(translate(DAWN.list)), `${DAWN.shop}/account`, {
      pages: serve({ order: translate(DAWN.order) }, DAWN_TOKEN),
    }).scrape();
    c.eq('換語系後結果完全相同', en.orders, ja.orders);
  }

  /* 7. 只擷取目前頁面：不論網址停在第幾頁都不會去抓別頁 */
  {
    for (const q of ['?page=1', '?page=3', '']) {
      const s = setup(page(DAWN.list), `${DAWN.shop}/account${q}`, { pages: serve(DAWN, DAWN_TOKEN) });
      await s.scrape();
      c.eq(`${q || '沒有 page 參數'} 不會再去抓訂單列表`,
        s.asked.filter((a) => new URL(a.url).pathname.replace(/\/$/, '') === '/account'), []);
    }
  }

  /* 8. 部分出貨：Shopify 的訂單狀態只有「未出貨 / 部分出貨 / 已出貨」。
   *    部分出貨時同一張訂單裡有的商品有配送資訊、有的沒有 —— 只輸出出了貨的那些。
   *    合計仍是整筆訂單的合計（輸出格式本來就是「一個包裹一筆，合計重複出現」） */
  {
    // 實際頁面是三件商品同一個伝票番号；把第一件的配送資訊拿掉就是部分出貨
    const partial = DAWN.order.replace(/<div class="fulfillment">[^]*?<\/div>\s*<\/div>/, '</div>');
    c.eq('確實少了一組配送資訊',
      (partial.match(/510965337234/g) || []).length, (DAWN.order.match(/510965337234/g) || []).length - 2);

    const { scrape } = setup(page(DAWN.list), `${DAWN.shop}/account`, { pages: serve({ order: partial }, DAWN_TOKEN) });
    const { orders } = await scrape();
    c.eq('那件商品仍然印在訂單頁上', partial.includes('島二郎'), true);
    c.eq('部分出貨 → 只輸出出了貨的商品', orders[0]?.items.length, 2);
    c.eq('沒出貨的那件不在裡面',
      orders[0]?.items.some((i) => i.title.includes('島二郎')), false);
    c.eq('合計仍是整筆訂單的合計', orders[0]?.total, 3410);
    c.eq('伝票番号不變', orders[0]?.trackingId, '510965337234');
  }

  /* 9. 詳細頁全部讀不到時不輸出半筆（寧可留空也不要錯的資料） */
  {
    const { scrape } = setup(page(DAWN.list), `${DAWN.shop}/account`, { pages: () => null });
    const { orders } = await scrape();
    c.eq('詳細頁讀不到 → 沒有可輸出的包裹', orders.length, 0);
  }

  return c.report();
};
