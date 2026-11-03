/* Weverse Shop：以使用者提供的實際 HTML 為測試資料（同一筆訂單的日文 / 英文 / 繁中）
 * weverse-list-{jp,en,tw}.html      注文履歴（那一組）：代表注文番号 124145358465579817，配送準備中，有「配送状況照会」按鈕
 * weverse-tracking-{jp,en,tw}.html  按那顆按鈕跳出的彈窗：伝票番号 CA1202435081 / 配送業者 CMA
 *   （使用者把彈窗貼在列表檔案的最後面，這裡拆成兩個）。列表與彈窗都沒有個資
 * weverse-detail-{jp,en,tw}.html    同一筆的注文詳細：合計金額 / Grand Total / 付款總金額 ¥2,875。姓名 / email / 電話 / 住址已置換
 *
 * 實際站台是 React：按鈕按下去，彈窗才加到 body 最後面。測試照這個行為造一個會跳彈窗的列表，
 * 內容用上面的實際 HTML。詳細頁的網址照使用者給的實際網址（/{語系}/order/details/{代表注文番号}）；
 * 列表頁的網址沒看過，用 /{語系}/mypage/orders。其他造出來的情境標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM } = require('./harness.cjs');

const ID = '124145358465579817';
const SEG = { jp: 'ja', en: 'en', tw: 'zh-tw' };  // 網址的第一段
const listUrl = (lang = 'jp') => `https://shop.weverse.io/${SEG[lang]}/mypage/orders`;
const detailUrl = (lang = 'jp', id = ID) => `https://shop.weverse.io/${SEG[lang]}/order/details/${id}`;
const URL_LIST = listUrl();
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = { jp: fixture('weverse-list-jp.html'), en: fixture('weverse-list-en.html'), tw: fixture('weverse-list-tw.html') };
const DIALOG = { jp: fixture('weverse-tracking-jp.html'), en: fixture('weverse-tracking-en.html'), tw: fixture('weverse-tracking-tw.html') };
const DETAIL = { jp: fixture('weverse-detail-jp.html'), en: fixture('weverse-detail-en.html'), tw: fixture('weverse-detail-tw.html') };
const TRACK = /^(?:配送状況照会|Track Order|查詢貨態)$/;
const IMAGE = 'https://cdn-contents.weverseshop.io/public/shop/f391482c724fd74974eb025f5c5c3e3e.png?w=160&q=95';

/* 會跳彈窗的列表。dialogs[i]：按頁面上第 i 顆「配送状況照会」時加到 body 最後的 HTML（沒給就什麼都不跳）。
 * details[代表注文番号]：那一筆的注文詳細。pressed 記下按了哪幾顆（每個 iframe 各自按，所以順序不一定） */
function shop(listHtml, dialogs, { lang = 'jp', details = { [ID]: DETAIL[lang] } } = {}) {
  const pressed = [];
  const pages = (url) => {
    const id = Object.keys(details).find((k) => url === detailUrl(lang, k));
    if (id) return page(details[id]);
    return url !== listUrl(lang) ? null : listPage();
  };
  const listPage = () => ({
    html: page(listHtml),
    setup(doc) {
      [...doc.querySelectorAll('button')].filter((b) => TRACK.test(b.textContent.trim())).forEach((b, i) =>
        b.addEventListener('click', () => {
          pressed.push(i);
          if (dialogs[i]) doc.body.insertAdjacentHTML('beforeend', dialogs[i]);
        }));
    },
  });
  return { pages, pressed };
}

// 複製實際那一組，換代表注文番号與注文日時（顯示的文字與 datetime 一起換）
const group = (html, id, ymd) => html.replaceAll(ID, id)
  .replace('2026/11/03 10:41', `${ymd.replace(/-/g, '/')} 10:41`).replace('2026-11-03T11:41:06', `${ymd}T11:41:06`);
const iso = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const edit = (html, change) => {
  const doc = new JSDOM(page(html)).window.document;
  change(doc);
  return doc.body.innerHTML;
};
const row = (o) => [o.orderId, o.orderedAt, o.total, o.carrier, o.trackingId];

