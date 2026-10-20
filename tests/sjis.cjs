/* 測試用：把字串編成 Shift_JIS 的位元組，模擬舊式日本網站的回應。
 * Node 的 TextEncoder 只會 UTF-8，但 TextDecoder 認得 shift_jis，
 * 所以把所有雙位元組碼解一遍，反查出「字 → 位元組」的對照表。
 * 編不出來的字（例如 ¥ 在 Shift_JIS 裡就是 0x5C 反斜線）變成 '?' */
let table = null;

function buildTable() {
  const dec = new TextDecoder('shift_jis');
  const map = new Map();
  for (let lead = 0x81; lead <= 0xfc; lead += 1) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [lead, trail]);
    }
  }
  for (let b = 0xa1; b <= 0xdf; b += 1) map.set(dec.decode(new Uint8Array([b])), [b]); // 半形片假名
  return map;
}

function shiftJis(str) {
  table ??= buildTable();
  return Uint8Array.from([...str].flatMap((ch) => {
    const code = ch.codePointAt(0);
    if (code < 0x80) return [code];
    return table.get(ch) || [0x3f];
  }));
}

module.exports = { shiftJis };
