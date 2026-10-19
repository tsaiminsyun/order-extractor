/* にじさんじオフィシャルストア：以使用者提供的實際 HTML 為測試資料
 * nijisanji-list-jp.html    ご注文履歴的訂單列表（.order-history-list 那一段）：2 筆訂單 ——
 *                           SN000012372064（2026/07/22，商品全部「着荷済み」）、
 *                           N2206240877900（2022/06/26，商品全部「出荷済み」）
 * nijisanji-detail-jp.html  SN000012372064 的注文詳細：配送伝票番号 / 合計 / 商品與数量。
 *                           姓名 / 住址 / 電話 / 郵遞區號已置換
 *
 * 實際的那筆已送達，依規則不擷取（第 1 項）。要驗擷取的欄位，就把它的狀態標籤
 * 「着荷済み」改成「出荷済み」—— 規則只看這幾個字，其餘 HTML 與使用者給的完全一樣。
 * 翻頁、個数 2 件以上、狀態混雜這幾種情境實際頁面上沒有，是改實際 HTML 造出來的，標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://shop.nijisanji.jp/mypage/order-history';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('nijisanji-list-jp.html');
const DETAIL = fixture('nijisanji-detail-jp.html');

const SN = 'SN000012372064';
const OLD = 'N2206240877900';
const DETAIL_URL = (id) => `https://shop.nijisanji.jp/mypage/order-history/detail?orderID=${id}`;
const WANT = {
  trackingId: '366129410824',
  total: 12182,
  items: [
    '【にじネイル Shiny】ネイルポリッシュ ローレン・イロアス',
    '【にじネイル Sparkling】ネイルポリッシュ ローレン・イロアス',
    '【にじさんじフレグランス vol.2】 ローレン・イロアス',
    '【Noctyx Cozy Night】マグカップ サニー・ブリスコー',
    '【Thanksgiving】マグカップキャンドル サニー・ブリスコー',
  ],
  image: 'https://shop.nijisanji.jp/on/demandware.static/-/Sites-nijisanji-master-catalog/default/dw74fa33b8/physical/SSZS000068780_1.png',
};

// 列表上的每一筆（<li>），以及把狀態改成配送中的版本
const ROWS = [...new JSDOM(page(LIST)).window.document.querySelectorAll('.order-history-list > li')].map((li) => li.outerHTML);
const inTransit = (html) => html.replace(/着荷済み/g, '出荷済み');
const list = (rows, extra = '') => page(`<ul class="order-history-list">${rows.join('')}</ul>${extra}`);
// 詳細頁只存了 SN 這一筆，其他的當作讀不到
const detailOf = (url) => (url === DETAIL_URL(SN) ? page(DETAIL) : null);
const readDetail = async (html) => {
  loadReaders();
  return globalThis.OrderScraper.readers.nijisanjiDetail(new JSDOM(page(html), { url: DETAIL_URL(SN) }).window.document);
};

module.exports = async function run() {
  const c = new Check('にじさんじ（實際 HTML）');

  /* 1. 實際頁面：全部「着荷済み」的那筆連詳細頁都不讀；「出荷済み」的那筆要讀 */
  {
    c.eq('頁面上有 2 筆訂單', ROWS.length, 2);
    c.eq('SN 那筆的標籤全部是着荷済み', [...ROWS[0].matchAll(/label-gray">\s*([^<]+?)\s*</g)].every((m) => m[1] === '着荷済み'), true);
    const { scrape, asked } = setup(page(LIST), URL_LIST, { pages: detailOf });
    const res = await scrape();
    c.eq('站台', res.site, 'nijisanji');
    c.eq('只讀出荷済み那筆的詳細頁', asked.map((a) => a.url), [DETAIL_URL(OLD)]);
    c.eq('沒有列出任何包裹', res.orders, []);
    // 出荷済み卻讀不到詳細頁的，要報個數，不能無聲消失
    c.eq('出荷済み但讀不到詳細頁 → 算進「讀不到配送資料」', res.missingTracking, 1);
  }

  /* 2. 同一筆改成配送中（着荷済み → 出荷済み）：欄位都從詳細頁來 */
  {
    const { scrape } = setup(list([inTransit(ROWS[0])]), URL_LIST, { pages: detailOf });
    const res = await scrape();
    const [o] = res.orders;
    c.eq('列出那筆', res.orders.map((x) => x.orderId), [SN]);
    c.eq('注文日', o?.orderedAt, '2026-07-22');
    c.eq('配送伝票番号', o?.trackingId, WANT.trackingId);
    c.eq('配送業者：頁面上沒有，留空', o?.carrier, '');
    c.eq('合計（お支払い合計金額，不是商品合計金額 11,500）', o?.total, WANT.total);
    c.eq('商品：組合商品底下的內容物（特典カード等）不另列', o?.items.map((i) => i.title), WANT.items);
    c.eq('数量', o?.items.map((i) => i.quantity), [1, 1, 1, 1, 1]);
    c.eq('画像轉成完整網址', o?.items[0]?.imageUrl, WANT.image);
  }

  /* 3. 狀態混雜（造出來的：只把第一個標籤改成出荷済み）→ 還有東西在路上，要讀 */
  {
    const mixed = ROWS[0].replace('着荷済み', '出荷済み');
    c.eq('造出來的列只有一個出荷済み', (mixed.match(/出荷済み/g) || []).length, 1);
    const { scrape, asked } = setup(list([mixed]), URL_LIST, { pages: detailOf });
    const res = await scrape();
    c.eq('讀了詳細頁', asked.map((a) => a.url), [DETAIL_URL(SN)]);
    c.eq('列出伝票番号', res.orders.map((o) => o.trackingId), [WANT.trackingId]);
  }

  /* 4. 認不出狀態（造出來的：拿掉所有標籤）→ 照樣讀詳細頁，有伝票番号就列；
   *    讀不到時不報「讀不到配送資料」—— 認不出來的多半是還沒出貨 */
  {
    const bare = ROWS[0].replace(/<li>\s*<span class="label label-gray">[^<]*<\/span>\s*<\/li>/g, '');
    c.eq('造出來的列沒有任何標籤', /label-gray/.test(bare), false);
    const found = setup(list([bare]), URL_LIST, { pages: detailOf });
    c.eq('有伝票番号就列', (await found.scrape()).orders.map((o) => o.trackingId), [WANT.trackingId]);
    const missing = setup(list([bare]), URL_LIST, { pages: () => null });
    const res = await missing.scrape();
    c.eq('讀不到詳細頁時不列', res.orders, []);
    c.eq('也不算進「讀不到配送資料」', res.missingTracking, 0);
  }

  /* 5. 詳細頁讀取器 */
  {
    const info = await readDetail(DETAIL);
    c.eq('伝票番号只取「配送伝票番号」底下那一個', info.trackingIds, [WANT.trackingId]);
    // お届け先的電話也是一串數字，就在配送伝票番号的正上方
    c.eq('お届け先的電話（10 位數字）不會被當成伝票番号', /<span>0312345678<\/span>\s*<h4[^>]*>配送伝票番号/.test(DETAIL), true);
    c.eq('合計', info.total, WANT.total);
    c.eq('商品 5 件', info.items.length, 5);

    // 個数 2 件以上（實際頁面上都是 1，把第一件改成 3）
    const three = await readDetail(DETAIL.replace(
      '<span class="text-bold cartitem-count-text">1</span>', '<span class="text-bold cartitem-count-text">3</span>'));
    c.eq('数量取「数量」旁的數字', three.items.map((i) => i.quantity), [3, 1, 1, 1, 1]);

    const login = page('<form><input type="email" name="email"><input type="password" name="password"></form>');
    c.eq('讀取器認得登入頁', await readDetail(login), { signIn: true });
  }

  /* 6. 注文番号兩種格式、注文日 */
  {
    setup(page(LIST), URL_LIST);
    const site = globalThis.OrderScraper.sites.find((s) => s.name === 'nijisanji');
    const orders = site.findOrders(new JSDOM(page(LIST)).window.document, URL_LIST);
    c.eq('注文番号（去掉「ご注文番号」與全形空白）', orders.map((o) => o.orderId), [SN, OLD]);
    c.eq('注文日', orders.map((o) => o.orderedAt), ['2026-07-22', '2022-06-26']);
    c.eq('詳細頁用 fetch（伺服器渲染）', [...new Set(orders.flatMap((o) => o.lookups).map((l) => l.via))], ['fetch']);
  }

  /* 7. 翻頁停在七天（實際頁面上沒有分頁區塊；日期改成相對於今天、「次へ」連結與第 2 頁是加上去的） */
  {
    const jaDate = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日 19:48`;
    };
    const redate = (row, daysAgo) => row.replace(/\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}/, jaDate(daysAgo));
    c.eq('改日期的規則對得上實際 HTML', redate(ROWS[0], 1) !== ROWS[0], true);
    const NEXT = '<a href="/mypage/order-history?page=2">次へ</a>';
    const PAGE2_URL = 'https://shop.nijisanji.jp/mypage/order-history?page=2';
    const serve = (url) => (url === PAGE2_URL ? list([redate(ROWS[1], 3)]) : detailOf(url));

    // 第 1 頁：一天前（配送中）、三十天前 → 不翻頁，三十天前那筆也不讀詳細頁
    const stop = setup(list([redate(inTransit(ROWS[0]), 1), redate(ROWS[1], 30)], NEXT), URL_LIST, { pages: serve });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁', stopped.pages, 1);
    c.eq('只讀七天內那筆的詳細頁', stop.asked.map((a) => a.url), [DETAIL_URL(SN)]);
    c.eq('列出七天內那筆', stopped.orders.map((o) => o.orderId), [SN]);

    // 對照：第 1 頁都在七天內 → 用 fetch 讀第 2 頁
    const more = setup(list([redate(inTransit(ROWS[0]), 1)], NEXT), URL_LIST, { pages: serve });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 翻到第 2 頁', both.pages, 2);
    c.eq('第 2 頁那筆也去讀詳細頁', more.asked.map((a) => a.url).includes(DETAIL_URL(OLD)), true);
  }

  /* 8. PING 回報站台；其他網域、或沒有訂單列表的頁面都不該認得 */
  {
    const pong = await setup(page(LIST), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'nijisanji', 'にじさんじオフィシャルストア']);
    c.eq('其他網域不認', (await setup(page(LIST), 'https://example.com/mypage/order-history').ping()).onOrderPage, false);
    c.eq('沒有訂單列表不認', (await setup(page('<div>マイページ</div>'), URL_LIST).ping()).onOrderPage, false);
  }

  return c.report();
};
