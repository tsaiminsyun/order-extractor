/* Shopify 商店的訂單歷史
 *
 * fixture 依 Dawn 15.2.0 的 sections/main-account.liquid 與 main-order.liquid
 * 的輸出結構產生（不是實際擷取的頁面），所以結構正確但仍需用真實頁面校正。
 *
 * 重點：Dawn 用 id / headers 屬性標示欄位（ColumnQuantity、RowTotal…），
 * 這些屬性不會被翻譯，所以同一套解析吃得下所有語系 —— 第 4 項驗證這件事。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check } = require('./harness.cjs');

const SHOP = 'https://chiikawamarket.jp';
const URL_LIST = `${SHOP}/account`;
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const ACCOUNT = fixture('shopify-account-ja.html');
const ORDER = fixture('shopify-order-ja.html');

// 商品 JSON（/products/{handle}.js）：訂單頁沒有商品圖，只能另外要
const IMAGES = {
  'chiikawa-plush': '//cdn.shopify.com/s/files/1/0626/plush.jpg?v=1',
  'hachiware-keychain': '//cdn.shopify.com/s/files/1/0626/keychain.jpg?v=2',
  'usagi-mascot': '//cdn.shopify.com/s/files/1/0626/usagi.jpg?v=3',
};

// #1001 已出貨；#1002 在列表頁是「未発送」，詳細頁沒有 .fulfillment 區塊
const UNFULFILLED = (html) => html.replace(/<div class="fulfillment">[\s\S]*?<\/div>\s*<\/div>/g, '</div>');

const pagesFor = (orderHtml = ORDER) => (url) => {
  const { pathname } = new URL(url);
  if (pathname.startsWith('/account/orders/')) {
    return pathname.includes('f6g7h8i9j0') ? UNFULFILLED(orderHtml) : orderHtml;
  }
  const handle = pathname.match(/^\/products\/(.+)\.js$/)?.[1];
  if (handle && IMAGES[handle]) return JSON.stringify({ title: handle, featured_image: IMAGES[handle] });
  return null;
};

module.exports = async function run() {
  const c = new Check('Shopify 商店');

  /* 1. 站台判斷：看頁面特徵，不看網域（所以新增一家店不必改程式） */
  {
    const { ping } = setup(ACCOUNT, URL_LIST, { pages: pagesFor() });
    const pong = await ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'shopify', 'Shopify 商店']);

    // 換一個完全不同的網域，照樣認得出來
    const other = setup(ACCOUNT, 'https://nagano-market.jp/account', { pages: pagesFor() });
    c.eq('別家 Shopify 店也認得', (await other.ping()).site, 'shopify');

    // 沒有 Shopify 特徵的 /account 不該被當成這個站台
    const notShopify = setup(ACCOUNT.replace(/cdn\.shopify\.com/g, 'example.com'), 'https://example.com/account');
    c.eq('不是 Shopify 的 /account 不處理', (await notShopify.ping()).onOrderPage, false);
  }

  /* 2. 擷取：一個追蹤號一筆，沒有追蹤號的商品不輸出 */
  {
    const { scrape, asked } = setup(ACCOUNT, URL_LIST, { pages: pagesFor() });
    const { orders, site } = await scrape();
    c.eq('站台', site, 'shopify');
    c.eq('一個伝票番号一筆', orders.length, 1);
    c.eq('注文番号（去掉 #）', orders[0]?.orderId, '1001');
    c.eq('合計取 RowTotal（不是小計）', orders[0]?.total, 5280);
    c.eq('配送業者 / 追蹤番号', [orders[0]?.carrier, orders[0]?.trackingId], ['日本郵便', '1234567890123']);
    c.eq('同一個追蹤號的商品歸成一筆', orders[0]?.items.map((i) => i.title), ['ちいかわ ぬいぐるみ', 'ハチワレ キーホルダー']);
    c.eq('数量', orders[0]?.items.map((i) => i.quantity), [2, 1]);
    c.eq('未出貨的商品不輸出', orders[0]?.items.some((i) => /うさぎ/.test(i.title)), false);
    c.eq('商品圖（來自 /products/{handle}.js）', orders[0]?.items.map((i) => i.imageUrl),
      ['https://cdn.shopify.com/s/files/1/0626/plush.jpg?v=1', 'https://cdn.shopify.com/s/files/1/0626/keychain.jpg?v=2']);

    const detail = asked.filter((a) => a.url.includes('/account/orders/'));
    c.eq('兩筆訂單各讀一次詳細頁', detail.length, 2);
    c.eq('沒有商品的訂單不出現在結果裡', orders.map((o) => o.orderId), ['1001']);
    // 同一件商品在多筆訂單出現時，商品 JSON 只要一次
    const imgReqs = asked.filter((a) => /\/products\/.+\.js$/.test(a.url));
    c.eq('每個商品只問一次圖', imgReqs.length, new Set(imgReqs.map((r) => r.url)).size);
  }

  /* 3. 詳細頁讀不到時：訂單仍保留列表頁的合計，但沒有包裹就不輸出 */
  {
    const { scrape } = setup(ACCOUNT, URL_LIST, { pages: () => null });
    const { orders } = await scrape();
    c.eq('詳細頁全部讀不到 → 沒有可輸出的包裹', orders.length, 0);
  }

  /* 4. 多語系：Dawn 的 id / headers 不會被翻譯，只換文字結果要完全一樣 */
  {
    const translate = (html) => html
      .replace(/注文履歴/g, 'Order history').replace(/アカウント/g, 'Account')
      .replace(/支払い状況/g, 'Payment status').replace(/フルフィルメントステータス/g, 'Fulfillment status')
      .replace(/日付/g, 'Date').replace(/合計/g, 'Total').replace(/小計/g, 'Subtotal')
      .replace(/配送状況を確認する/g, 'Track shipment').replace(/に発送されました/g, ' fulfilled')
      .replace(/数量/g, 'Quantity').replace(/価格/g, 'Price').replace(/商品/g, 'Product')
      .replace(/支払い済み/g, 'Paid').replace(/発送済み/g, 'Fulfilled').replace(/未発送/g, 'Unfulfilled')
      .replace(/配送/g, 'Shipping').replace(/注文/g, 'Order').replace(/lang="ja"/, 'lang="en"');

    const ja = await setup(ACCOUNT, URL_LIST, { pages: pagesFor() }).scrape();
    const en = await setup(translate(ACCOUNT), URL_LIST, { pages: pagesFor(translate(ORDER)) }).scrape();
    c.eq('換語系後結果完全相同', en.orders, ja.orders);
  }

  /* 5. 其他佈景主題：沒有 Dawn 的 headers 屬性時，仍要靠結構找到訂單與合計 */
  {
    const plain = ACCOUNT
      .replace(/ headers="[^"]*"/g, '')
      .replace(/ id="Column[^"]*"/g, '')
      .replace(/class="order-history"/, 'class="my-orders"');
    const { scrape } = setup(plain, URL_LIST, { pages: pagesFor() });
    const { orders } = await scrape();
    c.eq('沒有 headers 屬性也找得到訂單', orders.length, 1);
    c.eq('沒有 headers 屬性也抓得到合計（來自詳細頁）', orders[0]?.total, 5280);
  }

  /* 6. 訂單列表的網址帶 ?page=N（實際網址是 /account?page=1） */
  {
    const onPage1 = setup(ACCOUNT, `${SHOP}/account?page=1`, { pages: pagesFor() });
    c.eq('?page=1 仍認得站台', (await onPage1.ping()).onOrderPage, true);
    const r1 = await onPage1.scrape();
    c.eq('?page=1 直接用現有 DOM，不重抓列表', onPage1.asked.some((a) => /\/account(\?|$)/.test(a.url)), false);
    c.eq('?page=1 擷取結果正常', r1.orders.map((o) => o.trackingId), ['1234567890123']);

    // 停在第 3 頁時要從第 1 頁重新抓，不然前面兩頁會漏掉
    const onPage3 = setup(ACCOUNT, `${SHOP}/account?page=3`, {
      pages: (url) => (new URL(url).pathname === '/account' ? ACCOUNT : pagesFor()(url)),
    });
    await onPage3.scrape();
    const listReq = onPage3.asked.find((a) => new URL(a.url).pathname === '/account');
    c.eq('?page=3 會回頭從第一頁抓', listReq?.url, `${SHOP}/account`);
  }


  return c.report();
};
