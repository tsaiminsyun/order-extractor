/* ZOZOTOWN：以使用者提供的實際 HTML 為測試資料
 * zozo-list-jp.html    注文履歴（.listBlock 那一段）。實際有 19 個包裹，這裡只留 4 個：
 *                      配達中（421113907）、一筆訂單兩件商品（420558745，配達完了）、
 *                      まとめて発送（419503186＋419138917，配達完了）、沒有進度列的舊格式（409887913，配達完了）。
 *                      頁尾的分頁區塊照留
 * zozo-detail-jp.html  421113907 的注文詳細：伝票番号 / 支払い金額。姓名 / 住址 / 電話已置換
 *
 * 列表頁上「一個區塊是一個包裹」，好幾筆訂單可以合併成一個包裹。
 * 列表頁的實際網址沒有拿到，URL_LIST 是照分頁連結（./default.html?pno=2）推的路徑 —— 判斷只看網域和版面。
 * 造出來的情境標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM, loadReaders } = require('./harness.cjs');

const URL_LIST = 'https://zozo.jp/_member/orderhistory/default.html';
const DETAIL = (oid) => `https://zozo.jp/_member/orderhistory/detail.html?oid=${oid}&isold=0&ohtype=1&ohterm=2&ohid=`;
const PAGE2 = 'https://zozo.jp/_member/orderhistory/default.html?pno=2&ohtype=1&ohterm=2&ohid=';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;
const LIST = fixture('zozo-list-jp.html');
const DETAIL_HTML = fixture('zozo-detail-jp.html');

const LIST_DOC = new JSDOM(page(LIST)).window.document;
const PACKS = [...LIST_DOC.querySelectorAll('.orderList')].map((el) => el.outerHTML);
const PAGER = LIST_DOC.querySelector('.pager_bottom').outerHTML;
const pack = (orderId) => PACKS.find((p) => p.includes(`注文番号</span>：${orderId}`));
const list = (packs, extra = '') => page(`<div class="listBlock clearfix">${packs.join('')}${extra}</div>`);
// 配達完了的包裹改成配達中（造出來的）：目前狀態的標籤與進度列的步數
const inTransit = (html) => html
  .replace(/(<p class="orderDetailHeader-h">)配達完了/, '$1配達中')
  .replace('data-step="5" data-max-step="5"', 'data-step="4" data-max-step="5"');
// 詳細頁：421113907 那一頁；其他訂單用同一頁換掉注文番号當作它們的詳細頁（造出來的）
const detailFor = (oid) => DETAIL_HTML.replace(/421113907/g, oid);
const serve = (ids) => (url) => {
  const oid = new URL(url).searchParams.get('oid');
  return ids.includes(oid) ? page(detailFor(oid)) : null;
};
const readDetail = async (html) => {
  loadReaders();
  return globalThis.OrderScraper.readers.zozoDetail(new JSDOM(page(html)).window.document);
};

module.exports = async function run() {
  const c = new Check('ZOZOTOWN（實際 HTML）');

  /* 1. 實際頁面：只有配達中的那個包裹要讀詳細頁 */
  {
    c.eq('4 個包裹', PACKS.length, 4);
    const { scrape, asked } = setup(list(PACKS), URL_LIST, { pages: serve(['421113907']) });
    const res = await scrape();
    c.eq('站台', res.site, 'zozo');
    c.eq('只讀配達中那筆的詳細頁', asked.map((a) => a.url), [DETAIL('421113907')]);
    const [o] = res.orders;
    c.eq('列出那筆', res.orders.map((x) => [x.orderId, x.orderedAt]), [['421113907', '2026-10-17']]);
    c.eq('伝票番号（不含後面的「詳細」）', o?.trackingId, '293252106335');
    c.eq('配送業者：頁面上沒有，留空', o?.carrier, '');
    c.eq('合計（支払い金額，不是商品合計 8,910）', o?.total, 9240);
    c.eq('商品：品牌 品名（顏色 / 尺寸）', o?.items, [{
      title: 'hellam コーデュロイカラーストライプデニムジャケット（インディゴブルー / FREE）',
      quantity: 1,
      imageUrl: 'https://c.imgz.jp/491/110312491/110312491b_33_d_125.jpg',
    }]);
  }

  /* 2. 已送達的判斷 */
  {
    c.eq('實際頁面：舊格式那個包裹沒有進度列，只有狀態標籤', [/delivery-info__status/.test(pack('409887913')), /orderDetailHeader-h">\s*配達完了/.test(pack('409887913'))], [false, true]);
    const old = await setup(list([pack('409887913')]), URL_LIST, { pages: () => null }).scrape();
    c.eq('沒有進度列也認得配達完了', [old.orders, old.missingTracking], [[], 0]);

    // 進度列走到最後一步、標籤卻不是配達完了（造出來的）→ 還是算送達
    const stepOnly = pack('420558745').replace(/(<p class="orderDetailHeader-h">)配達完了/, '$1（不明）');
    const res = setup(list([stepOnly]), URL_LIST, { pages: () => null });
    await res.scrape();
    c.eq('進度列 5/5 → 送達，不讀詳細頁', res.asked, []);
  }

  /* 3. まとめて発送（造出來的配送中）：兩筆訂單各一列、伝票番号相同、商品各放自己的 */
  {
    const both = inTransit(pack('419503186'));
    c.eq('實際的包裹裡確實是兩筆訂單', [both.includes('419503186'), both.includes('419138917'), /まとめて発送/.test(both)], [true, true, true]);
    const { scrape, asked } = setup(list([both]), URL_LIST, { pages: serve(['419503186', '419138917']) });
    const res = await scrape();
    c.eq('兩筆訂單都讀詳細頁', asked.map((a) => new URL(a.url).searchParams.get('oid')), ['419503186', '419138917']);
    c.eq('兩列、伝票番号相同', res.orders.map((o) => [o.orderId, o.trackingId]), [['419503186', '293252106335'], ['419138917', '293252106335']]);
    c.eq('商品各放自己的', res.orders.map((o) => o.items.map((i) => i.title)), [
      ['merry jenny もこもこニャニィニュニェニョントート（ピンク / FREE）'],
      ['kutir 【3サイズ展開】オーバーダイリボンフレアデニムパンツ（ブルー / LARGE）'],
    ]);
  }

  /* 4. 一筆訂單兩件商品（造出來的配送中）：第二列沒有 orderTime，還是那一筆 */
  {
    const res = await setup(list([inTransit(pack('420558745'))]), URL_LIST, { pages: serve(['420558745']) }).scrape();
    c.eq('兩件商品都在那筆訂單的包裹裡', res.orders.map((o) => [o.orderId, o.items.map((i) => i.title)]), [['420558745', [
      'GRAIN 【GRAIN/グレイン】二つ折りバイカラーウォレット（ブラウン / FREE）',
      'kutir アソートドロストリボンシャツ（ダークグレー / FREE）',
    ]]]);
  }

  /* 4b. 同一筆訂單分成兩個包裹，一個配達中、一個已送達（造出來的：把舊格式那個包裹的注文番号改成 421113907）
   *     → 只放配達中那個包裹裡的商品 */
  {
    const delivered = pack('409887913').replace(/409887913/g, '421113907');
    const res = await setup(list([pack('421113907'), delivered]), URL_LIST, { pages: serve(['421113907']) }).scrape();
    c.eq('已送達那個包裹的商品不放進來', res.orders.map((o) => o.items.map((i) => i.title)),
      [['hellam コーデュロイカラーストライプデニムジャケット（インディゴブルー / FREE）']]);
  }

  /* 4c. 数量 2 以上（實際頁面上都是 1，改成 3） */
  {
    const three = pack('421113907').replace('税込 / 数量：1', '税込 / 数量：3');
    const res = await setup(list([three]), URL_LIST, { pages: serve(['421113907']) }).scrape();
    c.eq('数量取「数量：N」', res.orders[0]?.items.map((i) => i.quantity), [3]);
  }

  /* 5. 讀不到詳細頁 → 報「讀不到配送資料」；讀到了但還沒有伝票番号（造出來的：拿掉那一列）→ 不列也不報 */
  {
    const failed = await setup(list([pack('421113907')]), URL_LIST, { pages: () => null }).scrape();
    c.eq('讀不到 → 報 1 個', [failed.orders, failed.missingTracking], [[], 1]);
    const noSlip = DETAIL_HTML.replace(/<tr>\s*<th>伝票番号<\/th>[\s\S]*?<\/tr>/, '');
    c.eq('造出來的詳細頁沒有伝票番号', noSlip.includes('伝票番号'), false);
    const waiting = await setup(list([pack('421113907')]), URL_LIST, { pages: () => page(noSlip) }).scrape();
    c.eq('還沒有伝票番号 → 不列、不報', [waiting.orders, waiting.missingTracking], [[], 0]);
  }

  /* 6. 詳細頁讀取器 */
  {
    const info = await readDetail(DETAIL_HTML);
    c.eq('伝票番号', info.trackingIds, ['293252106335']);
    c.eq('支払い金額', info.total, 9240);
    // 一筆訂單兩個伝票番号（造出來的：<br> 分隔）
    const two = await readDetail(DETAIL_HTML.replace('293252106335<a', '293252106335<br />1234-5678-9012<a'));
    c.eq('<br> 分隔的兩個號碼（去掉連字號）', two.trackingIds, ['293252106335', '123456789012']);
    c.eq('讀取器認得登入頁', await readDetail('<form><input type="password" name="password"></form>'), { signIn: true });
  }

  /* 7. 注文日：「2026.10.17」 */
  {
    setup(page(LIST), URL_LIST);
    const { util, sites } = globalThis.OrderScraper;
    c.eq('點分隔的日期', [util.parseDate('2026.10.17'), util.parseDate('2026.10.17 21:06:59')], ['2026-10-17', '2026-10-17']);
    c.eq('其他寫法不受影響', [util.parseDate('2026/09/18(金)'), util.parseDate('2026年09月 10日'), util.parseDate('2026-10-05T14:53:07Z')], ['2026-09-18', '2026-09-10', '2026-10-05']);
    const orders = sites.find((s) => s.name === 'zozo').findOrders(LIST_DOC, URL_LIST);
    c.eq('5 筆訂單的注文日', orders.map((o) => [o.orderId, o.orderedAt]), [
      ['421113907', '2026-10-17'], ['420558745', '2026-10-16'], ['419503186', '2026-10-14'], ['419138917', '2026-10-13'], ['409887913', '2026-09-28'],
    ]);
  }

  /* 8. 翻頁：實際頁面的分頁區塊（下一頁只有圖示沒有文字）。日期改成相對於今天、第 2 頁是造出來的 */
  {
    setup(page(LIST), URL_LIST);
    const { sites, util } = globalThis.OrderScraper;
    const doc = new JSDOM(page(LIST), { url: URL_LIST }).window.document;
    c.eq('下一頁（實際的分頁區塊）', sites.find((s) => s.name === 'zozo').nextPage(doc, URL_LIST), { url: PAGE2, via: 'fetch' });
    c.eq('通用規則認不得（連結沒有文字）', util.nextPageLink(doc, URL_LIST), null);

    const ymd = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    };
    const redate = (html, daysAgo) => html.replace(/(注文日<\/span>：)\d{4}\.\d{2}\.\d{2}/g, `$1${ymd(daysAgo)}`);
    c.eq('改日期的規則對得上實際 HTML', redate(pack('421113907'), 1) !== pack('421113907'), true);
    const pages = (url) => (url === PAGE2 ? list([redate(inTransit(pack('420558745')), 3)]) : serve(['421113907', '420558745'])(url));

    const stop = setup(list([redate(pack('421113907'), 1), redate(pack('409887913'), 30)], PAGER), URL_LIST, { pages });
    const stopped = await stop.scrape({ recentDays: 7 });
    c.eq('看到三十天前的訂單就不翻頁', stopped.pages, 1);
    c.eq('只讀七天內那筆的詳細頁', stop.asked.map((a) => a.url), [DETAIL('421113907')]);

    const more = setup(list([redate(pack('421113907'), 1)], PAGER), URL_LIST, { pages });
    const both = await more.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 用 fetch 讀第 2 頁', [both.pages, both.orders.map((o) => o.orderId)], [2, ['421113907', '420558745']]);
  }

  /* 9. PING 回報站台；其他網域、詳細頁本身都不該認得 */
  {
    const pong = await setup(page(LIST), URL_LIST).ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'zozo', 'ZOZOTOWN']);
    c.eq('其他網域不認', (await setup(page(LIST), 'https://example.com/_member/orderhistory/default.html').ping()).onOrderPage, false);
    c.eq('詳細頁不是訂單列表', (await setup(page(DETAIL_HTML), DETAIL('421113907')).ping()).onOrderPage, false);
  }

  return c.report();
};
