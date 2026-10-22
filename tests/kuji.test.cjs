/* ちいかわくじ：以使用者提供的實際 HTML 為測試資料
 * kuji-list-jp.html      購入履歴（.checkouts 那一段）：20 張卡片，全部「発送されました」。沒有購入番号、日期、連結
 * kuji-detail-jp.html    第一張的購入履歴詳細：購入番号 / 購入日時 2024/12/07 / 購入金額 / 「配送情報を見る」
 * kuji-delivery-jp.html  那次配送的配送情報：引き換え番号 / 佐川急便 宅配便 / 伝票番号 / 獎品 5 件。
 *                        姓名 / 郵遞區號 / 住址 / email / 電話已置換
 *
 * 實際站台是 Angular：卡片與按鈕都沒有連結，點了才換頁。測試照這個行為造一個會換頁的列表
 * （點卡片 → pushState 到 /mypage/history/…、整頁換成詳細頁；點按鈕 → /exchange/history/…）。
 * 頁面內容都是實際的 HTML，只有購入日時（改成相對於今天，七天的規則才驗得到）與各情境要改的值是造的，標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://online-kuji.chiikawamarket.jp/mypage/history';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('kuji-list-jp.html');
const DETAIL = fixture('kuji-detail-jp.html');
const DELIVERY = fixture('kuji-delivery-jp.html');

const ymd = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
};
const iso = (n) => ymd(n).join('-');
// 詳細頁：購入日時改成 n 天前；金額可換
const detail = (daysAgo, amount = '¥5,500（税込）') =>
  DETAIL.replace('2024/12/07 14:31', `${ymd(daysAgo).join('/')} 14:31`).replace('¥5,500（税込）', amount);
const without = (html, selector) => {
  const doc = new JSDOM(page(html)).window.document;
  doc.querySelector(selector).remove();
  return doc.body.innerHTML;
};

/* 會換頁的列表。cards[i] = { detail, delivery }：點第 i 張換成 detail，再點「配送情報を見る」換成 delivery。
 * opened / shipped 記下點了哪幾張、哪幾張點了配送情報 */
function spa(cards) {
  const opened = [];
  const shipped = [];
  const pages = (url) => (url !== URL_LIST ? null : {
    html: page(LIST),
    setup(doc) {
      const show = (to, html) => {
        doc.defaultView.history.pushState(null, '', to);
        doc.body.innerHTML = html;
      };
      doc.querySelectorAll('sl-lottery-checkout.checkouts-item').forEach((card, i) => card.addEventListener('click', () => {
        opened.push(i);
        show(`/mypage/history/c${i}`, cards[i].detail);
        doc.querySelector('div.shipment button')?.addEventListener('click', () => {
          shipped.push(i);
          show(`/exchange/history/e${i}`, cards[i].delivery);
        });
      }));
    },
  });
  return { pages, opened, shipped };
}

const read = async (name, html) => {
  loadReaders();
  return globalThis.OrderScraper.readers[name](new JSDOM(page(html)).window.document);
};
const TITLES = ['E賞 サイッコーに決まってるッ', 'E賞 もぐもぐ', 'D賞 おかおショルダーバッグ', 'E賞 あくび', 'E賞 キラキラ']
  .map((t) => `ちいかわ 褒めろッ モモンガだらけくじ ${t}`);

