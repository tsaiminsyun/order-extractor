/* ポケモンセンターオンライン：以使用者提供的實際 HTML 為測試資料
 * pokemoncenter-list-jp.html    注文履歴的訂單列表（.comOrderList 那一段）：20 筆訂單，
 *                               17 筆発送済み、3 筆注文受付済み（【受注】的預購商品）
 * pokemoncenter-detail-jp.html  第一筆（3000017771706）的注文詳細：送り状番号 / 黑貓查詢連結 /
 *                               商品 2 件＋特典 2 件 / 支払合計。姓名 / 住址 / 電話已置換
 *
 * 列表頁的實際網址沒有拿到，URL_LIST 的路徑是測試自己取的 —— 站台判斷只看網域和版面，不看路徑。
 * 分批出貨、個数 2 件以上、翻頁這幾種情境實際頁面上沒有，是改實際 HTML 造出來的，標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://www.pokemoncenter-online.com/order-history/';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('pokemoncenter-list-jp.html');
const DETAIL = fixture('pokemoncenter-detail-jp.html');

const WANT = {
  orderId: '3000017771706',
  total: 4895,
  carrier: 'ヤマト運輸',
  trackingId: '504018441522',
  items: [
    'A4クリアファイル Pokémon Magic Hour Illusion!',
    'ぬいぐるみ Pokémon Magic Hour Illusion! パモ',
    '【特典：キャンペーン景品】『Pokémon Sleep』おすそわけして寝ステッカー',
    '【特典：キャンペーン景品】ミュウのミラクルスナップ風フォトフレーム',
  ],
  image: 'https://www.pokemoncenter-online.com/a/img/item/4521329439365/S/c6670fb09ea22fe3afb21c4ec9a6aa1e2501ba280c4115af7941b60a3b4b7c86.jpg',
};
const UNSHIPPED = ['3000014727402', '3000012036028', '3000009464089'];

// 詳細頁只存了第一筆，其他的當作讀不到
const detailOf = (url) => (url.includes(`orderID=${WANT.orderId}`) ? page(DETAIL) : null);
const readDetail = async (html) => {
  loadReaders();
  return globalThis.OrderScraper.readers.pokemonDetail(new JSDOM(page(html)).window.document);
};
// 列表上的每一筆（<li>）
const ROWS = [...new JSDOM(page(LIST)).window.document.querySelectorAll('.comOrderList > li')].map((li) => li.outerHTML);
const list = (rows, extra = '') => page(`<ul class="comOrderList">${rows.join('')}</ul>${extra}`);

module.exports = async function run() {
  const c = new Check('ポケモンセンター（實際 HTML）');

  /* 1. 實際頁面：発送済み的才讀詳細頁，欄位都從詳細頁來 */
  {
    const { scrape, asked } = setup(page(LIST), URL_LIST, { pages: detailOf });
    const res = await scrape();
    c.eq('站台', res.site, 'pokemoncenter');
    c.eq('頁面上有 20 筆訂單', ROWS.length, 20);
    c.eq('列出讀得到送り状番号的那筆', res.orders.map((o) => o.orderId), [WANT.orderId]);
    const [o] = res.orders;
    c.eq('注文日', o?.orderedAt, '2026-09-10');
    c.eq('合計（支払合計，不是商品合計 4,345）', o?.total, WANT.total);
    c.eq('配送業者（由「配送状況を確認する」的網址判斷）/ 送り状番号', [o?.carrier, o?.trackingId], [WANT.carrier, WANT.trackingId]);
    c.eq('商品含特典，一件一筆', o?.items.map((i) => i.title), WANT.items);
    c.eq('個数', o?.items.map((i) => i.quantity), [1, 1, 1, 1]);
    c.eq('画像', o?.items[0]?.imageUrl, WANT.image);

    const ids = asked.map((a) => new URL(a.url).searchParams.get('orderID'));
    c.eq('17 筆発送済み都去讀詳細頁', ids.length, 17);
    c.eq('注文受付済み的 3 筆不讀', ids.filter((id) => UNSHIPPED.includes(id)), []);
    // 発送済み卻讀不到詳細頁的，要報個數，不能無聲消失
    c.eq('讀不到詳細頁的 16 筆算進「讀不到配送資料」', res.missingTracking, 16);

    const site = globalThis.OrderScraper.sites.find((s) => s.name === 'pokemoncenter');
    const lookups = site.findOrders(new JSDOM(page(LIST)).window.document, URL_LIST).flatMap((x) => x.lookups);
    c.eq('詳細頁用 fetch（伺服器渲染），不開 iframe', [...new Set(lookups.map((l) => l.via))], ['fetch']);
  }

  /* 2. 送り状番号：頁面上是 5040-1844-1522，輸出去掉連字號 ——
   *    黑貓的查詢網址用的就是去掉連字號的號碼 */
  {
    c.eq('頁面上顯示有連字號', DETAIL.includes('5040-1844-1522'), true);
    c.eq('黑貓查詢網址裡沒有連字號', DETAIL.includes(`pno=${WANT.trackingId}`), true);
    const info = await readDetail(DETAIL);
    c.eq('詳細頁：一個包裹', info.shipments, [{ carrier: WANT.carrier, trackingId: WANT.trackingId }]);
    c.eq('詳細頁：合計', info.total, WANT.total);
  }

  /* 3. 分批出貨（實際頁面上沒有，造出來的）：dd 裡一行一個號碼、各自一個查詢連結。
   *    號碼之間沒有空白，所以不能把 textContent 接起來再切 */
  {
    const html = DETAIL
      .replace('5040-1844-1522<br />', '5040-1844-1522<br />1234-5678-9012<br />')
      .replace('<div class="linkBox">',
        '<div class="linkBox"><a href="https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=123456789012">配送状況を確認する</a>');
    c.eq('造出來的頁面兩個號碼緊貼著', /5040-1844-1522<br \/>1234-5678-9012/.test(html), true);
    const info = await readDetail(html);
    c.eq('兩個包裹，業者各自取帶著該號碼的連結', info.shipments, [
      { carrier: 'ヤマト運輸', trackingId: WANT.trackingId },
      { carrier: '日本郵便', trackingId: '123456789012' },
    ]);
  }

  /* 4. 個数 2 件以上（實際頁面上都是 1，把第一件的選項改成 3） */
  {
    const html = DETAIL.replace('<option value="1">1</option>', '<option value="3">3</option>');
    const info = await readDetail(html);
    c.eq('個数取 <select aria-label="個数"> 的值', info.items.map((i) => i.quantity), [3, 1, 1, 1]);
  }

  /* 5. 注文日：「2026年09月 10日（木）10時17分」月和日中間有空格 */
  {
    setup(page(LIST), URL_LIST);
    const { parseDate } = globalThis.OrderScraper.util;
    c.eq('月和日中間有空格', parseDate('2026年09月 10日（木）10時17分'), '2026-09-10');
    c.eq('其他寫法不受影響', [parseDate('2026年8月21日'), parseDate('2026/09/18(金)')], ['2026-08-21', '2026-09-18']);
    const site = globalThis.OrderScraper.sites.find((s) => s.name === 'pokemoncenter');
    const dates = site.findOrders(new JSDOM(page(LIST)).window.document, URL_LIST).map((o) => o.orderedAt);
    c.eq('20 筆都讀得到注文日', dates.filter(Boolean).length, 20);
    c.eq('最後一筆', dates.at(-1), '2025-05-10');
  }

  /* 6. 登入逾時：詳細頁被導到登入頁 → 不填資料，那個包裹算「讀不到配送資料」 */
  {
    const login = page('<form><input type="email" name="email"><input type="password" name="password"></form>');
    c.eq('讀取器認得登入頁', await readDetail(login), { signIn: true });
    const { scrape } = setup(list([ROWS[0]]), URL_LIST, { pages: () => login });
    const res = await scrape();
    c.eq('沒有列出', res.orders, []);
    c.eq('報出 1 個讀不到', res.missingTracking, 1);
  }

  /* 7. 翻頁停在七天（實際頁面上沒有分頁區塊；日期改成相對於今天、「次へ」連結與第 2 頁是加上去的）
   *    第 1 筆発送済み、第 2 筆注文受付済み、第 3 筆発送済み */
  {
    const jaDate = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月 ${String(d.getDate()).padStart(2, '0')}日（木）`;
    };
    const redate = (row, daysAgo) => row.replace(/(<p class="time">)\d{4}年\d{2}月 \d{2}日（.）/, `$1${jaDate(daysAgo)}`);
    c.eq('改日期的規則對得上實際 HTML', redate(ROWS[0], 1) !== ROWS[0], true);
    const NEXT = '<a href="/order-history/?page=2">次へ</a>';
    const PAGE2_URL = 'https://www.pokemoncenter-online.com/order-history/?page=2';
    const serve = (url) => (url === PAGE2_URL ? list([redate(ROWS[2], 3)]) : detailOf(url));

    // 第 1 頁：一天前、兩天前（未出貨）、三十天前 → 不翻頁，三十天前那筆也不讀詳細頁
    const stop = setup(list([redate(ROWS[0], 1), redate(ROWS[1], 2), redate(ROWS[2], 30)], NEXT), URL_LIST, { pages: serve });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁', stopped.pages, 1);
    c.eq('只讀七天內発送済み那筆的詳細頁', stop.asked.map((a) => a.url),
      [`https://www.pokemoncenter-online.com/order-details/?orderID=${WANT.orderId}&page=1`]);
    c.eq('列出七天內那筆', stopped.orders.map((o) => o.orderId), [WANT.orderId]);

    // 對照：第 1 頁都在七天內 → 用 fetch 讀第 2 頁
    const more = setup(list([redate(ROWS[0], 1)], NEXT), URL_LIST, { pages: serve });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 翻到第 2 頁', both.pages, 2);
    c.eq('第 2 頁那筆也去讀詳細頁', more.asked.map((a) => a.url).includes(
      'https://www.pokemoncenter-online.com/order-details/?orderID=3000014584365&page=1'), true);
  }

  /* 8. PING 回報站台；其他網域、或沒有訂單列表的頁面都不該認得 */
  {
    const pong = await setup(page(LIST), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'pokemoncenter', 'ポケモンセンターオンライン']);
    c.eq('其他網域不認', (await setup(page(LIST), 'https://example.com/order-history/').ping()).onOrderPage, false);
    c.eq('沒有訂單列表不認', (await setup(page('<div>マイページ</div>'), URL_LIST).ping()).onOrderPage, false);
  }

  return c.report();
};
