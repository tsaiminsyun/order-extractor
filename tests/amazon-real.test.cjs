/* Amazon.co.jp 注文履歴：以使用者提供的實際 HTML 為測試資料（已移除 script / style）
 * amazon-list-{jp,en,cn}.html      1 件商品、沒有數量標示（＝1 件）。狀態是
 *                                  「8月23日にお届け済み / Delivered August 23 / 已于 8月23日 送达」，
 *                                  已送達，依規則不擷取（第 5 項）；其他欄位的解析用 inTransit() 驗
 * amazon-list-qty-{jp,en,cn}.html  數量 4 件的訂單（.product-image__qty）。這筆已送達，
 *                                  沒有「配送状況を確認」按鈕，所以依規則不擷取
 * amazon-detail-{jp,en,cn}.html    配送狀況頁：配送業者 / トラッキングID
 *
 * 三個語系的列表頁都沒有配送業者與トラッキングID（整份 HTML 裡都找不到），
 * 這也是「配送中的包裹一定要多讀一頁」的原因，下面第 3 項會檢查這件事。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://www.amazon.co.jp/gp/css/order-history';
const LANGS = ['jp', 'en', 'cn'];
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const LIST = Object.fromEntries(LANGS.map((l) => [l, fixture(`amazon-list-${l}.html`)]));
const QTY_LIST = Object.fromEntries(LANGS.map((l) => [l, fixture(`amazon-list-qty-${l}.html`)]));
const DETAIL = Object.fromEntries(LANGS.map((l) => [l, fixture(`amazon-detail-${l}.html`)]));

const WANT = {
  orderId: '503-7097018-1651051',
  total: 2322,
  title: '【ニッケン刃物】関伝の美爪切り ゴールド 鉄製/関市/職人/テコ/キャッチャー/日本製',
  image: 'https://m.media-amazon.com/images/I/61gRjp8TwnL._SS284_.jpg',
  carrier: '日本郵便',
  trackingId: '421304890904',
};

// iframe 會真的載入這份配送狀況頁，再由 readers.js 解析
const detailPage = (lang) => () => `<html><body>${DETAIL[lang]}</body></html>`;

/* 實際頁面上這筆已經送達，依規則不擷取。要驗其他欄位的解析，就把包裹的狀態那一行清空 ——
 * 判斷規則是「只有讀到已送達的字樣才略過」，讀不到狀態一律當配送中，
 * 所以這裡不必捏造「配送中」的文案，清掉就夠 */
function inTransit(html) {
  const dom = new JSDOM(html);
  for (const el of dom.window.document.querySelectorAll('.yohtmlc-shipment-status-primaryText')) el.textContent = '';
  return dom.serialize();
}
const IN_TRANSIT = Object.fromEntries(LANGS.map((l) => [l, inTransit(LIST[l])]));

