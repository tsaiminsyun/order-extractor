/* アニメイト通販：以使用者提供的實際 HTML 為測試資料
 * animate-list-jp.html  ご注文履歴（section 那一段）：10 筆訂單 ——
 *                       5 筆「お届け済」（有配送伝票番号）、5 筆商品入荷待ち（沒有配送伝票番号）。
 *                       頁尾有實際的分頁區塊（「次へ>>」）。姓名 / 住址已置換
 *
 * 這個站台的列表頁就有全部欄位，所以**完全不會另外載入詳細頁**。
 * 實際頁面上沒有配送中的訂單，要驗擷取的欄位，就把進度列的目前狀態（li.current）
 * 從「お届け済」移回「出荷作業中」—— 規則只看這個 class，其餘 HTML 與使用者給的完全一樣。
 * 其他造出來的情境（業者、件數、翻頁）標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM } = require('./harness.cjs');

const URL_LIST = 'https://www.animate-onlineshop.jp/mypage/history.php';
const PAGE2 = 'https://www.animate-onlineshop.jp/mypage/history.php?pageno=2&order_period=1&ss=1';
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fs.readFileSync(path.join(__dirname, 'fixtures', 'animate-list-jp.html'), 'utf8');

// 已送達 → 配送中：只移動 li.current
const DELIVERED_STEPS = /<li class="prev">出荷作業中<\/li>\s*<li class="current">お届け済<\/li>/g;
const inTransit = (html) => html.replace(DELIVERED_STEPS, '<li class="current">出荷作業中</li>\n<li>お届け済</li>');

const SHIPPED = [
  ['55797386', '2026-09-18', '266262824984', 2794],
  ['55797065', '2026-09-18', '266263794064', 8140],
  ['55672125', '2026-09-11', '266263407804', 3630],
  ['55595294', '2026-09-06', '266263977943', 9240],
  ['55376859', '2026-08-25', '266264125676', 2244],
];

// 每一筆訂單（.order），以及外面那層 .order_histories
const ORDERS = [...new JSDOM(page(LIST)).window.document.querySelectorAll('.order_histories .order')].map((el) => el.outerHTML);
const PAGER = new JSDOM(page(LIST)).window.document.querySelector('.my-pager').outerHTML;
const list = (orders, extra = '') => page(`<section>${orders.map((o) => `<div class="order_histories">${o}</div>`).join('')}${extra}</section>`);
const byId = (id) => ORDERS.find((o) => o.includes(`</span>${id}</p>`));
const read = async (html, opts = {}) => setup(html, URL_LIST, { pages: () => null, ...opts });

module.exports = async function run() {
  const c = new Check('アニメイト通販（實際 HTML）');

  /* 1. 實際頁面：已送達的 5 筆與沒出貨的 5 筆都不擷取，也不讀任何詳細頁 */
  {
    c.eq('頁面上有 10 筆訂單', ORDERS.length, 10);
    c.eq('已送達那 5 筆確實有配送伝票番号', SHIPPED.every(([, , no]) => LIST.includes(`>${no}</a`)), true);
    const { scrape, asked } = await read(page(LIST));
    const res = await scrape();
    c.eq('站台', res.site, 'animate');
    c.eq('一筆都不列', res.orders, []);
    c.eq('只去要第 2 頁（沒有任何詳細頁）', asked.map((a) => a.url), [PAGE2]);
  }

  /* 2. 改成配送中：所有欄位都從列表頁來 */
  {
    c.eq('改造規則對到 5 筆', (LIST.match(DELIVERED_STEPS) || []).length, 5);
    const { scrape } = await read(page(inTransit(LIST)));
    const res = await scrape();
    c.eq('5 筆配送中的都列出來（注文番号 / 注文日 / 伝票番号 / 合計）',
      res.orders.map((o) => [o.orderId, o.orderedAt, o.trackingId, o.total]), SHIPPED);
    c.eq('配送業者由「配送状況を確認」的查詢網址判斷（onclick 裡的 window.open）',
      [...new Set(res.orders.map((o) => o.carrier))], ['日本郵便']);
    const fan = res.orders.find((o) => o.orderId === '55797065');
    c.eq('商品，含「この受注に付与される特典」', fan?.items.map((i) => i.title), [
      '【ファンブック】だいすきプリキュア! めいたんていプリキュア!&プリキュアオールスターズ ファンブック vol.2',
      '【ファンブック】だいすきプリキュア! めいたんていプリキュア!&プリキュアオールスターズ ファンブック vol.3',
      '【ファンブック】だいすきプリキュア! めいたんていプリキュア!&プリキュアオールスターズ ファンブック vol.1',
      '【音楽】TV 『名探偵プリキュア！』後期主題歌シングル/熊田茜音、増井優花【通常盤】',
      'ミニフォト4枚セット（変身前絵柄）',
    ]);
    c.eq('件數', fan?.items.map((i) => i.quantity), [1, 1, 1, 1, 1]);
    c.eq('特典沒有圖', fan?.items.at(-1)?.imageUrl, null);
    c.eq('商品圖', fan?.items[0]?.imageUrl?.startsWith('https://tc-animate.techorus-cdn.com/resize_image/'), true);
  }

  /* 3. 合計取「注文合計金額」，不是商品小計（55797386：商品小計 2,200 + 配送料 594） */
  {
    c.eq('實際頁面上的商品小計是 2,200', /<td>商品小計<\/td>\s*<td>2,200円<\/td>/.test(byId('55797386')), true);
    const { scrape } = await read(list([inTransit(byId('55797386'))]));
    c.eq('合計', (await scrape()).orders[0]?.total, 2794);
  }

  /* 4. 業者：其他網域（造出來的：把查詢網址換掉） */
  {
    const swapHost = (host) => inTransit(byId('55797386')).replace(/https:\/\/trackings\.post\.japanpost\.jp\/[^']*/g, host);
    const yamato = await (await read(list([swapHost('https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01=266262824984')]))).scrape();
    c.eq('ヤマト運輸', yamato.orders.map((o) => o.carrier), ['ヤマト運輸']);
    const unknown = await (await read(list([swapHost('https://example.com/track?no=266262824984')]))).scrape();
    c.eq('認不得的業者：業者留空，伝票番号照樣保留', unknown.orders.map((o) => [o.carrier, o.trackingId]), [['', '266262824984']]);
  }

  /* 5. 件數 2 以上：實際頁面上「9点」那筆還沒出貨，把已送達那筆的配送伝票番号與進度列搬過去（造出來的） */
  {
    const nine = byId('55896139');
    const donor = new JSDOM(page(inTransit(byId('55797386')))).window.document;
    const doc = new JSDOM(page(nine)).window.document;
    doc.querySelector('.order_contact').before(donor.querySelector('.order_slip_number'));
    doc.querySelector('.order-tracking__timeline').replaceWith(donor.querySelector('.order-tracking__timeline'));
    const { scrape } = await read(list([doc.querySelector('.order').outerHTML]));
    const [o] = (await scrape()).orders;
    c.eq('實際頁面上有「9点」', nine.includes('>9点<'), true);
    c.eq('件數取「N点」', o?.items.map((i) => i.quantity), [1, 9]);
  }

  /* 6. 注文番号 / 注文日 */
  {
    setup(page(LIST), URL_LIST);
    const site = globalThis.OrderScraper.sites.find((s) => s.name === 'animate');
    const orders = site.findOrders(new JSDOM(page(LIST)).window.document, URL_LIST);
    c.eq('注文番号（去掉「注文番号　」）', orders.map((o) => o.orderId).slice(0, 3), ['55896139', '55831383', '55797386']);
    c.eq('注文日（「注文日　2026/09/25」）', orders.map((o) => o.orderedAt).slice(0, 3), ['2026-09-25', '2026-09-20', '2026-09-18']);
    c.eq('10 筆都有注文日', orders.filter((o) => o.orderedAt).length, 10);
    c.eq('沒有任何要另外讀的頁', orders.flatMap((o) => o.lookups), []);
  }

  /* 7. 翻頁：實際頁面的「次へ>>」。日期改成相對於今天、第 2 頁是造出來的 */
  {
    setup(page(LIST), URL_LIST);
    const { sites, util } = globalThis.OrderScraper;
    const site = sites.find((s) => s.name === 'animate');
    const doc = new JSDOM(page(LIST), { url: URL_LIST }).window.document;
    c.eq('下一頁（實際的分頁區塊）', site.nextPage(doc, URL_LIST), { url: PAGE2, via: 'fetch' });
    c.eq('通用規則認不得「次へ>>」—— 所以要指定這個站台的分頁區塊', util.nextPageLink(doc, URL_LIST), null);

    const ymd = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    };
    const redate = (order, daysAgo) => order.replace(/(<p class="order__date">注文日　)\d{4}\/\d{2}\/\d{2}/, `$1${ymd(daysAgo)}`);
    c.eq('改日期的規則對得上實際 HTML', redate(ORDERS[0], 1) !== ORDERS[0], true);
    const transit = (id, daysAgo) => redate(inTransit(byId(id)), daysAgo);
    const serve = (url) => (url === PAGE2 ? list([transit('55672125', 3)]) : null);

    // 第 1 頁：一天前（配送中）、三十天前（已送達）→ 不翻頁
    const stop = setup(list([transit('55797386', 1), redate(byId('55797065'), 30)], PAGER), URL_LIST, { pages: serve });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁（已送達的也算數）', stopped.pages, 1);
    c.eq('沒有去要第 2 頁', stop.asked, []);
    c.eq('列出七天內那筆', stopped.orders.map((o) => o.orderId), ['55797386']);

    // 對照：第 1 頁都在七天內 → 用 fetch 讀第 2 頁
    const more = setup(list([transit('55797386', 1)], PAGER), URL_LIST, { pages: serve });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 翻到第 2 頁', both.pages, 2);
    c.eq('第 2 頁的訂單也列出來', both.orders.map((o) => o.orderId), ['55797386', '55672125']);
  }

  /* 8. PING 回報站台；其他網域、或沒有訂單的頁面都不該認得 */
  {
    const pong = await setup(page(LIST), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'animate', 'アニメイト通販']);
    c.eq('其他網域不認', (await setup(page(LIST), 'https://example.com/mypage/history.php').ping()).onOrderPage, false);
    c.eq('沒有訂單不認', (await setup(page('<div>マイページ</div>'), URL_LIST).ping()).onOrderPage, false);
  }

  return c.report();
};
