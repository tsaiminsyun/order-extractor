/* 跑完 tests/*.test.cjs，全部通過才回傳 0 */
const fs = require('fs');
const path = require('path');

(async () => {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.cjs')).sort();
  let ok = true;
  for (const f of files) {
    const run = require(path.join(__dirname, f));
    ok = (await run()) && ok;
  }
  console.log(ok ? '\n全部通過' : '\n有測試失敗');
  process.exit(ok ? 0 : 1);
})();
