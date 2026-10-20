/* mu-mo ショップ：以使用者提供的實際 HTML 為測試資料
 * mumo-list-jp.html             購入履歴・配送状況一覧（table 那一段）：19 筆，2 筆出荷待ち、17 筆配達完了
 * mumo-detail-waiting-jp.html   36312766 的詳細頁：出荷待ち，一個配送セット 10 件商品
 * mumo-detail-delivered-jp.html 35956286 的詳細頁：配達完了，配送会社 / 伝票番号都在
 *   （使用者把兩頁存在同一個檔案，這裡拆成兩個）。姓名 / 讀音 / 住址 / 電話 / email / order_tel 已置換
 *
 * 實際頁面上沒有配送中的訂單，配送中的狀態文字也還沒看過。要驗擷取，就把狀態那幾個字
 * 改成「出荷済み」（造出來的；規則只看它**不是**出荷待ち / 配達完了），其餘 HTML 不動。
 *
 * 詳細頁靠頁面的 detail() 送出 form[name="jumpdetail"] 打開，那張表單不在給的片段裡。
 * 測試用的表單照 detail() 的原始碼造（order_id / order_tel），method 與其他欄位實際上不知道，
 * 所以 POST / GET 兩種都驗。其他造出來的情境標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');
const { shiftJis } = require('./sjis.cjs');

const URL_LIST = 'https://shop.mu-mo.net/avx/sv/mypordhist05?jsiteid=mumo';
const DETAIL = 'https://shop.mu-mo.net/avx/sv/mypordhist03usr';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('mumo-list-jp.html');
const WAITING = fixture('mumo-detail-waiting-jp.html');
const DELIVERED = fixture('mumo-detail-delivered-jp.html');

const TEL = '0TELxxxxxxxxxxxxxxxxxxx--';                // order_tel（已置換）
const ID = { 36312766: '0.uLq7CIcp9kGHQA_9B4Kak--', 35956286: '02pMZSiyQrRHEHKQ6lOSNYq--' };  // order_id
const FORM = (method = 'post') => `<form name="jumpdetail" method="${method}" action="">`
  + '<input type="hidden" name="order_id" value=""><input type="hidden" name="order_tel" value="">'
  + '<input type="hidden" name="jsiteid" value="mumo"><input type="submit" name="go" value="送信"></form>';

// 列表的每一筆：標頭列、欄位名稱列、資料列各自的 HTML
const BLOCKS = (() => {
  const blocks = [];
  for (const tr of new JSDOM(page(LIST)).window.document.querySelectorAll('table.tableCart tr')) {
    if (tr.querySelector('th.cellHead')) blocks.push([]);
    blocks.at(-1)?.push(tr.outerHTML);
  }
  return blocks.map((rows) => rows.join(''));
})();
const block = (orderId) => BLOCKS.find((b) => b.includes(`<td rowspan="1">${orderId}</td>`));
const list = (blocks, extra = FORM()) => page(`<table class="tableCart tablePager"><tbody>${blocks.join('')}</tbody></table>${extra}`);
const shipped = (html) => html.replace(/<td>(?:出荷待ち|配達完了)<\/td>/, '<td>出荷済み</td>');
// 詳細頁：配達完了 → 出荷済み（配送会社 / 伝票番号是實際的）
const DELIVERED_LIVE = DELIVERED.replace('配達完了<br />', '出荷済み<br />');
const detailOf = (url) => (url.includes(`ordid=${ID[35956286]}`) ? page(DELIVERED_LIVE)
  : url.includes(`ordid=${ID[36312766]}`) ? page(WAITING) : null);
const readDetail = async (html) => {
  loadReaders();
  return globalThis.OrderScraper.readers.mumoDetail(new JSDOM(page(html)).window.document);
};
const site = () => globalThis.OrderScraper.sites.find((s) => s.name === 'mumo');

module.exports = async function run() {
  const c = new Check('mu-mo ショップ（實際 HTML）');

  /* 1. 實際頁面：出荷待ち 2 筆、配達完了 17 筆，都沒有東西在路上 → 一頁都不讀 */
  {
    const statuses = [...LIST.matchAll(/<td>(出荷待ち|配達完了)<\/td>/g)].map((m) => m[1]);
    c.eq('19 筆：出荷待ち 2、配達完了 17', [BLOCKS.length, statuses.filter((s) => s === '出荷待ち').length, statuses.filter((s) => s === '配達完了').length], [19, 2, 17]);
    const { scrape, asked } = setup(list(BLOCKS), URL_LIST, { pages: detailOf });
    const res = await scrape();
    c.eq('站台', res.site, 'mumo');
    c.eq('一筆都不列', res.orders, []);
    c.eq('沒有讀任何詳細頁', asked, []);
    c.eq('也沒有「讀不到」', res.missingTracking, 0);
  }

  /* 2. 列表上不是出荷待ち / 配達完了 → 照 detail() 送出表單（POST）讀詳細頁 */
  {
    const { scrape, asked } = setup(list([shipped(block('35956286'))]), URL_LIST, { pages: detailOf });
    const res = await scrape();
    c.eq('照 detail() 組出的請求', asked, [{
      url: `${DETAIL}?ordid=${ID[35956286]}`,
      method: 'POST',
      // order_id / order_tel 來自「履歴詳細」的 onclick；其他欄位照表單帶；送出按鈕不帶
      body: `order_id=${encodeURIComponent(ID[35956286])}&order_tel=${encodeURIComponent(TEL)}&jsiteid=mumo`,
    }]);
    const [o] = res.orders;
    c.eq('列出那個包裹', res.orders.map((x) => [x.orderId, x.orderedAt]), [['35956286', '2026-06-11']]);
    c.eq('配送会社 / 伝票番号', [o?.carrier, o?.trackingId], ['ヤマト運輸', '408273350844']);
    c.eq('合計（お支払い合計）', o?.total, 4100);
    c.eq('商品 / 個数（頁面上沒有圖）', o?.items, [{ title: 'ぬいぐるみキーホルダー（ランダム全４種）', quantity: 1, imageUrl: null }]);
  }

  /* 3. 表單是 GET 的話：跟瀏覽器一樣，網址原本的 ?ordid= 會被表單欄位取代 */
  {
    const { scrape, asked } = setup(list([shipped(block('35956286'))], FORM('get')), URL_LIST, { pages: () => null });
    await scrape();
    c.eq('GET：欄位放在網址上', asked, [{
      url: `${DETAIL}?order_id=${encodeURIComponent(ID[35956286])}&order_tel=${encodeURIComponent(TEL)}&jsiteid=mumo`,
    }]);
  }

  /* 4. 讀不到詳細頁：空的包裹留著，算進「讀不到配送資料」；頁面上沒有那張表單也一樣 */
  {
    const failed = await setup(list([shipped(block('35956286'))]), URL_LIST, { pages: () => null }).scrape();
    c.eq('詳細頁讀不到 → 報 1 個讀不到', [failed.orders, failed.missingTracking], [[], 1]);
    const noForm = setup(list([shipped(block('35956286'))], ''), URL_LIST, { pages: detailOf });
    const res = await noForm.scrape();
    c.eq('沒有表單 → 不送請求，報 1 個讀不到', [noForm.asked, res.missingTracking], [[], 1]);
  }

  /* 5. 讀到了但沒有伝票番号（列表改成沒看過的字樣、詳細頁實際是出荷待ち）→ 不列，也不算「讀不到」 */
  {
    const unseen = block('36312766').replace('<td>出荷待ち</td>', '<td>入金待ち</td>');
    const res = await setup(list([unseen]), URL_LIST, { pages: detailOf }).scrape();
    c.eq('不列', res.orders, []);
    c.eq('不算讀不到', res.missingTracking, 0);
  }

  /* 6. 詳細頁讀取器 */
  {
    const waiting = await readDetail(WAITING);
    c.eq('出荷待ち：沒有包裹，合計照讀', [waiting.parcels, waiting.total], [[], 45680]);
    const delivered = await readDetail(DELIVERED);
    c.eq('配達完了：不擷取', [delivered.parcels, delivered.total], [[], 4100]);

    // 出荷待ち那頁補上配送会社 / 伝票番号（造出來的）：10 件商品都屬於這個包裹
    const live = await readDetail(WAITING.replace('出荷待ち<br />', '出荷済み<br />配送会社：ヤマト運輸<br />123412341234<br />'));
    c.eq('10 件商品都掛在這個包裹', live.parcels.map((p) => [p.trackingId, p.items.length]), [['123412341234', 10]]);
    c.eq('個数取單價右邊那格', live.parcels[0]?.items.map((i) => i.quantity), [13, 1, 1, 2, 4, 1, 2, 1, 1, 2]);
    c.eq('品名不含商品代碼', live.parcels[0]?.items[0]?.title, 'アクリルスタンド -スイートレストラン- (A 星宮いちご)');

    /* 兩個包裹（造出來的）：前 3 件出荷済み、後 7 件配達完了。
     * 配送狀況格的 rowspan 決定範圍，所以只有前 3 件的包裹被列出 */
    const doc = new JSDOM(page(WAITING)).window.document;
    const rows = [...doc.querySelectorAll('table.tableCart tr')].filter((tr) => tr.querySelector('td.cellItem'));
    const first = rows[0].querySelector('td.cellDeliv');
    first.setAttribute('rowspan', '3');
    first.innerHTML = '出荷済み<br />配送会社：佐川急便<br />111122223333<br />';
    const second = doc.createElement('td');
    second.className = 'cellDeliv';
    second.setAttribute('rowspan', '7');
    second.innerHTML = '配達完了<br />配送会社：ヤマト運輸<br />444455556666<br />';
    rows[3].querySelector('td.cellItem').after(second);
    const split = await readDetail(doc.body.innerHTML);
    c.eq('兩個包裹：只列出還沒送達的那個，商品只有它自己的 3 件',
      split.parcels.map((p) => [p.carrier, p.trackingId, p.items.map((i) => i.quantity)]), [['佐川急便', '111122223333', [13, 1, 1]]]);

    const login = page('<form><input type="text" name="id"><input type="password" name="pw"></form>');
    c.eq('讀取器認得登入頁', await readDetail(login), { signIn: true });
  }

  /* 7. 一筆訂單有好幾列（造出來的：注文番号 rowspan=2，第二列少了左邊那格）。
   *    第一列配達完了、第二列出荷済み → 還有東西在路上，要讀詳細頁 */
  {
    const doc = new JSDOM(page(`<table><tbody>${block('35956286')}</tbody></table>`)).window.document;
    const data = [...doc.querySelectorAll('tr')].at(-1);
    data.querySelector('td').setAttribute('rowspan', '2');
    const extra = data.cloneNode(true);
    extra.querySelector('td').remove();
    extra.querySelectorAll('td')[2].textContent = '出荷済み';
    data.after(extra);
    const { scrape, asked } = setup(list([doc.querySelector('tbody').innerHTML]), URL_LIST, { pages: () => null });
    await scrape();
    c.eq('第二列少一格，狀態仍從右邊對齊讀到', asked.length, 1);
  }

  /* 8. 注文番号 / 注文日 */
  {
    setup(page(LIST), URL_LIST);
    const orders = site().findOrders(new JSDOM(list(BLOCKS)).window.document, URL_LIST);
    c.eq('19 筆都認得', orders.length, 19);
    c.eq('注文番号', orders.slice(0, 3).map((o) => o.orderId), ['36351018', '36312766', '35956286']);
    c.eq('注文日（「▼P 2026/10/06ご注文（履歴詳細）」）', orders.slice(0, 3).map((o) => o.orderedAt), ['2026-10-06', '2026-09-21', '2026-06-11']);
  }

  /* 9. 翻頁停在七天（實際頁面上沒有分頁區塊；日期改成相對於今天、「次へ」連結與第 2 頁是加上去的） */
  {
    const ymd = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    };
    const redate = (html, daysAgo) => html.replace(/\d{4}\/\d{2}\/\d{2}ご注文/, `${ymd(daysAgo)}ご注文`);
    c.eq('改日期的規則對得上實際 HTML', redate(BLOCKS[0], 1) !== BLOCKS[0], true);
    const NEXT = '<a href="/avx/sv/mypordhist05?jsiteid=mumo&page=2">次へ</a>';
    const PAGE2 = 'https://shop.mu-mo.net/avx/sv/mypordhist05?jsiteid=mumo&page=2';
    const serve = (url) => (url === PAGE2 ? list([redate(block('35248476'), 3)]) : detailOf(url));

    const stop = setup(list([redate(shipped(block('35956286')), 1), redate(block('36312766'), 30)], FORM() + NEXT), URL_LIST, { pages: serve });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁', stopped.pages, 1);
    c.eq('只讀七天內那筆的詳細頁', stop.asked.map((a) => a.url), [`${DETAIL}?ordid=${ID[35956286]}`]);
    c.eq('列出七天內那筆', stopped.orders.map((o) => o.orderId), ['35956286']);

    const more = setup(list([redate(block('36351018'), 1)], FORM() + NEXT), URL_LIST, { pages: serve });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 用 fetch 讀第 2 頁', [both.pages, more.asked.map((a) => a.url)], [2, [PAGE2]]);
  }

  /* 10. Shift_JIS 的回應：照 Content-Type 的 charset（或 <meta charset>）解碼，不能一律當 UTF-8 */
  {
    setup(page(LIST), URL_LIST);
    const { util } = globalThis.OrderScraper;
    const html = page(DELIVERED_LIVE);
    const respond = (bytes, contentType) => async () => ({
      ok: true, status: 200, url: DETAIL,
      headers: { get: (n) => (/^content-type$/i.test(n) ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const parcelsOf = async (doc) => (await globalThis.OrderScraper.readers.mumoDetail(doc)).parcels.map((p) => [p.carrier, p.trackingId]);

    globalThis.fetch = respond(shiftJis(html), 'text/html; charset=Shift_JIS');
    c.eq('Content-Type 寫 Shift_JIS', await parcelsOf((await util.fetchDoc(DETAIL)).doc), [['ヤマト運輸', '408273350844']]);

    const withMeta = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>${DELIVERED_LIVE}</body></html>`;
    globalThis.fetch = respond(shiftJis(withMeta), 'text/html');
    c.eq('只有 <meta> 寫 Shift_JIS', await parcelsOf((await util.fetchDoc(DETAIL)).doc), [['ヤマト運輸', '408273350844']]);

    globalThis.fetch = respond(new TextEncoder().encode(html), 'text/html');
    c.eq('都沒寫 → UTF-8', await parcelsOf((await util.fetchDoc(DETAIL)).doc), [['ヤマト運輸', '408273350844']]);
  }

  /* 11. PING 回報站台；其他網域、詳細頁本身都不該認得 */
  {
    const pong = await setup(list(BLOCKS), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'mumo', 'mu-mo ショップ']);
    c.eq('其他網域不認', (await setup(list(BLOCKS), 'https://example.com/avx/sv/mypordhist05').ping()).onOrderPage, false);
    c.eq('詳細頁不是訂單列表', (await setup(page(WAITING), `${DETAIL}?ordid=x`).ping()).onOrderPage, false);
  }

  return c.report();
};
