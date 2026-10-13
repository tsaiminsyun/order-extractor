/* 楽天市場 購入履歴：以使用者提供的實際 HTML 為測試資料
 * rakuten-list-jp.html    日文列表頁：3 筆訂單 —— 配達完了（3 個伝票番号）、
 *                         配送状況を確認できません、出荷準備中（後兩筆沒有伝票番号，不擷取）
 * rakuten-list-en.html    英文列表頁：一筆訂單、2 件商品，列表頁不顯示配送資訊
 * rakuten-detail-{jp,en}  注文詳細頁：合計 / 配送業者 / 伝票番号
 *
 * 日文那兩份的包裹都已送達，依規則不擷取（第 13 項驗這件事）。其他欄位的解析
 * 改用 inTransit() 處理過的版本，見下面的說明。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://order.my.rakuten.co.jp/purchase-history/order-list/';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
/* 實際頁面上這些包裹都已送達（配送進度停在最後一步）。已送達的不擷取，
 * 所以要驗其他欄位，就把進度列的「目前狀態」標記從最後一步移到「出荷」。
 * 判斷規則只看「目前狀態是不是最後一步」，所以只要動這一個 class，
 * 不必捏造配送中的文案 —— 其餘 HTML 與使用者給的完全一樣 */
function inTransit(body) {
  const dom = new JSDOM(page(body));
  for (const active of dom.window.document.querySelectorAll('[class*="item-shipping-active--"]')) {
    const token = [...active.classList].find((c) => c.startsWith('item-shipping-active--'));
    const shipped = active.parentElement.children[1]; // ショップ → 出荷 → 配達店 → 配達完了
    const done = [...shipped.classList].find((c) => c.startsWith('item-done--'));
    active.classList.remove(token);
    if (done) shipped.classList.remove(done);
    shipped.classList.add(token);
  }
  return dom.window.document.body.innerHTML;
}

// 使用者給的原始頁面（已送達），第 13 項用
const DELIVERED = { list: fixture('rakuten-list-jp.html'), detail: fixture('rakuten-detail-jp.html') };
const LIST = { jp: inTransit(DELIVERED.list), en: fixture('rakuten-list-en.html') };
const DETAIL = { jp: inTransit(DELIVERED.detail), en: fixture('rakuten-detail-en.html') };

const JP = {
  orderId: '297942-20260918-0695404827',
  title: '先着限りクーポン付 ヤマサ 醤油 ヤマサ重ね仕込しょうゆ 本懐石（保存料無添加）1.8Lハンディペット×1ケース（全6本） 送料無料【co】',
  image: 'https://thumbnail.image.rakuten.co.jp/@0_mall/umaimon-oumi/cabinet/190409syuusei/0077387306.jpg',
  trackingIds: ['391175086374', '391175087995', '391175088006'],
};
const EN = { orderId: '267575-20260929-0083907767', trackingId: '568506023470' };

// 直接讀取器層級的呼叫（第 1、8、11 項用）
const readDetail = (lang) => () => globalThis.OrderScraper.readers.rakutenDetail(new JSDOM(page(DETAIL[lang])).window.document);
// iframe 會真的載入這份注文詳細頁
const detailPage = (lang) => () => page(DETAIL[lang]);

