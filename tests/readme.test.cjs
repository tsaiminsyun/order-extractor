/* README 與程式碼的一致性：連結要有效，寫出來的數字 / 選擇器要跟程式一致。
 * 改了這裡列到的東西，README 也要一起改 —— 測試失敗就是在提醒這件事。 */
const fs = require('fs');
const path = require('path');
const { Check } = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

module.exports = async function run() {
  const c = new Check('README 與程式碼一致');
  const md = read('README.md');

  /* 1. 相對連結指向的檔案要存在 */
  {
    const broken = [...md.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((t) => !/^https?:/.test(t))
      .map((t) => t.replace(/#.*$/, ''))
      .filter((t) => !fs.existsSync(path.join(ROOT, t)));
    c.eq('沒有失效的相對連結', broken, []);
  }

  /* 2. README 寫的數字要跟程式一致 */
  {
    const main = read('src/content/main.js');
    const readers = read('src/content/readers.js');
    c.eq('翻頁上限 50 頁', [md.includes('上限 50 頁'), main.includes('MAX_PAGES = 50')], [true, true]);
    c.eq('翻頁間隔 400 ms', [md.includes('400 ms'), main.includes('DELAY_MS = 400')], [true, true]);
    c.eq('等渲染上限 15 秒', [md.includes('上限 15 秒'), readers.includes('RENDER_TIMEOUT_MS = 15000')], [true, true]);
    c.eq('部分欄位再等 2 秒', [md.includes('再等 2 秒'), readers.includes('PARTIAL_WAIT_MS = 2000')], [true, true]);
    c.eq('預覽上限 100 列', [md.includes('最多顯示 100 列'), read('popup.js').includes('PREVIEW_LIMIT = 100')], [true, true]);
  }

  /* 3. README 提到的選擇器要真的在程式裡 */
  {
    const pairs = [
      ['.product-image__qty', 'src/content/sites/amazon.js'],
      ['.pt-delivery-card-trackingId', 'src/content/readers.js'],
      ['.yohtmlc-order-id', 'src/content/sites/amazon.js'],
      ['/progress-tracker/package', 'src/content/sites/amazon.js'],
      ['item.rakuten.co.jp', 'src/content/sites/rakuten.js'],
      ['act=detail_page_view', 'src/content/sites/rakuten.js'],
      ['shipping-status', 'src/content/readers.js'],
    ];
    const missing = pairs.filter(([sel, file]) => !(md.includes(sel) && read(file).includes(sel)));
    c.eq('選擇器 README 與程式都有', missing.map(([s]) => s), []);
  }

  /* 4. manifest：README 的權限表與實際一致，而且確實沒有 background */
  {
    const manifest = JSON.parse(read('manifest.json'));
    c.eq('沒有 background / service worker', 'background' in manifest, false);
    c.eq('README 聲明沒有背景程式', md.includes('沒有 background / service worker'), true);
    const undocumented = manifest.permissions.filter((p) => !md.includes(`\`${p}\``));
    c.eq('每個權限 README 都有說明', undocumented, []);
  }

  /* 5. 站台轉接層的方法名 */
  {
    const amazon = read('src/content/sites/amazon.js');
    const methods = ['isOrderPage', 'isSignInPage', 'firstPage', 'findOrders', 'nextPageUrl'];
    const declared = (m) => amazon.includes(`${m}:`) || amazon.includes(`\n    ${m},`);
    c.eq('轉接層方法 README 與程式都有', methods.filter((m) => !(md.includes(m) && declared(m))), []);
  }

  /* 6. fixture 說明對得上實際檔案 */
  {
    const table = md.split('| fixture | 內容 |')[1].split('\n\n')[0];
    const listed = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    const expand = (name) => {
      const m = name.match(/^(.*)\{([a-z,]+)\}$/);
      return m ? m[2].split(',').map((l) => m[1] + l) : [name];
    };
    const missing = listed.flatMap(expand).filter((f) => !fs.existsSync(path.join(ROOT, 'tests/fixtures', f + '.html')));
    c.eq('README 列的 fixture 都存在', missing, []);
    const files = fs.readdirSync(path.join(ROOT, 'tests/fixtures')).map((f) => f.replace(/\.html$/, ''));
    c.eq('fixture 都有寫進 README', files.filter((f) => !listed.flatMap(expand).includes(f)), []);
  }

  /* 7. fixture 不可含個資（倉庫是公開的） */
  {
    const personal = ['黃毅仁', 'Ben Huang', '木野崎', '代官', '2119-4', '3-12-6', '242-0025', '278-0002', 'TWKYHYLJ', 'TWSS', 'JY114'];
    const leaked = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'tests/fixtures'))) {
      const s = read(path.join('tests/fixtures', f));
      for (const t of personal) if (s.includes(t)) leaked.push(`${f}: ${t}`);
    }
    c.eq('fixture 沒有姓名 / 住址', leaked, []);
    c.eq('tmp/ 有被 gitignore', read('.gitignore').includes('tmp/'), true);
  }

  return c.report();
};