module.exports = async function run() {
  const c = new Check('Weverse Shop（實際 HTML）');

  /* 1. 日文：在 iframe 裡按那顆按鈕，從彈窗讀伝票番号 / 配送業者；商品來自列表 */
  {
    const mock = shop(LIST.jp, [DIALOG.jp]);
    const { scrape, asked, progress } = setup(page(LIST.jp), URL_LIST, { pages: mock.pages });
    const res = await scrape();
    c.eq('站台', [res.ok, res.site], [true, 'weverse']);
    // 要讀兩頁（彈窗＋詳細頁），但只有一筆訂單：進度是「0 / 1 → 1 / 1」，不是「1 / 2」
    c.eq('進度以訂單計', progress.filter((m) => m.phase === 'lookup').map((m) => `${m.done}/${m.total}`), ['0/1', '1/1']);
    c.eq('按鈕一個 iframe、詳細頁一個 iframe；按了那一顆', [asked.map((a) => a.url), mock.pressed], [[URL_LIST, detailUrl()], [0]]);
    c.eq('代表注文番号 / 注文日 / 合計（詳細頁）/ 配送業者 / 伝票番号', res.orders?.map(row), [[ID, '2026-11-03', 2875, 'CMA', 'CA1202435081']]);
    c.eq('商品', res.orders?.[0]?.items, [{ title: 'Lucky Draw (Random)', quantity: 1, imageUrl: IMAGE }]);
    c.eq('沒有「讀不到」', res.missingTracking, 0);
  }

  /* 2. 英文、繁中：同一筆訂單，標籤與按鈕文字不同，結果一樣（英文的注文日是「Nov 3, 2026 10:41」，
   *    合計的標籤是 Grand Total / 付款總金額；詳細頁網址的第一段跟著列表頁換成 en / zh-tw） */
  for (const lang of ['en', 'tw']) {
    const mock = shop(LIST[lang], [DIALOG[lang]], { lang });
    const { scrape, asked } = setup(page(LIST[lang]), listUrl(lang), { pages: mock.pages });
    const res = await scrape();
    c.eq(`${lang}：詳細頁網址`, asked.map((a) => a.url), [listUrl(lang), detailUrl(lang)]);
    c.eq(`${lang}：結果跟日文一樣`, res.orders?.map(row), [[ID, '2026-11-03', 2875, 'CMA', 'CA1202435081']]);
    c.eq(`${lang}：商品與數量`, res.orders?.[0]?.items.map((i) => [i.title, i.quantity]), [['Lucky Draw (Random)', 1]]);
  }

  /* 3. iframe 打不開（被擋下）→ 空的包裹留著，算進「讀不到配送資料」 */
  {
    const res = await setup(page(LIST.jp), URL_LIST, { pages: () => null }).scrape();
    c.eq('報 1 個讀不到', [res.orders, res.missingTracking], [[], 1]);
  }

  /* 3b. 詳細頁讀不到 → 合計留空，包裹照列 */
  {
    const mock = shop(LIST.jp, [DIALOG.jp], { details: {} });
    const res = await setup(page(LIST.jp), URL_LIST, { pages: mock.pages }).scrape();
    c.eq('合計留空、包裹照列、不算讀不到', [res.orders?.map(row), res.missingTracking], [[[ID, '2026-11-03', null, 'CMA', 'CA1202435081']], 0]);
  }

  /* 3c. 合計認的是標籤，不是位置（造的：把「合計金額」那一列搬到商品金額 / 稅 / 送料後面） */
  {
    const moved = edit(DETAIL.jp, (doc) => {
      const total = [...doc.querySelectorAll('dl')].find((dl) => dl.querySelector('dt')?.textContent.trim() === '合計金額');
      total.parentElement.append(total);
    });
    const mock = shop(LIST.jp, [DIALOG.jp], { details: { [ID]: moved } });
    const res = await setup(page(LIST.jp), URL_LIST, { pages: mock.pages }).scrape();
    c.eq('還是 2,875', res.orders?.map((o) => o.total), [2875]);
  }

  /* 4. 還沒出貨（照使用者第一次給的頁面：狀態「お支払い済み」，沒有「配送状況照会」按鈕）→ 不開 iframe、不列、不算讀不到 */
  {
    const paid = edit(LIST.jp, (doc) => {
      [...doc.querySelectorAll('button')].forEach((b) => b.parentElement.remove());
      [...doc.querySelectorAll('div')].find((d) => d.textContent.trim() === '配送準備中' && !d.children.length).textContent = 'お支払い済み';
    });
    c.eq('造的頁面確實沒有按鈕了', paid.includes('配送状況照会'), false);
    const { scrape, asked } = setup(page(paid), URL_LIST, { pages: shop(paid, []).pages });
    const res = await scrape();
    c.eq('不開 iframe（連詳細頁都不讀）', asked, []);
    c.eq('不列、不算讀不到', [res.orders, res.missingTracking], [[], 0]);
  }

  /* 5. 彈窗裡沒有伝票番号（造的：拿掉那一列）→ 不列、不算讀不到 */
  {
    const noNumber = edit(DIALOG.jp, (doc) => [...doc.querySelectorAll('tr')].find((tr) => tr.textContent.includes('伝票番号')).remove());
    const res = await setup(page(LIST.jp), URL_LIST, { pages: shop(LIST.jp, [noNumber]).pages }).scrape();
    c.eq('不列、不算讀不到', [res.orders, res.missingTracking], [[], 0]);
  }

  /* 6. 彈窗沒有表格（造的：只有「配送がまもなく始まります。」）→ 不能當成沒有伝票番号，算讀不到（要等到逾時，約 15 秒） */
  {
    const bare = edit(DIALOG.jp, (doc) => doc.querySelector('table').remove());
    const res = await setup(page(LIST.jp), URL_LIST, { pages: shop(LIST.jp, [bare]).pages }).scrape();
    c.eq('報 1 個讀不到', [res.orders, res.missingTracking], [[], 1]);
  }

  /* 7. 一組裡兩個賣家（造的：複製那一段，換商品；第二顆按鈕跳出另一個伝票番号）→ 兩個包裹，商品各是各的 */
  {
    const two = edit(LIST.jp, (doc) => {
      const section = doc.querySelector('section');
      const other = section.cloneNode(true);
      other.querySelector('dl > p').textContent = 'SEVENTEEN Album';
      other.querySelector('dl > span').textContent = 'Ver. A / 2 個';
      section.after(other);
    });
    const dialog2 = DIALOG.jp.replace('CA1202435081', 'CA9999999999').replace('<td>CMA</td>', '<td>EMS</td>');
    const mock = shop(two, [DIALOG.jp, dialog2]);
    const shop2 = setup(page(two), URL_LIST, { pages: mock.pages });
    const res = await shop2.scrape();
    c.eq('兩顆按鈕都按了（各一個 iframe）', [...mock.pressed].sort(), [0, 1]);
    c.eq('三頁（兩個彈窗＋詳細頁）還是一筆訂單', shop2.progress.filter((m) => m.phase === 'lookup').map((m) => `${m.done}/${m.total}`), ['0/1', '1/1']);
    c.eq('兩個包裹，同一個代表注文番号、同一個合計', res.orders?.map((o) => [o.orderId, o.total, o.carrier, o.trackingId]),
      [[ID, 2875, 'CMA', 'CA1202435081'], [ID, 2875, 'EMS', 'CA9999999999']]);
    c.eq('商品各是各的；選項跟品名不同時接在後面，數量取「/」後面', res.orders?.map((o) => o.items.map((i) => [i.title, i.quantity])),
      [[['Lucky Draw (Random)', 1]], [['SEVENTEEN Album（Ver. A）', 2]]]);
  }

  /* 7b. 組裡還有別的按鈕（造的：「配送状況照会」前面加一顆「キャンセル申込」—— 實際看過的字，在詳細頁上）
   *     → 只為「配送状況照会」開 iframe，而且 iframe 裡按的是同一顆（位置算的是組裡全部的 <button>） */
  {
    const extra = edit(LIST.jp, (doc) => doc.querySelector('section').insertAdjacentHTML('afterbegin', '<div><button type="button">キャンセル申込</button></div>'));
    const mock = shop(extra, [DIALOG.jp]);
    const { scrape, asked } = setup(page(extra), URL_LIST, { pages: mock.pages });
    const res = await scrape();
    c.eq('按鈕只開一個 iframe（另一個是詳細頁），按的是配送状況照会', [asked.map((a) => a.url), mock.pressed], [[URL_LIST, detailUrl()], [0]]);
    c.eq('讀到那個包裹', [res.orders?.map((o) => o.trackingId), res.missingTracking], [['CA1202435081'], 0]);
  }

  /* 8. 七天：只按七天內那一組的按鈕（造的：複製實際那一組，換代表注文番号與日期） */
  {
    const OLD = '124000000000000001';
    const html = group(LIST.jp, ID, iso(1)) + group(LIST.jp, OLD, iso(30));
    const mock = shop(html, [DIALOG.jp, DIALOG.jp], { details: { [ID]: DETAIL.jp, [OLD]: DETAIL.jp } });
    const { scrape, asked } = setup(page(html), URL_LIST, { pages: mock.pages });
    const res = await scrape({ recentDays: 7 });
    c.eq('只按第一組的按鈕、只讀它的詳細頁', [mock.pressed, asked.map((a) => a.url)], [[0], [URL_LIST, detailUrl()]]);
    c.eq('只列七天內那一組', res.orders?.map((o) => [o.orderId, o.orderedAt]), [[ID, iso(1)]]);
  }

  /* 9. PING 回報站台；其他網域、彈窗本身都不該認得 */
  {
    const pong = await setup(page(LIST.jp), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'weverse', 'Weverse Shop']);
    c.eq('其他網域不認', (await setup(page(LIST.jp), 'https://example.com/ja/mypage/orders').ping()).onOrderPage, false);
    c.eq('只有彈窗的頁面不是訂單列表', (await setup(page(DIALOG.jp), URL_LIST).ping()).onOrderPage, false);
  }

  return c.report();
};
