/* 測試共用：載入 content script、建立 jsdom 環境、斷言 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'content');
const FILES = ['util.js', 'readers.js', 'sites/amazon.js', 'sites/rakuten.js', 'sites/shopify.js', 'sites/tower.js', 'sites/pokemoncenter.js', 'sites/nijisanji.js', 'sites/animate.js', 'sites/mumo.js', 'main.js'];

function loadFiles(files) {
  delete globalThis.OrderScraper; // 重新載入時不要累積重複的站台
  for (const f of files) new Function(fs.readFileSync(path.join(SRC, f), 'utf8'))();
}

const loadContentScripts = () => loadFiles(FILES);
// 只載入頁面讀取器（不需要 chrome API）
const loadReaders = () => loadFiles(['util.js', 'readers.js']);

// jsdom 不會真的載入 iframe。這裡改成：設定 frame.src 時直接用 pages(url) 回傳的 HTML
// 當成 contentDocument，模擬「同網域、讀得到 DOM」。
// pages 回傳空值代表被擋下（例如 X-Frame-Options），比照真實情況：load 會觸發但讀不到 contentDocument。
// 讀取器是在這個文件上真的跑一次，不是回傳假的結果
function patchIframes(win, pages, asked) {
  const create = win.document.createElement.bind(win.document);
  win.document.createElement = (tag, ...rest) => {
    const el = create(tag, ...rest);
    if (String(tag).toLowerCase() !== 'iframe') return el;

    let doc = null;
    Object.defineProperty(el, 'contentDocument', { get: () => doc });
    Object.defineProperty(el, 'src', {
      get: () => '',
      set(url) {
        asked.push({ url });
        const html = pages?.(url);
        if (html) doc = new JSDOM(html, { url }).window.document;
        else setTimeout(() => el.dispatchEvent(new win.Event('load')), 0);
      },
    });
    return el;
  };
}

// 建立頁面環境並回傳 scrape()。pages(url) 回傳該網址的 HTML（空值＝iframe 被擋下）
function setup(html, url, { pages } = {}) {
  const dom = new JSDOM(html, { url });
  const listeners = [];
  Object.assign(globalThis, {
    Node: dom.window.Node, window: dom.window, document: dom.window.document,
    location: dom.window.location, DOMParser: dom.window.DOMParser, URL: dom.window.URL,
  });
  const asked = [];
  patchIframes(dom.window, pages, asked);
  // 有些站台的頁面是伺服器渲染的，用 fetch 取回就夠（Shopify 的訂單頁、商品 JSON）。
  // 一樣由 pages(url) 供應內容，沒給 pages 時維持「不該發出 fetch」的防呆
  // POST 的話 asked 也記下 method 與 body，pages 的第二個參數收得到 { method, body }
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    if (!pages) throw new Error('不應發出 fetch：' + url);
    asked.push(init.method ? { url, method: init.method, body: String(init.body) } : { url });
    const body = pages(url, init);
    const miss = { ok: false, status: 404, url, text: async () => '', json: async () => ({}) };
    return body == null ? miss : {
      ok: true, status: 200, url,
      headers: { get: (name) => (/^content-type$/i.test(name) ? 'text/html; charset=utf-8' : null) },
      text: async () => body,
      json: async () => JSON.parse(body),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      },
      // 擴充功能已經沒有背景程式，content script 不該再對外送訊息
      sendMessage: async (msg) => {
        if (msg?.type !== 'SCRAPE_PROGRESS') throw new Error('不應送出訊息：' + JSON.stringify(msg));
      },
    },
  };
  loadContentScripts();
  /* 測試預設**不套七天的規則**（recentDays: Infinity）—— fixture 都是幾週前擷取的，
   * 套了就全部變成「舊訂單」。要驗七天規則的測試自己傳 recentDays，並用相對於今天的日期 */
  const scrape = (payload = {}) =>
    new Promise((res) => listeners.at(-1)({ type: 'SCRAPE', payload: { recentDays: Infinity, ...payload } }, null, res));
  const ping = () => new Promise((res) => listeners.at(-1)({ type: 'PING' }, null, res));
  return { dom, scrape, ping, asked, listeners };
}

/* ---------- 斷言 ---------- */
class Check {
  constructor(name) { this.name = name; this.fails = []; this.count = 0; }
  eq(label, actual, expected) {
    this.count += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      this.fails.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  }
  report() {
    if (this.fails.length) {
      console.log(`✗ ${this.name}`);
      this.fails.forEach((f) => console.log('   ' + f));
      return false;
    }
    console.log(`✓ ${this.name}（${this.count} 項）`);
    return true;
  }
}

module.exports = { setup, loadContentScripts, loadReaders, patchIframes, Check, JSDOM, SRC };
