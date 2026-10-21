/* plusmember：以使用者提供的實際 HTML 為測試資料
 * plusmember-list-jp.html    購入履歴（.list 那一段）：1 筆，985530876
 * plusmember-detail-jp.html  985530876 的購入履歴詳細：発送完了、佐川急便、お問い合わせ番号、5 件商品。
 *                            姓名 / 讀音 / 住址 / 電話已置換
 *
 * 詳細頁靠「詳細」的 onclick（fnChangeAction('./history.php'); fnKeySubmit('order_id', …)）送出表單打開，
 * 那張表單與兩個函式的原始碼都不在給的片段裡。測試用的表單是造出來的（有 order_id 欄位、另外帶一個 token），
 * method 實際上不知道，所以 POST / GET 兩種都驗。列表頁的網址（/shop/mypage/index.php）也是推測的，
 * 只用來解析 './history.php'。其他造出來的情境標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://store.plusmember.jp/shop/mypage/index.php';
const DETAIL = 'https://store.plusmember.jp/shop/mypage/history.php';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('plusmember-list-jp.html');
const DETAIL_HTML = fixture('plusmember-detail-jp.html');

const ID = '985530876';
const FORM = (method = 'post') => `<form name="form1" method="${method}" action="?">`
  + '<input type="hidden" name="order_id" value=""><input type="hidden" name="token" value="tok1">'
  + '<input type="submit" value="送信"></form>';

// 列表的欄位名稱列與那一筆訂單
const [TIT, ROW] = [...new JSDOM(page(LIST)).window.document.querySelectorAll('.list > ul')].map((ul) => ul.outerHTML);
const row = (id, time = '2026/05/19 13:50') => ROW.replaceAll(ID, id).replace('2026/05/19 13:50', time);
const list = (rows, extra = FORM()) => page(`<div class="list">${TIT}${rows.join('')}</div>${extra}`);
// 詳細頁：只回應 order_id 對得上的請求（POST 看 body，GET 看網址）
const detailOf = (details) => (url, init = {}) => {
  const id = new URLSearchParams(init.body || new URL(url).search).get('order_id');
  return url.startsWith(DETAIL) && details[id] ? page(details[id]) : null;
};
const readDetail = async (html) => {
  loadReaders();
  return globalThis.OrderScraper.readers.plusmemberDetail(new JSDOM(page(html)).window.document);
};
const site = () => globalThis.OrderScraper.sites.find((s) => s.name === 'plusmember');
const TITLES = ['SONGTORY_Hayoung', 'JUNI_Jiwon', 'CHAENGRAMI_Chaeyoung', 'NYACCO_Nagyung', 'BAEKMOONG_Jiheon']
  .map((v) => `【fromis_9】froming≪${v} Ver.≫`);

module.exports = async function run() {
  const c = new Check('plusmember（實際 HTML）');

  /* 1. 實際列表 + 實際詳細頁：照 onclick 送出表單（POST），列出佐川急便的那個包裹 */
  {
    const { scrape, asked } = setup(page(LIST + FORM()), URL_LIST, { pages: detailOf({ [ID]: DETAIL_HTML }) });
    const res = await scrape();
    c.eq('站台', res.site, 'plusmember');
    c.eq('照 onclick 組出的請求', asked, [{
      // fnChangeAction('./history.php') 以列表頁為基準；order_id 來自 fnKeySubmit，其他欄位照表單帶；送出按鈕不帶
      url: DETAIL, method: 'POST', body: `order_id=${ID}&token=tok1`,
    }]);
    const [o] = res.orders;
    c.eq('一筆、一個包裹', res.orders.length, 1);
    c.eq('注文番号 / 購入日時', [o?.orderId, o?.orderedAt], [ID, '2026-05-19']);
    c.eq('合計（列表頁的合計金額）', [o?.total, o?.currency], [14380, 'JPY']);
    c.eq('配送業者（追跡確認連到 sagawa-exp.co.jp）/ お問い合わせ番号', [o?.carrier, o?.trackingId], ['佐川急便', '353912840945']);
    c.eq('5 件商品：品名（不含 JAN）/ 個数 / 沒有圖', o?.items, TITLES.map((title) => ({ title, quantity: 1, imageUrl: null })));
    c.eq('沒有「讀不到」', res.missingTracking, 0);
  }

  /* 2. 表單是 GET 的話：欄位放在網址上 */
  {
    const { scrape, asked } = setup(page(LIST + FORM('get')), URL_LIST, { pages: detailOf({ [ID]: DETAIL_HTML }) });
    const res = await scrape();
    c.eq('GET：欄位放在網址上', asked, [{ url: `${DETAIL}?order_id=${ID}&token=tok1` }]);
    c.eq('GET 一樣讀得到', res.orders.map((o) => o.trackingId), ['353912840945']);
  }

  /* 3. 讀不到詳細頁：空的包裹留著，算進「讀不到配送資料」；頁面上沒有帶 order_id 欄位的表單也一樣 */
  {
    const failed = await setup(page(LIST + FORM()), URL_LIST, { pages: () => null }).scrape();
    c.eq('詳細頁讀不到 → 報 1 個讀不到', [failed.orders, failed.missingTracking], [[], 1]);
    const noForm = setup(page(LIST), URL_LIST, { pages: detailOf({ [ID]: DETAIL_HTML }) });
    const res = await noForm.scrape();
    c.eq('沒有表單 → 不送請求，報 1 個讀不到', [noForm.asked, res.missingTracking], [[], 1]);
    const otherForm = setup(page(LIST + '<form method="post"><input name="q"></form>'), URL_LIST, { pages: detailOf({ [ID]: DETAIL_HTML }) });
    await otherForm.scrape();
    c.eq('沒有 order_id 欄位的表單不算', otherForm.asked, []);
  }

  /* 4. 還沒寄出（造出來的：お問い合わせ番号那一組是空的，頁面會把它藏起來）→ 不列，也不算「讀不到」 */
  {
    const unsent = DETAIL_HTML.replace(/<ul class="tit empty">[\s\S]*?<\/ul>/, '<ul class="tit empty">\n    </ul>');
    c.eq('造的頁面確實拿掉了那一組', unsent.includes('お問い合わせ番号'), false);
    const res = await setup(page(LIST + FORM()), URL_LIST, { pages: detailOf({ [ID]: unsent }) }).scrape();
    c.eq('不列', res.orders, []);
    c.eq('不算讀不到', res.missingTracking, 0);
  }

  /* 5. 詳細頁讀取器 */
  {
    const real = await readDetail(DETAIL_HTML);
    // 頁面上還有一段被註解掉的 <li>追跡番号</li>，不能多出一個包裹
    c.eq('實際頁面：一個包裹', real.parcels.map((p) => [p.carrier, p.trackingId, p.items.length]), [['佐川急便', '353912840945', 5]]);

    // 造出來的：個数 3、ヤマト的查詢連結、號碼帶連字號
    const doc = new JSDOM(page(DETAIL_HTML)).window.document;
    doc.querySelectorAll('.item li.quantity')[1].textContent = '3';
    doc.querySelector('.data a[href*="sagawa"]').setAttribute('href', 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko');
    const no = [...doc.querySelectorAll('.data li')].find((li) => li.textContent.trim() === '353912840945');
    no.textContent = '3539-1284-0945';
    const edited = (await readDetail(doc.body.innerHTML)).parcels[0];
    c.eq('個数取 li.quantity', edited?.items.map((i) => i.quantity), [1, 3, 1, 1, 1]);
    c.eq('業者由查詢連結的網域判斷', edited?.carrier, 'ヤマト運輸');
    c.eq('號碼去掉連字號', edited?.trackingId, '353912840945');

    const login = page('<form><input type="text" name="login_email"><input type="password" name="login_pass"></form>');
    c.eq('讀取器認得登入頁', await readDetail(login), { signIn: true });
  }

  /* 6. 一頁好幾筆（造出來的：複製實際那一列，換注文番号）→ 一筆一個請求，各自對回自己的訂單 */
  {
    const B = '985530999';
    const unsent = DETAIL_HTML.replace(/<ul class="tit empty">[\s\S]*?<\/ul>/, '<ul class="tit empty"></ul>');
    const { scrape, asked } = setup(list([row(B, '2026/05/20 09:00'), row(ID)]), URL_LIST,
      { pages: detailOf({ [ID]: DETAIL_HTML, [B]: unsent }) });
    const res = await scrape();
    c.eq('兩筆各送一個請求', asked.map((a) => a.body), [`order_id=${B}&token=tok1`, `order_id=${ID}&token=tok1`]);
    c.eq('只列出有お問い合わせ番号的那筆', res.orders.map((o) => [o.orderId, o.trackingId]), [[ID, '353912840945']]);
  }

  /* 7. 注文番号 / 購入日時：欄位名稱列不算一筆 */
  {
    setup(page(LIST), URL_LIST);
    const orders = site().findOrders(new JSDOM(page(LIST)).window.document, URL_LIST);
    c.eq('實際列表：1 筆', orders.map((o) => [o.orderId, o.orderedAt, o.total]), [[ID, '2026-05-19', 14380]]);
    c.eq('沒有表單時不排讀取，但先放空的包裹', [orders[0]?.lookups, orders[0]?.shipments.length], [[], 1]);
  }

  /* 8. 七天：只讀七天內的詳細頁；整頁都在七天內才翻頁（日期改成相對於今天、「次へ」與第 2 頁是加上去的） */
  {
    const ymd = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} 13:50`;
    };
    const OLD = '985000001';
    const NEXT = '<a href="./index.php?pageno=2">次へ</a>';
    const PAGE2 = `${URL_LIST}?pageno=2`;
    const details = detailOf({ [ID]: DETAIL_HTML });
    const serve = (url, init) => (url === PAGE2 ? list([row('985000002', ymd(3))]) : details(url, init));

    const stop = setup(list([row(ID, ymd(1)), row(OLD, ymd(30))], FORM() + NEXT), URL_LIST, { pages: serve });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁', stopped.pages, 1);
    c.eq('只讀七天內那筆的詳細頁', stop.asked.map((a) => a.body), [`order_id=${ID}&token=tok1`]);
    c.eq('列出七天內那筆', stopped.orders.map((o) => o.orderId), [ID]);

    const more = setup(list([row(ID, ymd(1))], FORM() + NEXT), URL_LIST, { pages: serve });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 用 fetch 讀第 2 頁', [both.pages, more.asked[0]?.url], [2, PAGE2]);
  }

  /* 9. PING 回報站台；其他網域、詳細頁本身都不該認得 */
  {
    const pong = await setup(page(LIST + FORM()), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'plusmember', 'plusmember']);
    c.eq('其他網域不認', (await setup(page(LIST + FORM()), 'https://example.com/shop/mypage/index.php').ping()).onOrderPage, false);
    c.eq('詳細頁不是訂單列表', (await setup(page(DETAIL_HTML), DETAIL).ping()).onOrderPage, false);
  }

  return c.report();
};