module.exports = async function run() {
  const c = new Check('楽天 購入履歴（實際 HTML）');

  /* 1. 注文詳細頁：日文 / 英文讀到同樣的值 */
  {
    loadReaders();
    for (const lang of ['jp', 'en']) {
      const info = await readDetail(lang)();
      c.eq(`詳細頁 ${lang} 合計（支払い金額 / Total amount，不是小計）`, info.total, 10660);
      c.eq(`詳細頁 ${lang} 配送資訊`, info.shipments, [{ carrier: '佐川急便', trackingId: '568506023470' }]);
    }

    // 認不得標籤時（其他語系）退回結構判斷
    const other = DETAIL.jp.replace(/支払い金額/g, 'XXX').replace(/配送業者/g, 'YYY').replace(/伝票番号/g, 'ZZZ');
    const info = await globalThis.OrderScraper.readers.rakutenDetail(new JSDOM(page(other)).window.document);
    c.eq('認不得標籤時仍可取得', [info.total, info.shipments], [10660, [{ carrier: '佐川急便', trackingId: '568506023470' }]]);
  }

  /* 2. 日文列表頁：一筆訂單 3 個伝票番号 → 3 筆，商品掛在每一筆下 */
  {
    const { scrape, asked } = setup(page(LIST.jp), URL_LIST, { pages: detailPage('jp') });
    const { orders, site } = await scrape();

    c.eq('站台', site, 'rakuten');
    c.eq('一個伝票番号一筆', orders.length, 3);
    c.eq('注文番号重複出現', [...new Set(orders.map((o) => o.orderId))], [JP.orderId]);
    c.eq('伝票番号', orders.map((o) => o.trackingId), JP.trackingIds);
    c.eq('配送業者', [...new Set(orders.map((o) => o.carrier))], ['ヤマト運輸']);
    c.eq('合計重複填入（來自詳細頁）', orders.map((o) => o.total), [10660, 10660, 10660]);
    c.eq('每筆都帶該訂單的商品', orders.map((o) => o.items.map((i) => i.title)), [[JP.title], [JP.title], [JP.title]]);
    c.eq('商品圖去掉尺寸參數', orders[0].items[0].imageUrl, JP.image);
    c.eq('商店名稱沒有被當成商品', orders[0].items.some((i) => /ショップ|shop/i.test(i.title)), false);
    c.eq('詳細頁只讀一次（三個包裹共用一筆訂單）', asked.length, 1);
    c.eq('詳細頁網址', asked[0].url,
      `https://order.my.rakuten.co.jp/purchase-history/?order_number=${JP.orderId}&shop_id=297942&act=detail_page_view`);
  }

  /* 3. 英文列表頁：列表沒有配送資訊，改由詳細頁補 */
  {
    const { scrape, asked } = setup(page(LIST.en), URL_LIST, { pages: detailPage('en') });
    const { orders } = await scrape();
    c.eq('英文介面也能擷取', orders.length, 1);
    c.eq('注文番号', orders[0].orderId, EN.orderId);
    c.eq('配送業者 / 伝票番号（來自詳細頁）', [orders[0].carrier, orders[0].trackingId], ['佐川急便', EN.trackingId]);
    c.eq('合計', orders[0].total, 10660);
    c.eq('商品數（不含商店 logo）', orders[0].items.length, 2);
    c.eq('讀一次詳細頁', asked.length, 1);
  }

  /* 4. 沒有伝票番号就不擷取，而且不載入詳細頁 */
  {
    const noTracking = LIST.jp.replace(/伝票番号/g, '—');
    const { scrape, asked } = setup(page(noTracking), URL_LIST, { pages: detailPage('jp') });
    const { orders } = await scrape();
    c.eq('沒有伝票番号 → 不擷取', orders.length, 0);
    c.eq('沒有伝票番号 → 不載入詳細頁', asked.length, 0);
  }

  /* 5. 詳細頁讀不到時：合計留空，但伝票番号已在列表頁取得 */
  {
    const { scrape } = setup(page(LIST.jp), URL_LIST, { pages: () => null });
    const { orders } = await scrape();
    c.eq('合計留空', orders.map((o) => o.total), [null, null, null]);
    c.eq('伝票番号仍在', orders.map((o) => o.trackingId), JP.trackingIds);
  }

  /* 6. 兩筆訂單 */
  {
    const second = LIST.jp.replace(new RegExp(JP.orderId, 'g'), '123456-20260930-0011112222');
    const { scrape, asked } = setup(page(LIST.jp + second), URL_LIST, { pages: detailPage('jp') });
    const { orders } = await scrape();
    c.eq('兩筆訂單各 3 個包裹', orders.length, 6);
    c.eq('注文番号', [...new Set(orders.map((o) => o.orderId))], [JP.orderId, '123456-20260930-0011112222']);
    c.eq('各讀一次詳細頁', asked.length, 2);
  }

  /* 7. PING 回報站台 */
  {
    const { ping } = setup(page(''), URL_LIST);
    const pong = await ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'rakuten', '楽天市場']);
  }

  /* 8. 活動連結不可被當成配送業者（回報案例：配送業者 / ID 顯示「○倍の注意点 000031092」）。
   *    活動連結和業者查詢連結長得很像：外部網域、有 aria-label、網址帶長數字，
   *    差別只在它不在出貨狀態區塊內 */
  {
    loadReaders();
    const PROMO = '<a href="https://event.rakuten.com/campaign/point/000031092/?scid=wi_000031092" aria-label="○倍の注意点">ポイント○倍の注意点</a>';
    const read = (doc) => globalThis.OrderScraper.readers.rakutenDetail(doc);

    // (a) 正常有配送資訊時，活動連結不影響結果
    const withPromo = await read(new JSDOM(page(PROMO + DETAIL.jp)).window.document);
    c.eq('有配送資訊時不受活動連結影響', withPromo.shipments, [{ carrier: '佐川急便', trackingId: '568506023470' }]);

    // (b) 這筆訂單根本沒出貨：必須留空，不能拿活動連結湊一筆假的出來
    const noShipping = new JSDOM(page(PROMO + DETAIL.jp)).window.document;
    noShipping.querySelectorAll('[class*="shipping-status--"]').forEach((el) => el.remove());
    const bare = await read(noShipping);
    c.eq('沒有出貨資訊 → 配送欄位留空', bare.shipments, []);
    c.eq('沒有出貨資訊 → 合計仍讀得到', bare.total, 10660);

    // (c) 後備規則只認「整個查詢參數就是伝票番号」的網址，路徑裡的長數字不算
    const inPath = DETAIL.jp
      .replace(/配送業者/g, 'XXX').replace(/伝票番号/g, 'YYY')
      .replace('https://k2k.sagawa-exp.co.jp/cgi-bin/mall.mmcgi?oku01=568506023470',
        'https://k2k.sagawa-exp.co.jp/track/568506023470');
    const pathOnly = await read(new JSDOM(page(inPath)).window.document);
    c.eq('伝票番号只在網址路徑裡 → 不採用', pathOnly.shipments, []);
  }

  /* 9. 列表頁：沒有伝票番号時，連「配送業者」標籤都不見也要判斷得出來（靠出貨狀態區塊） */
  {
    const noLabels = LIST.jp.replace(/伝票番号/g, '—').replace(/配送業者/g, '—');
    const { scrape, asked } = setup(page(noLabels), URL_LIST, { pages: detailPage('jp') });
    const { orders } = await scrape();
    c.eq('沒有伝票番号 → 不擷取', orders.length, 0);
    c.eq('沒有伝票番号 → 不載入詳細頁', asked.length, 0);
  }

  /* 10. 同一頁的其他訂單沒有伝票番号（配送状況を確認できません / 出荷準備中）→ 不擷取也不開詳細頁 */
  {
    const { scrape, asked } = setup(page(LIST.jp), URL_LIST, { pages: detailPage('jp') });
    const { orders } = await scrape();
    c.eq('列表頁共 3 筆訂單', new Set(LIST.jp.match(/\d{6}-\d{8}-\d{10}/g)).size, 3);
    c.eq('只有帶伝票番号的那筆被擷取', [...new Set(orders.map((o) => o.orderId))], [JP.orderId]);
    c.eq('另外兩筆不開詳細頁', asked.length, 1);
  }

  /* 11. 数量：列表頁沒有，從注文詳細頁的「数量：/ Quantity:」回填到對應的品名 */
  {
    loadReaders();
    for (const lang of ['jp', 'en']) {
      const info = await readDetail(lang)();
      c.eq(`詳細頁 ${lang} 每件商品各一個数量`, info.quantities.map((q) => q.quantity), [1, 1]);
      c.eq(`詳細頁 ${lang} 数量對到的品名`, info.quantities.every((q) => q.title.startsWith('【10％OFFクーポン')), true);
    }

    // 把第一件商品改成 3 件，確認讀得到而且只套用在那一件上
    const doc = new JSDOM(page(DETAIL.jp)).window.document;
    const labels = [...doc.querySelectorAll('span, div')].filter((el) => !el.children.length && el.textContent.trim() === '数量：');
    labels[0].parentElement.nextElementSibling.textContent = '3';
    const info = await globalThis.OrderScraper.readers.rakutenDetail(doc);
    c.eq('数量 3 件', info.quantities.map((q) => q.quantity), [3, 1]);

    // 整條流程：英文列表頁的 2 件商品要拿到詳細頁回填的数量
    const modified = '<!doctype html>' + doc.documentElement.outerHTML;
    const { scrape } = setup(page(LIST.en), URL_LIST, { pages: () => modified });
    const { orders } = await scrape();
    c.eq('数量依品名對回列表頁的商品', orders[0].items.map((i) => i.quantity), [3, 1]);
  }

  /* 12. 詳細頁讀不到時，数量當 1 件（不是空值） */
  {
    const { scrape } = setup(page(LIST.jp), URL_LIST, { pages: () => null });
    const { orders } = await scrape();
    c.eq('讀不到詳細頁 → 数量 1 件', [...new Set(orders.flatMap((o) => o.items.map((i) => i.quantity)))], [1]);
  }

  /* 13. 已送達的訂單不擷取。使用者給的實際頁面就是這個狀態：
   *     3 個伝票番号都在，但配送進度停在最後一步 */
  {
    const { scrape, asked } = setup(page(DELIVERED.list), URL_LIST, { pages: detailPage('jp') });
    const { orders } = await scrape();
    c.eq('已送達 → 不擷取', orders.length, 0);
    c.eq('已送達 → 不載入詳細頁', asked.length, 0);
    c.eq('這筆確實有伝票番号', JP.trackingIds.every((t) => DELIVERED.list.includes(t)), true);

    // 詳細頁同一套判斷
    loadReaders();
    const info = await globalThis.OrderScraper.readers.rakutenDetail(new JSDOM(page(DELIVERED.detail)).window.document);
    c.eq('詳細頁已送達 → 配送欄位留空', info.shipments, []);
    c.eq('詳細頁已送達 → 合計仍讀得到', info.total, 10660);

    // 不能用文字判斷：「配達完了」是進度列最後一步的名稱，配送中的頁面一樣有這四個字
    c.eq('配送中的頁面同樣有「配達完了」字樣', LIST.jp.includes('配達完了'), true);
  }

  return c.report();
};
