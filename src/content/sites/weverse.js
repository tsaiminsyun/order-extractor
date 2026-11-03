/* Weverse Shop（shop.weverse.io）の注文履歴
 *
 * React（styled-components / MUI）：class 是雜湊（sc-a86c4f1c-7 dXVVlP），改版就變，
 * 所以只靠不會變的東西：每筆訂單前面那顆 <input type="radio" id="orderSheetGroup_{代表注文番号}">、
 * <time>、按鈕上的文字。
 *
 * 列表頁一個代表注文番号一組，組裡依賣家分段（詳細頁上是「Weverse Global」之類，各有自己的注文番号），
 * 每段有自己的商品與「配送状況照会」按鈕 —— 按鈕要出貨流程開始之後才有（お支払い済み的時候沒有）。
 * **伝票番号不在任何頁面上**，要按那顆按鈕跳出彈窗才看得到（讀取器在 readers.js 的 weverseTracking）：
 * 在隱藏 iframe 裡打開同一頁、按同一顆按鈕。一顆按鈕一個包裹。
 *
 * 合計只在注文詳細頁（合計金額），但列表頁上的商品連結是 href="#none"，詳細頁的網址拿不到，所以合計留空。
 * 狀態只看過お支払い済み / 配送準備中，送達後的寫法還沒看過，只靠七天。
 */
(() => {
  'use strict';
  const { clean, textOf, attr, all, parseDate } = globalThis.OrderScraper.util;

  const GROUP_PREFIX = 'orderSheetGroup_';
  const SEL = {
    group: `input[type="radio"][id^="${GROUP_PREFIX}"]`,  // 一組（代表注文番号）的開頭，它的父元素就是整組
  };
  // 「配送状況照会」按鈕（日 / 英 / 繁中）。按鈕沒有可靠的 class，只能看字
  const TRACK_BUTTON_RE = /^(?:配送状況照会|Track Order|查詢貨態)$/;

  /* 商品：<dl><p>品名</p><span>選項 / 數量</span>…</dl>。
   * 數量那段各語言寫法不同（「1 個」「Total (1) item」「1個」），取最後一個「/」後面的數字；
   * 選項跟品名不同時（例如版本）接在品名後面 */
  function readItem(li) {
    const title = textOf(li.querySelector('dl > p'));
    const spec = textOf(li.querySelector('dl > span'));
    const cut = spec.lastIndexOf('/');
    const option = cut > 0 ? clean(spec.slice(0, cut)) : '';
    return {
      title: option && option !== title ? `${title}（${option}）` : title,
      quantity: (cut >= 0 && Number(/\d+/.exec(spec.slice(cut + 1))?.[0])) || 1,
      imageUrl: attr(li.querySelector('img'), 'src') || null,
    };
  }

  // 按鈕跟它那一段的商品在同一個容器裡：往上找到第一個含有商品的祖先
  function itemsOf(button, group) {
    let section = button.parentElement;
    while (section && section !== group && !section.querySelector('li dl')) section = section.parentElement;
    return all(section || group, 'li').filter((li) => li.querySelector('dl')).map(readItem).filter((i) => i.title);
  }

  function readGroup(input, pageUrl) {
    const group = input.parentElement;
    const orderId = input.id.slice(GROUP_PREFIX.length);
    const time = group.querySelector('time');
    const order = {
      orderId,
      // 顯示的是使用者所在時區的時間（datetime 是 +09:00），先取顯示的
      orderedAt: parseDate(textOf(time)) || parseDate(attr(time, 'datetime')),
      total: null,
      currency: 'JPY',
      shipments: [],
      lookups: [],
    };
    /* 每顆「配送状況照会」先放一個空的包裹：讀到伝票番号就換成實際的，讀到了但沒有就拿掉，
     * 讀不到就留著，算進「讀不到配送資料」。按鈕的位置用「這一組裡第幾個 <button>」記，iframe 裡照著按 */
    const slots = [];
    all(group, 'button').forEach((button, index) => {
      if (!TRACK_BUTTON_RE.test(textOf(button))) return;
      const items = itemsOf(button, group);
      const slot = slots.push({ carrier: '', trackingId: '', items: [] }) - 1;
      order.lookups.push({
        url: pageUrl,
        reader: 'weverseTracking',
        via: 'frame',
        args: { group: orderId, button: index },
        apply: (info) => {
          slots[slot] = info.trackingId ? { carrier: info.carrier, trackingId: info.trackingId, items } : null;
          order.shipments = slots.filter(Boolean);
        },
      });
    });
    order.shipments = [...slots];
    return order;
  }

  globalThis.OrderScraper.sites.push({
    name: 'weverse',
    label: 'Weverse Shop',
    isOrderPage: (loc, doc) => /(^|\.)weverse\.io$/.test(loc.hostname) && !!doc.querySelector(SEL.group),
    isSignInPage: (doc) => !!doc.querySelector('input[type="password"]'),
    // 分頁還沒看過（給的片段只有一組），不翻頁
    findOrders: (doc, pageUrl) => all(doc, SEL.group).map((input) => readGroup(input, pageUrl)),
  });
})();
