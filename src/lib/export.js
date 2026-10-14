/* 匯出工具：JSON 一個包裹一筆（含商品陣列） */

/* 配送業者 / トラッキングID 屬於包裹，品名 / 数量 / 画像 屬於包裹內的商品。
 * 欄位對照：orderId 注文番号／orderedAt 注文日／total 合計／currency 通貨／
 *           carrier 配送業者／trackingId トラッキングID／title 品名／quantity 数量／imageUrl 画像 */
const ORDER_KEYS = ['orderId', 'orderedAt', 'total', 'currency', 'carrier', 'trackingId'];
const ITEM_KEYS = ['title', 'quantity', 'imageUrl'];

// 舊版存下來的結果沒有数量欄位，當成 1 件（Amazon 的列表頁也是沒標示就等於 1 件）
const DEFAULTS = { quantity: 1 };

const pick = (keys, src) => Object.fromEntries(keys.map((key) => [key, src[key] ?? DEFAULTS[key] ?? '']));

export function exportOrders(orders) {
  return orders.map((order) => ({
    ...pick(ORDER_KEYS, order),
    items: order.items.map((item) => pick(ITEM_KEYS, item)),
  }));
}

export const ordersToJson = (orders) => JSON.stringify(exportOrders(orders), null, 2);

export function downloadText(filename, text, mime = 'application/json') {
  // 用建立網址的那個 URL 物件回收，五秒後才執行時不要再去找全域的 URL
  const api = URL;
  const url = api.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => api.revokeObjectURL(url), 5000);
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
