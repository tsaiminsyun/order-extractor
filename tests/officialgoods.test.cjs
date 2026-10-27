/* OFFICIAL GOODS STORE：以使用者提供的實際 HTML 為測試資料
 * officialgoods-list-jp.html    注文履歴（.ogs-v2-section 那一段）：1 筆，peb_260730160440-94109（注文確定）
 * officialgoods-detail-jp.html  那一筆的注文詳細：配送状況「出荷済み」/ お問い合わせNo / 商品 8 件 / 総合計。
 *                               姓名 / 住址 / 電話已置換
 *
 * 列表頁的實際網址沒看過（卡片的連結是 /parkeunbin/… 開頭的絕對路徑，列表頁在哪裡都不影響），
 * 測試用 /parkeunbin/mypage/。其他造出來的情境標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const ORIGIN = 'https://official-goods-store.jp';
const URL_LIST = `${ORIGIN}/parkeunbin/mypage/`;
const ID = 'peb_260730160440-94109';
const detailUrl = (id) => `${ORIGIN}/parkeunbin/mypage/order/detail/${id}`;
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('officialgoods-list-jp.html');
const DETAIL = fixture('officialgoods-detail-jp.html');

// 列表的一張卡片：換受注番号 / 注文日時
const CARD = new JSDOM(page(LIST)).window.document.querySelector('a').outerHTML;
const card = (id, at = '2026-07-30 16:04:40') => CARD.replaceAll(ID, id).replace('2026-07-30 16:04:40', at);
const list = (cards, extra = '') => page(`<div class="ogs-v2-section"><div class="ogs-v2-stack direction-vertical space-midium">${cards.join('')}</div></div>${extra}`);
// 詳細頁：各受注番号對應的 HTML
const detailOf = (details) => (url) => {
  const id = Object.keys(details).find((k) => url === detailUrl(k));
  return id ? page(details[id]) : null;
};
const readDetail = async (html) => {
  loadReaders();
  return globalThis.OrderScraper.readers.ogsDetail(new JSDOM(page(html)).window.document);
};
const site = () => globalThis.OrderScraper.sites.find((s) => s.name === 'officialgoods');
const TITLES = ['アクリルキーホルダー', 'フォトカードホルダー', 'BINING ポーチ', 'ペンライトデコバンド',
  'ぷに缶バッジ BINING B', 'ぷに缶バッジ BINING A', 'クリアファイル EUNBIN A', 'クリアファイル BINING A'];
const TRACKING_LINE = '<p class="ogs-v2-text size-small">お問い合わせNo:492241203624</p>';

module.exports = async function run() {
  const c = new Check('OFFICIAL GOODS STORE（實際 HTML）');

  /* 1. 實際列表 + 實際詳細頁：讀那一筆的詳細頁，列出那個包裹 */
  {
    const { scrape, asked } = setup(page(LIST), URL_LIST, { pages: detailOf({ [ID]: DETAIL }) });
    const res = await scrape();
    c.eq('站台', [res.ok, res.site], [true, 'officialgoods']);
    c.eq('讀那一筆的詳細頁（fetch）', asked, [{ url: detailUrl(ID) }]);
    const [o] = res.orders || [];
    c.eq('一筆、一個包裹', res.orders?.length, 1);
    c.eq('受注番号 / 注文日', [o?.orderId, o?.orderedAt], [ID, '2026-07-30']);
    c.eq('合計（列表頁的金額，等於総合計）/ 幣別', [o?.total, o?.currency], [14280, 'JPY']);
    c.eq('配送業者（頁面上沒有，留空）/ お問い合わせNo', [o?.carrier, o?.trackingId], ['', '492241203624']);
    c.eq('8 件商品：品名（種類照留）/ 数量', o?.items.map((i) => [i.title, i.quantity]), TITLES.map((t) => [t, 1]));
    c.eq('商品圖', o?.items[0]?.imageUrl,
      'https://assets.official-goods-store.jp/product/PEB059/8f5f85e84c68f5bb43b0f515b947ba21e73f3d0471879fa31cc0fdfe832e0549.jpg');
    c.eq('沒有「讀不到」', res.missingTracking, 0);
  }

  /* 2. 讀不到詳細頁：空的包裹留著，算進「讀不到配送資料」 */
  {
    const res = await setup(page(LIST), URL_LIST, { pages: () => null }).scrape();
    c.eq('報 1 個讀不到', [res.orders, res.missingTracking], [[], 1]);
  }

  /* 3. 拿到的不是詳細頁（造的：回來的是列表頁）→ 不能當成「還沒寄出」，要算讀不到 */
  {
    const res = await setup(page(LIST), URL_LIST, { pages: () => page(LIST) }).scrape();
    c.eq('沒有受注番号 → 報 1 個讀不到', [res.orders, res.missingTracking], [[], 1]);
  }

  /* 4. 還沒寄出（造的：拿掉お問い合わせNo 那一行）→ 不列，也不算讀不到 */
  {
    c.eq('造的頁面確實拿掉了那一行', DETAIL.includes(TRACKING_LINE), true);
    const unsent = DETAIL.replace(TRACKING_LINE, '');
    const res = await setup(page(LIST), URL_LIST, { pages: detailOf({ [ID]: unsent }) }).scrape();
    c.eq('不列、不算讀不到', [res.orders, res.missingTracking], [[], 0]);
  }

  /* 5. 詳細頁讀取器 */
  {
    const real = await readDetail(DETAIL);
    c.eq('實際頁面：一個包裹', real.parcels?.map((p) => [p.carrier, p.trackingId, p.items.length]), [['', '492241203624', 8]]);

    // 造的：数量 3、兩個號碼（第二個帶連字號）→ 兩個包裹，商品都掛上（頁面不標示對應）
    const edited = DETAIL.replace('<p class="ogs-v2-text">数量 1</p>', '<p class="ogs-v2-text">数量 3</p>')
      .replace(TRACKING_LINE, `${TRACKING_LINE}<p class="ogs-v2-text size-small">お問い合わせNo:1234-5678-9012</p>`);
    const two = await readDetail(edited);
    c.eq('数量取「数量 N」', two.parcels?.[0]?.items.map((i) => i.quantity), [3, 1, 1, 1, 1, 1, 1, 1]);
    c.eq('兩個號碼 → 兩個包裹，去掉連字號', two.parcels?.map((p) => [p.trackingId, p.items.length]), [['492241203624', 8], ['123456789012', 8]]);

    // 造的：同一個號碼出現兩次 → 一個包裹；「配送状況」以外的地方（お届け先的注意事項）出現同樣寫法 → 不算
    const twice = await readDetail(DETAIL.replace(TRACKING_LINE, TRACKING_LINE + TRACKING_LINE));
    c.eq('同一個號碼只算一次', twice.parcels?.map((p) => p.trackingId), ['492241203624']);
    const NOTICE = '本ご注文は配送先変更有効期間を過ぎておりますので';
    const elsewhere = await readDetail(DETAIL.replace(NOTICE, `お問い合わせNo:000011112222 ${NOTICE}`));
    c.eq('只看「配送状況」那一塊', elsewhere.parcels?.map((p) => p.trackingId), ['492241203624']);

    const login = page('<form><input type="email" name="email"><input type="password" name="password"></form>');
    c.eq('讀取器認得登入頁', await readDetail(login), { signIn: true });
  }

  /* 6. 一頁好幾筆（造的：複製實際那張卡片，換受注番号）→ 各讀各的詳細頁 */
  {
    const B = 'peb_260731090000-11111';
    const { scrape, asked } = setup(list([card(B, '2026-07-31 09:00:00'), card(ID)]), URL_LIST,
      { pages: detailOf({ [ID]: DETAIL, [B]: DETAIL.replace(TRACKING_LINE, '') }) });
    const res = await scrape();
    c.eq('兩筆各讀一次', asked.map((a) => a.url), [detailUrl(B), detailUrl(ID)]);
    c.eq('只列出有お問い合わせNo 的那筆', res.orders?.map((o) => [o.orderId, o.trackingId]), [[ID, '492241203624']]);
  }

  /* 7. 受注番号 / 注文日 / 合計 */
  {
    setup(page(LIST), URL_LIST);
    const orders = site().findOrders(new JSDOM(page(LIST)).window.document, URL_LIST);
    c.eq('實際列表：1 筆', orders.map((o) => [o.orderId, o.orderedAt, o.total]), [[ID, '2026-07-30', 14280]]);
  }

  /* 8. 七天：只讀七天內的詳細頁；整頁都在七天內才翻頁（日期改成相對於今天、「次へ」與第 2 頁是加上去的） */
  {
    const at = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 16:04:40`;
    };
    const OLD = 'peb_old-1';
    const NEXT = '<a href="/parkeunbin/mypage/?page=2">次へ</a>';
    const PAGE2 = `${URL_LIST}?page=2`;
    const details = detailOf({ [ID]: DETAIL });
    const serve = (url) => (url === PAGE2 ? list([card('peb_p2-1', at(3))]) : details(url));

    const stop = setup(list([card(ID, at(1)), card(OLD, at(30))], NEXT), URL_LIST, { pages: serve });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁', stopped.pages, 1);
    c.eq('只讀七天內那筆的詳細頁', stop.asked.map((a) => a.url), [detailUrl(ID)]);
    c.eq('列出七天內那筆', stopped.orders?.map((o) => o.orderId), [ID]);

    const more = setup(list([card(ID, at(1))], NEXT), URL_LIST, { pages: serve });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 用 fetch 讀第 2 頁', [both.pages, more.asked[0]?.url], [2, PAGE2]);
  }

  /* 9. PING 回報站台；其他網域、詳細頁本身都不該認得 */
  {
    const pong = await setup(page(LIST), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'officialgoods', 'OFFICIAL GOODS STORE']);
    c.eq('其他網域不認', (await setup(page(LIST), 'https://example.com/parkeunbin/mypage/').ping()).onOrderPage, false);
    c.eq('詳細頁不是訂單列表', (await setup(page(DETAIL), detailUrl(ID)).ping()).onOrderPage, false);
  }

  return c.report();
};
