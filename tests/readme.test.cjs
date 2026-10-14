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
    c.eq('自動翻頁的上限', [md.includes('翻到第 10 頁'), main.includes('MAX_PAGES = 10')], [true, true]);
    c.eq('翻頁停在七天', [md.includes('這一頁出現超過七天的訂單'), main.includes('RECENT_DAYS = 7')], [true, true]);
    c.eq('等渲染上限 15 秒', [md.includes('上限 15 秒'), readers.includes('RENDER_TIMEOUT_MS = 15000')], [true, true]);
    c.eq('部分欄位再等 2 秒', [md.includes('再等 2 秒'), readers.includes('PARTIAL_WAIT_MS = 2000')], [true, true]);
    c.eq('預覽上限 100 列', [md.includes('最多顯示 100 列'), read('popup.js').includes('PREVIEW_LIMIT = 100')], [true, true]);
    c.eq('只列七天內', [
      md.includes('只列出七天內下單的訂單'),
      // 「幾天算新」只定義在 main.js，popup 用它標好的 old / recent，不自己算日期
      !read('popup.js').includes('RECENT_DAYS'),
    ], [true, true]);
    c.eq('只擷取配送中的訂單', [
      md.includes('只擷取配送中的訂單'),
      read('src/content/sites/amazon.js').includes('DELIVERED_RE'),
      read('src/content/sites/rakuten.js').includes('isDelivered'),
    ], [true, true, true]);
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
      ['item-shipping-active', 'src/content/sites/rakuten.js'],
      ['.yohtmlc-shipment-status-primaryText', 'src/content/sites/amazon.js'],
      ['.deliveryBox', 'src/content/sites/tower.js'],
      ['.ship-num', 'src/content/sites/tower.js'],
      ['受取済', 'src/content/sites/tower.js'],
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
    const methods = ['isOrderPage', 'isSignInPage', 'findOrders'];
    const declared = (m) => amazon.includes(`${m}:`) || amazon.includes(`\n    ${m},`);
    c.eq('轉接層方法 README 與程式都有', methods.filter((m) => !(md.includes(m) && declared(m))), []);
  }

  /* 6. fixture 說明對得上實際檔案 */
  {
    const table = md.split('| fixture | 內容 |')[1].split('\n\n')[0];
    const listed = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    // 檔名可能寫成 amazon-list-{jp,en,cn} 或 shopify-dawn-{list,order}-ja
    const expand = (name) => {
      const m = name.match(/^(.*?)\{([a-z,]+)\}(.*)$/);
      return m ? m[2].split(',').map((part) => m[1] + part + m[3]) : [name];
    };
    const missing = listed.flatMap(expand).filter((f) => !fs.existsSync(path.join(ROOT, 'tests/fixtures', f + '.html')));
    c.eq('README 列的 fixture 都存在', missing, []);
    const files = fs.readdirSync(path.join(ROOT, 'tests/fixtures')).map((f) => f.replace(/\.html$/, ''));
    c.eq('fixture 都有寫進 README', files.filter((f) => !listed.flatMap(expand).includes(f)), []);
  }

  /* 7. fixture 不可含個資（倉庫是公開的）。
   *    用「形狀」判斷而不是列出實際字串 —— 黑名單本身就會把要保護的資料寫進公開倉庫。
   *    置換後的假住址統一是 東京都 / 〒100-0001，所以只要出現別的都道府県或郵遞區號，
   *    就表示有未經置換的實際住址混進來（新 fixture 幾乎一定會帶這兩樣）。 */
  {
    const PREFECTURE = /北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県/g;
    const POSTAL = /〒\s*\d{3}-\d{4}/g;
    const PLACEHOLDER = { prefecture: '東京都', postal: '〒100-0001' };

    const stray = { prefecture: [], postal: [] };
    for (const f of fs.readdirSync(path.join(ROOT, 'tests/fixtures'))) {
      const body = read(path.join('tests/fixtures', f));
      for (const m of body.match(PREFECTURE) || []) {
        if (m !== PLACEHOLDER.prefecture) stray.prefecture.push(`${f}: ${m}`);
      }
      for (const m of (body.match(POSTAL) || [])) {
        if (m.replace(/\s/g, '') !== PLACEHOLDER.postal) stray.postal.push(`${f}: ${m}`);
      }
    }
    c.eq('fixture 沒有未置換的都道府県', [...new Set(stray.prefecture)], []);
    c.eq('fixture 沒有未置換的郵遞區號', [...new Set(stray.postal)], []);
    c.eq('tmp/（未置換的原始頁面）有被 gitignore', read('.gitignore').includes('tmp/'), true);
  }

  return c.report();
};
