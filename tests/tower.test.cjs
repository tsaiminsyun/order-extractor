/* タワーレコード オンライン（tower.jp）：以使用者提供的實際 HTML 為測試資料
 * tower-list-jp.html  注文履歴：兩筆訂單 —— 一筆還在配送中、一筆已送達
 *                     （出荷表示後面多了「（受取済）」）。姓名 / 住址 / 電話 / 卡號已置換
 *
 * 這個站台的列表頁就有全部欄位，所以正常情況下**完全不會另外載入頁面**（第 1 項會檢查）。
 * 分批出貨、多筆訂單、其他配送業者這幾種情境實際頁面上沒有，是拿配送中那一筆複製後
 * 改注文番号 / 配送序號 / 伝票番号造出來的，標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check, JSDOM } = require('./harness.cjs');

const URL_LIST = 'https://tower.jp/ec/Customer/Order/List';
const LIST = fs.readFileSync(path.join(__dirname, 'fixtures', 'tower-list-jp.html'), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;

// 兩筆訂單各自的 HTML：第一筆配送中、第二筆已送達
const [LIVE, RECEIVED] = [...new JSDOM(page(LIST)).window.document.querySelectorAll('.deliveryBox')]
  .map((el) => el.outerHTML);

const WANT = {
  orderId: '26J08212058264',
  total: 1870,
  title: '祈り、終われば[CD+Blu-ray Disc]<期間生産限定盤>',
  image: 'https://cdn.tower.jp/za/l/9W/zaP5_G4882799W.JPG',
  carrier: '日本郵便',
  trackingId: '320443645421',
};
const DONE = { orderId: '26H08201239949', trackingId: '320435102072' };

// 沒給 pages 時，harness 的 fetch / iframe 一被用到就會丟錯 —— 正好拿來確認「不讀別的頁」
const read = async (body) => (await setup(page(body), URL_LIST).scrape()).orders;

module.exports = async function run() {
  const c = new Check('タワーレコード（實際 HTML）');

  /* 1. 實際頁面：兩筆訂單只輸出配送中的那筆，所有欄位都在列表頁上 */
  {
    const { scrape, asked } = setup(page(LIST), URL_LIST);
    const { orders, site } = await scrape();
    c.eq('站台', site, 'tower');
    c.eq('頁面上有兩筆訂單', [...new JSDOM(page(LIST)).window.document.querySelectorAll('.deliveryBox')].length, 2);
    c.eq('只輸出配送中的那筆', orders.map((o) => o.orderId), [WANT.orderId]);
    c.eq('合計（注文合計）', orders[0]?.total, WANT.total);
    c.eq('品名', orders[0]?.items.map((i) => i.title), [WANT.title]);
    c.eq('画像', orders[0]?.items[0]?.imageUrl, WANT.image);
    c.eq('数量', orders[0]?.items[0]?.quantity, 1);
    c.eq('配送業者 / 伝票番号', [orders[0]?.carrier, orders[0]?.trackingId], [WANT.carrier, WANT.trackingId]);
    c.eq('注文番号不含後面的「配送1」', orders[0]?.orderId.includes('配送'), false);
    c.eq('完全不另外載入頁面', asked.length, 0);
  }

  /* 2. 已送達那筆是因為「（受取済）」被略過，不是因為缺資料 ——
   *    它該有的欄位一樣不缺，只差出荷表示後面那四個字 */
  {
    c.eq('已送達那筆有伝票番号', RECEIVED.includes(DONE.trackingId), true);
    c.eq('出荷表示有（受取済）', /に出荷しました（受取済）/.test(RECEIVED), true);
    c.eq('配送中那筆沒有受取済', LIVE.includes('受取済'), false);
    c.eq('單獨解析也不擷取', (await read(RECEIVED)).length, 0);

    // 把那四個字拿掉就該擷取得到 —— 證明略過的原因只有它
    const asLive = RECEIVED.replace('（受取済）', '');
    c.eq('拿掉受取済就擷取得到', (await read(asLive)).map((o) => [o.orderId, o.trackingId]),
      [[DONE.orderId, DONE.trackingId]]);
  }

  /* 3. 配送業者由伝票番号的查詢網址判斷 ——
   *    頁面上的「配送業者」欄位是下單時的指定，實際頁面上寫的是「指定なし」 */
  {
    c.eq('頁面上的配送業者欄位是「指定なし」', LIVE.includes('指定なし'), true);

    const withLink = (url) => LIVE.replace(/http:\/\/tracking\.post\.japanpost\.jp[^"]*/, url);
    c.eq('ヤマト運輸',
      (await read(withLink('https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?no01=320443645421')))[0]?.carrier,
      'ヤマト運輸');
    c.eq('佐川急便',
      (await read(withLink('https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=320443645421')))[0]?.carrier,
      '佐川急便');

    // 認不得的業者：業者名留空，但伝票番号仍要保留（抓不到好過抓錯）
    const orders = await read(withLink('https://example.com/t/320443645421'));
    c.eq('認不得的業者 → 留空但保留伝票番号', [orders[0]?.carrier, orders[0]?.trackingId], ['', WANT.trackingId]);
  }

  /* 4. 還沒出貨（沒有配送問い合わせ番号）→ 不擷取 */
  {
    const notShipped = LIVE.replace(/<p>配送問い合わせ番号：<a[^]*?<\/a><\/p>/, '<p>配送問い合わせ番号：</p>');
    c.eq('確實把伝票番号拿掉了', notShipped.includes(WANT.trackingId), false);
    c.eq('沒有伝票番号 → 不擷取', (await read(notShipped)).length, 0);
  }

  /* 5. 同一筆訂單分批出貨（配送1 / 配送2）：併成一筆訂單的兩個包裹。
   *    main.js 會依注文番号去重，分開回傳會被吃掉一筆 —— 這一項就是在釘這件事。
   *    （實際頁面只有一次配送，這份是複製後改配送序號與伝票番号造出來的） */
  {
    const second = LIVE.replace('配送1', '配送2').replace(new RegExp(WANT.trackingId, 'g'), '320443645422');
    const orders = await read(LIVE + second);
    c.eq('同一注文番号的兩次配送各一筆', orders.map((o) => o.orderId), [WANT.orderId, WANT.orderId]);
    c.eq('兩個伝票番号都在', orders.map((o) => o.trackingId), [WANT.trackingId, '320443645422']);
    c.eq('合計重複出現（一筆訂單的合計）', orders.map((o) => o.total), [WANT.total, WANT.total]);
    c.eq('各自帶著自己的商品', orders.map((o) => o.items.length), [1, 1]);

    // 其中一次已送達時，只留還在路上的那次，合計仍讀得到
    const mixed = await read(LIVE.replace('に出荷しました', 'に出荷しました（受取済）') + second);
    c.eq('一次受取済 → 只留另一次', mixed.map((o) => o.trackingId), ['320443645422']);
    c.eq('第一個區塊被濾掉，合計仍讀得到', mixed[0]?.total, WANT.total);
  }

  /* 6. 兩筆不同的訂單（同樣是複製後改注文番号與伝票番号） */
  {
    const other = LIVE.replace(new RegExp(WANT.orderId, 'g'), '26J08212058265')
      .replace(new RegExp(WANT.trackingId, 'g'), '320443645423');
    const orders = await read(LIVE + other);
    c.eq('兩筆訂單', orders.map((o) => [o.orderId, o.trackingId]),
      [[WANT.orderId, WANT.trackingId], ['26J08212058265', '320443645423']]);
  }

  /* 7. 数量：.ship-num 沒有時退回商品明細的「￥1,650　数量：1」 */
  {
    const threeInShipNum = LIVE.replace('<div class="ship-num">数量：<span>1</span></div>',
      '<div class="ship-num">数量：<span>3</span></div>');
    c.eq('.ship-num 的数量', (await read(threeInShipNum))[0]?.items[0]?.quantity, 3);

    const noShipNum = LIVE.replace(/<div class="ship-num">[^]*?<\/div>/, '')
      .replace('￥1,650　数量：1', '￥1,650　数量：2');
    c.eq('退回商品明細的数量', (await read(noShipNum))[0]?.items[0]?.quantity, 2);

    const noQty = LIVE.replace(/<div class="ship-num">[^]*?<\/div>/, '').replace('　数量：1', '');
    c.eq('都沒有数量 → 1 件', (await read(noQty))[0]?.items[0]?.quantity, 1);
  }

  /* 8. 注文日：「注文日：2026/10/08」 */
  {
    c.eq('注文日', (await read(LIST))[0]?.orderedAt, '2026-10-08');
  }

  /* 9. 翻頁停在七天：已送達（受取済）的舊訂單也算數 ——
   *    那筆不擷取，但它的注文日一樣代表「界線過了」，不能因為它被略過就繼續往下翻。
   *    日期改成相對於今天，下一頁的連結與第 2 頁是加上去的（實際頁面上沒有分頁區塊） */
  {
    const ymd = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    };
    const redate = (box, daysAgo) =>
      box.replace(/(<td class="ttl">注文日<\/td><td>：)\d{4}\/\d{2}\/\d{2}/, `$1${ymd(daysAgo)}`);
    const NEXT = '<a href="/ec/Customer/Order/List?page=2">次へ</a>';
    const PAGE2 = redate(LIVE, 2)
      .replace(new RegExp(WANT.orderId, 'g'), '26J00000000002')
      .replace(new RegExp(WANT.trackingId, 'g'), '320443645499');
    const serve = (url) => (url.includes('page=2') ? page(PAGE2) : null);

    // 第 1 頁：七天內配送中的一筆 ＋ 三十天前已送達的一筆
    const boundary = setup(page(redate(LIVE, 1) + redate(RECEIVED, 30) + NEXT), URL_LIST, { pages: serve });
    const stopped = await boundary.scrape({ recentDays: 7 });
    c.eq('已送達的舊訂單也讓翻頁停下來', stopped.pages, 1);
    c.eq('沒有去要第 2 頁', boundary.asked.length, 0);
    c.eq('七天內配送中的那筆照常列出', stopped.orders.map((o) => o.orderId), [WANT.orderId]);

    // 對照：整頁都在七天內 → 會翻到第 2 頁
    const recent = setup(page(redate(LIVE, 1) + NEXT), URL_LIST, { pages: serve });
    const both = await recent.scrape({ recentDays: 7 });
    c.eq('整頁都在七天內 → 翻到第 2 頁', both.pages, 2);
    c.eq('第 2 頁的訂單也列出來', both.orders.map((o) => o.orderId), [WANT.orderId, '26J00000000002']);
  }

  /* 10. PING 回報站台；不是會員頁就不該認得 */
  {
    const { ping } = setup(page(LIST), URL_LIST);
    const pong = await ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'tower', 'タワーレコード']);

    const item = setup(page(LIST), 'https://tower.jp/item/8057086');
    c.eq('商品頁不是訂單頁', (await item.ping()).onOrderPage, false);

    const empty = setup(page('<div>マイページ</div>'), URL_LIST);
    c.eq('會員頁但沒有訂單區塊 → 不是訂單頁', (await empty.ping()).onOrderPage, false);
  }

  return c.report();
};
