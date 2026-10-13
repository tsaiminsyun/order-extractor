/* タワーレコード オンライン（tower.jp）：以使用者提供的實際 HTML 為測試資料
 * tower-list-jp.html  注文履歴：一筆訂單、一次配送、1 件商品（姓名 / 住址 / 電話 / 卡號已置換）
 *
 * 這個站台的列表頁就有全部欄位，所以正常情況下**完全不會另外載入頁面**（第 1 項會檢查）。
 * 分批出貨與多筆訂單的情境實際頁面上沒有，是拿同一份 HTML 複製後改注文番号 /
 * 配送序號 / 伝票番号造出來的，標在各該項目上。
 */
const fs = require('fs');
const path = require('path');
const { setup, Check } = require('./harness.cjs');

const URL_LIST = 'https://tower.jp/ec/Customer/Order/List';
const BOX = fs.readFileSync(path.join(__dirname, 'fixtures', 'tower-list-jp.html'), 'utf8');
const page = (body) => `<html><body>${body}</body></html>`;

const WANT = {
  orderId: '26J08212058264',
  total: 1870,
  title: '祈り、終われば[CD+Blu-ray Disc]<期間生産限定盤>',
  image: 'https://cdn.tower.jp/za/l/9W/zaP5_G4882799W.JPG',
  carrier: '日本郵便',
  trackingId: '320443645421',
};

// 沒給 pages 時，harness 的 fetch / iframe 一被用到就會丟錯 —— 正好拿來確認「不讀別的頁」
const read = async (body) => (await setup(page(body), URL_LIST).scrape()).orders;

module.exports = async function run() {
  const c = new Check('タワーレコード（實際 HTML）');

  /* 1. 實際頁面：所有欄位都在列表頁上，不必另外載入任何頁面 */
  {
    const { scrape, asked } = setup(page(BOX), URL_LIST);
    const { orders, site } = await scrape();
    c.eq('站台', site, 'tower');
    c.eq('訂單數', orders.length, 1);
    c.eq('注文番号（不含後面的「配送1」）', orders[0]?.orderId, WANT.orderId);
    c.eq('合計（注文合計）', orders[0]?.total, WANT.total);
    c.eq('品名', orders[0]?.items.map((i) => i.title), [WANT.title]);
    c.eq('画像', orders[0]?.items[0]?.imageUrl, WANT.image);
    c.eq('数量', orders[0]?.items[0]?.quantity, 1);
    c.eq('配送業者 / 伝票番号', [orders[0]?.carrier, orders[0]?.trackingId], [WANT.carrier, WANT.trackingId]);
    c.eq('完全不另外載入頁面', asked.length, 0);
  }

  /* 2. 配送業者由伝票番号的查詢網址判斷 ——
   *    頁面上的「配送業者」欄位是下單時的指定，實際頁面上寫的是「指定なし」 */
  {
    c.eq('頁面上的配送業者欄位是「指定なし」', BOX.includes('指定なし'), true);

    const yamato = BOX.replace(/http:\/\/tracking\.post\.japanpost\.jp[^"]*/,
      'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?no01=320443645421');
    c.eq('ヤマト運輸', (await read(yamato))[0]?.carrier, 'ヤマト運輸');

    const sagawa = BOX.replace(/http:\/\/tracking\.post\.japanpost\.jp[^"]*/,
      'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=320443645421');
    c.eq('佐川急便', (await read(sagawa))[0]?.carrier, '佐川急便');

    // 認不得的業者：業者名留空，但伝票番号仍要保留（抓不到好過抓錯）
    const unknown = BOX.replace(/http:\/\/tracking\.post\.japanpost\.jp[^"]*/, 'https://example.com/t/320443645421');
    const orders = await read(unknown);
    c.eq('認不得的業者 → 留空但保留伝票番号', [orders[0]?.carrier, orders[0]?.trackingId], ['', WANT.trackingId]);
  }

  /* 3. 還沒出貨（沒有配送問い合わせ番号）→ 不擷取 */
  {
    const notShipped = BOX.replace(/<p>配送問い合わせ番号：<a[^]*?<\/a><\/p>/, '<p>配送問い合わせ番号：</p>');
    c.eq('確實把伝票番号拿掉了', notShipped.includes(WANT.trackingId), false);
    c.eq('沒有伝票番号 → 不擷取', (await read(notShipped)).length, 0);
  }

  /* 4. 同一筆訂單分批出貨（配送1 / 配送2）：併成一筆訂單的兩個包裹。
   *    main.js 會依注文番号去重，分開回傳會被吃掉一筆 —— 這一項就是在釘這件事。
   *    （實際頁面只有一次配送，這份是複製後改配送序號與伝票番号造出來的） */
  {
    const second = BOX.replace('配送1', '配送2').replace(new RegExp(WANT.trackingId, 'g'), '320443645422');
    const orders = await read(BOX + second);
    c.eq('同一注文番号的兩次配送各一筆', orders.map((o) => o.orderId), [WANT.orderId, WANT.orderId]);
    c.eq('兩個伝票番号都在', orders.map((o) => o.trackingId), [WANT.trackingId, '320443645422']);
    c.eq('合計重複出現（一筆訂單的合計）', orders.map((o) => o.total), [WANT.total, WANT.total]);
    c.eq('各自帶著自己的商品', orders.map((o) => o.items.length), [1, 1]);
  }

  /* 5. 兩筆不同的訂單（同樣是複製後改注文番号與伝票番号） */
  {
    const other = BOX.replace(new RegExp(WANT.orderId, 'g'), '26J08212058265')
      .replace(new RegExp(WANT.trackingId, 'g'), '320443645423');
    const orders = await read(BOX + other);
    c.eq('兩筆訂單', orders.map((o) => [o.orderId, o.trackingId]),
      [[WANT.orderId, WANT.trackingId], ['26J08212058265', '320443645423']]);
  }

  /* 6. 数量：.ship-num 沒有時退回商品明細的「￥1,650　数量：1」 */
  {
    const threeInShipNum = BOX.replace('<div class="ship-num">数量：<span>1</span></div>',
      '<div class="ship-num">数量：<span>3</span></div>');
    c.eq('.ship-num 的数量', (await read(threeInShipNum))[0]?.items[0]?.quantity, 3);

    const noShipNum = BOX.replace(/<div class="ship-num">[^]*?<\/div>/, '')
      .replace('￥1,650　数量：1', '￥1,650　数量：2');
    c.eq('退回商品明細的数量', (await read(noShipNum))[0]?.items[0]?.quantity, 2);

    const noQty = BOX.replace(/<div class="ship-num">[^]*?<\/div>/, '').replace('　数量：1', '');
    c.eq('都沒有数量 → 1 件', (await read(noQty))[0]?.items[0]?.quantity, 1);
  }

  /* 7. PING 回報站台；不是會員頁就不該認得 */
  {
    const { ping } = setup(page(BOX), URL_LIST);
    const pong = await ping();
    c.eq('PING 站台', [pong.onOrderPage, pong.site, pong.label], [true, 'tower', 'タワーレコード']);

    const item = setup(page(BOX), 'https://tower.jp/item/8057086');
    c.eq('商品頁不是訂單頁', (await item.ping()).onOrderPage, false);

    const empty = setup(page('<div>マイページ</div>'), URL_LIST);
    c.eq('會員頁但沒有訂單區塊 → 不是訂單頁', (await empty.ping()).onOrderPage, false);
  }

  return c.report();
};