module.exports = async function run() {
  const c = new Check('Amazon 注文履歴（實際 HTML）');

  /* 1. 配送狀況頁：三個語系讀到同樣的值（配送業者 日本郵便 / Shipped with / 由…配送） */
  {
    loadReaders();
    for (const lang of LANGS) {
      const doc = new JSDOM(`<html><body>${DETAIL[lang]}</body></html>`).window.document;
      const info = await globalThis.OrderScraper.readers.amazonTracking(doc);
      c.eq(`配送狀況頁 ${lang}`, [info.carrier, info.trackingId], [WANT.carrier, WANT.trackingId]);
    }
  }

  /* 2. 列表頁 + 配送狀況頁：三個語系都解析出同一筆訂單 */
  {
    for (const lang of LANGS) {
      const { scrape, asked } = setup(IN_TRANSIT[lang], URL_LIST, { pages: detailPage(lang) });
      const { orders } = await scrape();
      c.eq(`${lang} 訂單數`, orders.length, 1);
      c.eq(`${lang} 注文番号`, orders[0]?.orderId, WANT.orderId);
      c.eq(`${lang} 合計（合計 / Total / 总价）`, orders[0]?.total, WANT.total);
      c.eq(`${lang} 品名`, orders[0]?.items.map((i) => i.title), [WANT.title]);
      c.eq(`${lang} 画像`, orders[0]?.items[0]?.imageUrl, WANT.image);
      c.eq(`${lang} 沒有數量標示 → 1 件`, orders[0]?.items[0]?.quantity, 1);
      c.eq(`${lang} 配送業者 / トラッキングID`, [orders[0]?.carrier, orders[0]?.trackingId], [WANT.carrier, WANT.trackingId]);
      c.eq(`${lang} 只讀一次配送狀況頁`, asked.length, 1);
      c.eq(`${lang} 讀的是配送狀況頁`, /\/progress-tracker\/package\?.*orderId=503-7097018-1651051/.test(asked[0]?.url || ''), true);
    }
  }

  /* 3. 列表頁本身沒有配送資料：少了這一頁就拿不到配送業者與トラッキングID */
  {
    for (const lang of LANGS) {
      const found = [WANT.trackingId, WANT.carrier, 'トラッキングID', 'Tracking ID', '追踪编码'].filter((s) => LIST[lang].includes(s));
      c.eq(`${lang} 列表頁不含配送資料`, found, []);
    }
  }

  /* 4. 數量：圖片角落的 .product-image__qty */
  {
    // 這筆訂單已送達（沒有配送按鈕），先確認依規則不擷取
    for (const lang of LANGS) {
      const { scrape, asked } = setup(QTY_LIST[lang], URL_LIST, { pages: detailPage(lang) });
      const { orders } = await scrape();
      c.eq(`${lang} 已送達的訂單不擷取`, [orders.length, asked.length], [0, 0]);
    }

    // 補一個配送按鈕進去，才能檢查數量有沒有跟著商品出來
    const TRACK = '<li data-csa-c-item-id="ppx_yo2ov_dt_b_fed_track_package"><span class="a-button"><span class="a-button-inner">'
      + '<a class="a-button-text" role="button" href="/progress-tracker/package?orderId=250-3960731-6914219&shipmentId=S1&packageIndex=0">配送状況を確認</a>'
      + '</span></span></li>';
    for (const lang of LANGS) {
      const { scrape } = setup(QTY_LIST[lang].replace('</ul>', TRACK + '</ul>'), URL_LIST, { pages: detailPage(lang) });
      const { orders } = await scrape();
      c.eq(`${lang} 数量`, orders[0]?.items.map((i) => i.quantity), [4]);
      c.eq(`${lang} 数量旁邊的品名與圖片仍正確`, [
        orders[0]?.items[0]?.title.startsWith('【純正品】Levoit'),
        /\/images\/I\//.test(orders[0]?.items[0]?.imageUrl || ''),
      ], [true, true]);
      c.eq(`${lang} 合計`, orders[0]?.total, 14968);
    }
  }

  /* 5. 注文日：注文日（日）/ Order placed（英）/ 已下订单（簡中），寫法都不一樣 */
  {
    for (const lang of LANGS) {
      const { scrape } = setup(IN_TRANSIT[lang], URL_LIST, { pages: detailPage(lang) });
      const { orders } = await scrape();
      c.eq(`${lang} 注文日`, orders[0]?.orderedAt, '2026-08-21');
    }
  }

  /* 6. 已送達的包裹不擷取 —— 送達後「配送状況を確認」按鈕還留著，光看按鈕分不出來 */
  {
    for (const lang of LANGS) {
      const { scrape, asked } = setup(LIST[lang], URL_LIST, { pages: detailPage(lang) });
      const { orders } = await scrape();
      c.eq(`${lang} 已送達 → 不擷取`, orders.length, 0);
      c.eq(`${lang} 已送達就不讀配送狀況頁`, asked.length, 0);
      c.eq(`${lang} 這筆確實還有配送按鈕`, LIST[lang].includes('/progress-tracker/package'), true);
    }

    // 其他語系讀不到狀態字樣，這時一律當成配送中保留，不要連在途的也漏掉
    const unknown = LIST.jp.replace(/8月23日にお届け済み/g, '8월 23일에 배달 완료');
    const { scrape } = setup(unknown, URL_LIST, { pages: detailPage('jp') });
    const { orders } = await scrape();
    c.eq('認不得的語系 → 保留', orders.length, 1);
  }

  return c.report();
};