module.exports = async function run() {
  const c = new Check('ちいかわくじ（實際 HTML）');

  /* 1. 實際的詳細頁與配送情報（購入日時改成昨天）；第二張三十天前 → 打開它就停，不點它的配送情報 */
  {
    const mock = spa([{ detail: detail(1), delivery: DELIVERY }, { detail: detail(30), delivery: DELIVERY }]);
    const { scrape, asked } = setup(page(LIST), URL_LIST, { pages: mock.pages });
    const res = await scrape({ recentDays: 7 });
    c.eq('站台', [res.ok, res.site], [true, 'kuji']);
    c.eq('一張一個 iframe，打開到三十天前那張就停', [asked.map((a) => a.url), mock.opened], [[URL_LIST, URL_LIST], [0, 1]]);
    c.eq('只有七天內那張點了配送情報', mock.shipped, [0]);
    const [o] = res.orders || [];
    c.eq('一個包裹一列：訂單編號是引き換え番号', [res.orders?.length, o?.orderId], [1, '26-6254-4248-8042']);
    c.eq('購入日時 / 合計（購入金額）', [o?.orderedAt, o?.total, o?.currency], [iso(1), 5500, 'JPY']);
    c.eq('配送業者 / 伝票番号', [o?.carrier, o?.trackingId], ['佐川急便 宅配便', '442609190811']);
    c.eq('獎品 5 件：くじ名＋賞＋獎品名', o?.items.map((i) => [i.title, i.quantity]), TITLES.map((t) => [t, 1]));
    c.eq('獎品圖', o?.items[0]?.imageUrl,
      'https://media.app.slash.gift/public/cloudfront/images/chiikawa/3920229e-bb8a-4fda-bf41-ae8473bf2f24.jpeg.800');
    c.eq('沒有「讀不到」', res.missingTracking, 0);
  }

  /* 2. 讀取器直接讀實際頁面 */
  {
    const checkout = await read('kujiCheckout', DETAIL);
    c.eq('詳細頁：購入番号 / 購入日時 / 購入金額', [checkout.purchaseNo, checkout.orderedAt, checkout.total], ['26-6254-2641-7999', '2024-12-07', 5500]);
    c.eq('詳細頁：「配送情報を見る」按鈕', checkout.shipButton?.textContent.trim(), '配送情報を見る');
    const exchange = await read('kujiExchange', DELIVERY);
    c.eq('配送情報：引き換え番号 / 業者 / 伝票番号', [exchange.exchangeNo, exchange.carrier, exchange.trackingId], ['26-6254-4248-8042', '佐川急便 宅配便', '442609190811']);
    c.eq('配送情報：獎品', exchange.items.map((i) => i.title), TITLES);
    // 造的：號碼帶連字號 → 跟其他站台一樣去掉
    c.eq('伝票番号去掉連字號', (await read('kujiExchange', DELIVERY.replace('442609190811', '4426-0919-0811'))).trackingId, '442609190811');
  }

  /* 3. 實際購入日時 2024/12/07：第一張就超過七天 → 不點配送情報，什麼都不列 */
  {
    const mock = spa([{ detail: DETAIL, delivery: DELIVERY }, { detail: detail(1), delivery: DELIVERY }]);
    const res = await setup(page(LIST), URL_LIST, { pages: mock.pages }).scrape({ recentDays: 7 });
    c.eq('打開第一張就停', [mock.opened, mock.shipped], [[0], []]);
    c.eq('不列、不算讀不到', [res.orders, res.missingTracking], [[], 0]);
  }

  /* 4. 兩次購入一起配送（造的：兩張卡片的配送情報相同、金額不同）→ 只列一次，合計是兩次購入金額加總 */
  {
    const mock = spa([
      { detail: detail(1), delivery: DELIVERY },
      { detail: detail(2, '¥3,300（税込）'), delivery: DELIVERY },
      { detail: detail(30), delivery: DELIVERY },
    ]);
    const res = await setup(page(LIST), URL_LIST, { pages: mock.pages }).scrape({ recentDays: 7 });
    c.eq('兩張都點了配送情報', mock.shipped, [0, 1]);
    c.eq('只列一次，合計加總，購入日時取較新的', res.orders?.map((o) => [o.orderId, o.orderedAt, o.total]), [['26-6254-4248-8042', iso(1), 8800]]);
  }

  /* 5. 還沒申請配送（造的：詳細頁沒有「配送情報を見る」）→ 不列、不算讀不到，繼續看下一張 */
  {
    const mock = spa([
      { detail: without(detail(1), 'div.shipment') },
      { detail: detail(2), delivery: DELIVERY },
      { detail: detail(30), delivery: DELIVERY },
    ]);
    const res = await setup(page(LIST), URL_LIST, { pages: mock.pages }).scrape({ recentDays: 7 });
    c.eq('沒有按鈕那張不點，下一張照常', [mock.opened, mock.shipped], [[0, 1, 2], [1]]);
    c.eq('列出下一張的包裹', [res.orders?.map((o) => o.orderedAt), res.missingTracking], [[iso(2)], 0]);
  }

  /* 6. 申請了但還沒寄出（造的：配送情報沒有業者 / 伝票番号那一塊）→ 不列、不算讀不到 */
  {
    const mock = spa([{ detail: detail(1), delivery: without(DELIVERY, '.carrier') }, { detail: detail(30), delivery: DELIVERY }]);
    const res = await setup(page(LIST), URL_LIST, { pages: mock.pages }).scrape({ recentDays: 7 });
    c.eq('不列、不算讀不到', [res.orders, res.missingTracking], [[], 0]);
  }

  /* 7. iframe 打不開（被擋下）→ 報一個讀不到就停，不再一張張試 */
  {
    const { scrape, asked } = setup(page(LIST), URL_LIST, { pages: () => null });
    const res = await scrape({ recentDays: 7 });
    c.eq('只試一次', asked.length, 1);
    c.eq('報 1 個讀不到', [res.orders, res.missingTracking], [[], 1]);
  }

  /* 8. PING 回報站台；其他網域、詳細頁本身都不該認得 */
  {
    const pong = await setup(page(LIST), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'kuji', 'ちいかわくじ']);
    c.eq('其他網域不認', (await setup(page(LIST), 'https://chiikawamarket.jp/mypage/history').ping()).onOrderPage, false);
    c.eq('詳細頁不是訂單列表', (await setup(page(DETAIL), `${URL_LIST}/0d2388b3`).ping()).onOrderPage, false);
    c.eq('實際列表：20 張卡片', new JSDOM(page(LIST)).window.document.querySelectorAll('sl-lottery-checkout.checkouts-item').length, 20);
  }

  return c.report();
};
