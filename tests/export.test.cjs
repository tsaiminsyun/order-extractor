/* 匯出格式：一個包裹一筆 */
const path = require('path');
const { pathToFileURL } = require('url');
const { Check } = require('./harness.cjs');

module.exports = async function run() {
  const c = new Check('匯出格式');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'export.js')).href);
  const { ordersToJson, exportOrders } = mod;

  // 同一筆訂單、兩個伝票番号 → 兩筆
  const orders = [
    { orderId: '297942-20260918-0695404827', orderedAt: '2026-09-18', total: 10660, currency: 'JPY', carrier: 'ヤマト運輸', trackingId: '391175086374',
      items: [{ title: '醤油, 1L', quantity: 1, imageUrl: 'https://x/a.jpg' }] },
    { orderId: '297942-20260918-0695404827', orderedAt: '2026-09-18', total: 10660, currency: 'JPY', carrier: 'ヤマト運輸', trackingId: '391175087995',
      items: [{ title: '醤油, 1L', quantity: 4, imageUrl: 'https://x/a.jpg' }, { title: '味噌', quantity: 1, imageUrl: null }] },
  ];

  const json = exportOrders(orders);
  c.eq('訂單層欄位', Object.keys(json[0]), ['orderId', 'orderedAt', 'total', 'currency', 'carrier', 'trackingId', 'items']);
  c.eq('注文日', json[0].orderedAt, '2026-09-18');
  c.eq('商品層欄位', Object.keys(json[0].items[0]), ['title', 'quantity', 'imageUrl']);
  c.eq('兩個伝票番号各一筆', json.map((o) => o.trackingId), ['391175086374', '391175087995']);
  c.eq('沒有圖片時給空字串', json[1].items[1].imageUrl, '');
  c.eq('数量', json[1].items.map((i) => i.quantity), [4, 1]);

  const text = ordersToJson(orders);
  c.eq('JSON 可序列化', typeof text, 'string');
  c.eq('JSON 內容與 exportOrders 相同', JSON.parse(text), json);

  // 舊版存下來的結果沒有数量欄位
  const legacy = exportOrders([{ orderId: 'X', total: 1, currency: 'JPY', carrier: 'A', trackingId: 'B',
    items: [{ title: '商品', imageUrl: 'https://x/c.jpg' }] }]);
  c.eq('沒有数量時當 1 件', legacy[0].items[0].quantity, 1);

  // CSV 已移除，不應再匯出
  c.eq('不再提供 CSV', [mod.ordersToCsv, mod.CSV_KEYS].map((v) => v === undefined), [true, true]);

  return c.report();
};
