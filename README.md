# 訂單擷取（Amazon.co.jp / 楽天市場 / Shopify）

Chrome 擴充功能（Manifest V3），從訂單列表頁擷取配送中的訂單，匯出 JSON。

支援 Amazon.co.jp、楽天市場，以及**任何 Shopify 商店**。Shopify 那一層是用頁面特徵判斷的，
不是網域白名單 —— 代購常用的 ちいかわマーケット、ナガノマーケット、各家官方周邊店等十幾個站都走同一套。

供代購 / WMS 流程使用，所以取捨偏向**寧可留空，不要抓錯**：認不出來的欄位一律空著，不猜。

## 安裝

1. Chrome 開啟 `chrome://extensions`
2. 開啟右上角「開發人員模式」
3. 「載入未封裝項目」→ 選擇本資料夾

載入後 popup 標題旁會顯示版本，可確認是不是最新的那一份。

## 使用

1. 登入後開啟訂單列表頁：
   - Amazon：https://www.amazon.co.jp/gp/css/order-history
   - 楽天：https://order.my.rakuten.co.jp/purchase-history/order-list/
   - Shopify 商店：該店的 `/account`（例如 https://chiikawamarket.jp/account）。
     多語系商店的路徑會帶語系前綴，例如 `/zh-hant/account`、`/zh-hans/account`、`/en/account`，都支援
2. 點擴充功能圖示（popup 會顯示目前站台），按「擷取訂單」
3. 按「下載 JSON」（檔名會帶站台，例如 `amazon-orders-20261006-0930.json`）

**只擷取目前頁面** —— 看到哪一頁就抓哪一頁，不會自動翻頁。要抓別頁就在網站上翻過去再按一次。

結果會存進 `chrome.storage.local`，popup 關掉再開還看得到上次的結果。預覽表格最多顯示 100 列，下載的 JSON 不受影響。

## 各站台的差異

| | Amazon.co.jp | 楽天市場 | Shopify |
| --- | --- | --- | --- |
| 注文番号 | 列表頁 | 列表頁 | 列表頁 |
| 品名 | 列表頁 | 列表頁 | **注文詳細頁** |
| 画像 | 列表頁 | 列表頁 | **商品 JSON**（`/products/{handle}.js`，訂單頁沒有圖） |
| 数量 | 列表頁（`.product-image__qty`，沒有就是 1 件） | **注文詳細頁**（列表頁沒有，用品名對回去） | **注文詳細頁**（`headers~="ColumnQuantity"`） |
| 合計 | 列表頁 | **注文詳細頁**（支払い金額 / Total amount） | 列表頁，詳細頁的 `RowTotal` 覆蓋 |
| 配送業者 / 伝票番号 | **配送状況頁**（每個包裹一頁） | 日文列表頁；英文介面的列表頁沒有，改由**注文詳細頁**提供 | **注文詳細頁**的 `.fulfillment` |
| 擷取條件 | 包裹有「配送状況を確認」按鈕（即配送中） | 訂單有伝票番号 | 商品有追蹤號 |
| 另外載入的頁面 | iframe（前端渲染） | iframe（前端渲染） | `fetch`（伺服器渲染，快很多） |

## 為什麼一定要多讀一頁

兩邊都試過只靠列表頁完成擷取，結論是**不行**，缺的欄位列表頁根本沒有。
實際頁面存在 [tests/fixtures/](tests/fixtures/)，查證寫成了測試（[amazon-real.test.cjs](tests/amazon-real.test.cjs) 第 3 項）。

| 站台 | 列表頁缺什麼 | 查證 |
| --- | --- | --- |
| Amazon | 配送業者、トラッキングID | 日 / 英 / 簡中三份完整列表頁裡都搜不到追蹤號碼、業者名稱或任何標籤字樣，連內嵌 JSON 也沒有；列表頁只給得出配送狀況頁的連結（帶 `shipmentId`） |
| 楽天 | 合計 | 列表頁只有各商品單價，沒有「支払い金額」。單價加總在免運又沒用折價券時剛好相等，但送料、折價券、點數都會讓它對不上，不能當合計 |

所以「配送中的包裹」（Amazon）與「要擷取的訂單」（楽天）各需多讀一頁。程式會盡量少讀：

- Amazon 只讀有「配送状況を確認」按鈕的包裹，同一個包裹的多件商品共用一次讀取
- 楽天在日文介面的列表頁就看得出哪些訂單沒有伝票番号，那些連詳細頁都不會載入

## 輸出格式

**一個包裹一筆**：同一筆訂單有多個包裹（多個伝票番号）時，注文番号與合計會重複出現。

```json
[
  {
    "orderId": "297942-20260918-0695404827",
    "total": 10660,
    "currency": "JPY",
    "carrier": "ヤマト運輸",
    "trackingId": "391175086374",
    "items": [
      { "title": "ヤマサ 醤油 …", "quantity": 1, "imageUrl": "https://thumbnail.image.rakuten.co.jp/…jpg" }
    ]
  }
]
```

| 欄位 | 說明 |
| --- | --- |
| `orderId` | 注文番号 |
| `total` | 整筆訂單的合計（不是這個包裹的）。讀不到時為 `null` |
| `currency` | 固定 `JPY` |
| `carrier` / `trackingId` | 配送業者 / 伝票番号。讀不到時為空字串 |
| `items[].title` / `imageUrl` | 品名 / 商品圖 |
| `items[].quantity` | 数量。沒有標示就是 1 |

- Amazon 知道哪件商品在哪個包裹，所以商品會分到各自的包裹下
- 楽天不標示商品與包裹的對應，所以同一筆訂單的商品會掛在它的每個伝票番号下

## 程式結構

| 檔案 | 用途 |
| --- | --- |
| [manifest.json](manifest.json) | MV3 設定。**沒有 background / service worker** |
| [rules.json](rules.json) | declarativeNetRequest 規則，移除 iframe 的防嵌入標頭（見下方「另外載入的頁面」） |
| [popup.html](popup.html) / [popup.js](popup.js) / [popup.css](popup.css) | UI：擷取按鈕、進度、預覽表格、下載 JSON |
| [src/lib/export.js](src/lib/export.js) | 整理成輸出用的欄位、產生 JSON、觸發下載 |

content script 依站台拆開，共用同一套流程（manifest 依序載入）：

| 檔案 | 用途 |
| --- | --- |
| [util.js](src/content/util.js) | 共用小工具、切出訂單範圍（`climbUnique` / `cardsByOrderId`）、`fetch` 下一頁、隱藏 iframe 載入 |
| [readers.js](src/content/readers.js) | 「要真的載入才讀得到」的頁面讀取器（Amazon 配送狀況頁 / 楽天 注文詳細頁），在隱藏 iframe 的文件上執行 |
| [sites/amazon.js](src/content/sites/amazon.js)、[sites/rakuten.js](src/content/sites/rakuten.js)、[sites/shopify.js](src/content/sites/shopify.js) | 各站台的列表頁解析，回報要另外讀取哪些頁 |
| [main.js](src/content/main.js) | 解析目前頁面、讀取詳細資料、訊息處理 |

站台轉接層的介面只有三個：`isOrderPage(loc, doc)` / `isSignInPage` / `findOrders`。
要加新站台就多一個 `sites/*.js`，`main.js` 不用改。

`isOrderPage` 收得到 `doc`，所以站台可以用**頁面特徵**判斷而不是網域 —— Shopify 轉接層就是這樣
一次吃下所有 Shopify 商店的。

### 權限

| 權限 | 用途 |
| --- | --- |
| `activeTab` / host_permissions | 讀取目前這個訂單列表頁 |
| `scripting` | 擴充功能重新載入後，既有分頁沒有 content script，由 popup 補注入 |
| `storage` | 存上次的擷取結果 |
| `declarativeNetRequest` | 見「另外載入的頁面」 |

### Amazon 的錨點

外層卡片的 class 最常改版，所以以穩定元素當錨點，再往上找出所屬範圍（`climbUnique`）：

| 欄位 | 錨點 |
| --- | --- |
| 訂單範圍 / 注文番号 | `.yohtmlc-order-id`。同一個番号在桌機 / 手機標頭可能各出現一次，所以算的是「不同的番号」 |
| 合計 | `.order-header__header-list-item` 內的「合計 / Total / 总价」標籤；認不得標籤時取標頭裡第一個含金額的欄位 |
| 是否配送中 | 包裹內是否有 `a[href*="/progress-tracker/package"]`（配送状況を確認按鈕） |
| 品名 / ASIN | `a[href*="asin_title"]`（退回：任何帶文字的 `/dp/` 連結、`.yohtmlc-product-title` 純文字、商品圖 `alt`） |
| 圖片 | `img[alt=品名]`，優先取 `data-a-hires` |
| 数量 | 該圖片所屬 `.product-image` 裡的 `.product-image__qty`。只有 2 件以上才顯示，沒有就是 1 件。**只從自己那張圖找**，避免借到同包裹其他商品的數量 |
| 配送業者 / トラッキングID | 配送狀況頁的標題「配送業者 / Shipped with / 由 X 配送」與 `.pt-delivery-card-trackingId` |

### Shopify 的錨點

版面依據 [Dawn](https://github.com/Shopify/dawn)（Shopify 官方開源佈景主題）的
`sections/main-account.liquid` 與 `main-order.liquid`。

關鍵：**Dawn 用 `id` / `headers` 屬性標示欄位，這些屬性不會被翻譯**，
所以多語系完全不必比對字樣。其他佈景主題可能改過版面，因此每個欄位都再退一層結構判斷。

| 欄位 | 錨點 |
| --- | --- |
| 訂單頁判斷 | 路徑是 `/account`，可帶語系前綴（`/zh-hant/account`、`/zh-hans/account`…）。前綴不一定是兩個字母 |
| 訂單範圍 / 注文番号 | `a[href*="/account/orders/"]`（任何佈景主題都有），往上爬到 `<tr>` |
| 合計（列表頁，可能沒有） | `td[headers~="ColumnTotal"]`；退回時要求該欄位含幣別標記（`¥` / `JPY` / `円`），否則日期欄的「2024年12月28日」會被當成金額 2024 |
| 合計（詳細頁，優先） | `td[headers~="RowTotal"]` → class 含 `order_total` / `order-total` 的元素 → 表尾最後一個金額。都避開小計 / 送料 / 稅 |
| 品名 | 該列的 `a[href*="/products/"]`，沒有連結時退回該列的標題元素（`h1`–`h5`） |
| 数量 | `td[headers~="ColumnQuantity"]` → class 含 `qty` / `quantity` 的欄位 → 整格只有數字的欄位 |
| 配送業者 / 追蹤番号 | 文字剛好是 `{{ tracking_company }} #{{ tracking_number }}` 的最內層元素。`#` 是樣板寫死的字元，不是翻譯，所以可以直接當錨點 |
| 画像 | 該列若有 `<img>` 就直接用（去掉 Shopify CDN 的 `_100x` 尺寸後綴）。沒有才用商品連結的路徑加 `.js` 取 `featured_image`，保留語系前綴避免轉址。同一件商品只問一次 |

訂單列表只有注文番号 / 日期 / 狀態 / 合計，所以**目前這一頁上的每筆訂單都要讀一次詳細頁**。
那些頁面是伺服器渲染的，用 `fetch` 就夠，不必開 iframe。

實際看過的兩種佈景主題差很多，所以解析**不靠固定的表格選擇器**：

| | ちいかわマーケット（Dawn 原版） | jypj-store（客製） |
| --- | --- | --- |
| 欄位標示 | `id` / `headers` 屬性 | 沒有，用 class |
| 品名 | `a[href*="/products/"]` | `<h4>`（沒有商品連結） |
| 商品圖 | 沒有 → 另外要商品 JSON | 訂單頁上就有 `<img>` |
| 追蹤號 | `<span>` 裡 | 追蹤連結的 `<a>` 裡 |
| 合計 | 表尾 `td[headers~="RowTotal"]` | `<dl class="order_total">` |
| 列表頁合計欄 | 有（`5,940.00JPY`） | **沒有** |

共通點只有一個：配送資訊一律輸出「`{{ tracking_company }} #{{ tracking_number }}`」。
所以改以那個 `#` 為錨點找出配送資訊，再往上找出它所屬的那一列，其餘欄位都在那一列裡找。

### 楽天的錨點

樂天的 class 帶雜湊（`ellipsis--3QFZf`），雜湊每次改版都會變，所以只比對前綴（`[class*="ellipsis--"]`）：

| 欄位 | 錨點 |
| --- | --- |
| 訂單範圍 / 注文番号 | 內容剛好是 `123456-20260929-0083907767` 的 `span`，再往上爬 |
| 品名 / 圖片 | 商品連結 `a[href*="item.rakuten.co.jp"]` 裡的 `img`，品名取 `alt`，圖片去掉 `?_ex=` 尺寸參數。商店 logo 連的是 `www.rakuten.co.jp`，所以不會被當成商品 |
| 数量 | 列表頁沒有。詳細頁每件商品一個「数量：/ Quantity:」標籤，往上爬到只含這一件商品的範圍取品名當對照鍵，再回填到列表頁的商品；對不上就當 1 件 |
| 是否擷取 | 列表頁有沒有伝票番号（出貨狀態區塊 `[class*="shipping-status--"]`）。看得出來沒有時，連詳細頁都不會載入 |
| 注文詳細頁 | `a[href*="act=detail_page_view"]`，找不到時用注文番号自行組出 |
| 合計 | 詳細頁「支払い金額 / Total amount」標籤旁的金額（避開小計 / 送料）；認不得標籤時取字最大的金額 |
| 配送業者 / 伝票番号 | 詳細頁「配送業者 / Shipping company」「伝票番号 / Tracking number」標籤旁的值 |

英文介面的**列表頁沒有配送資訊**（連出貨進度都沒有），所以英文介面一定要載入詳細頁才知道有沒有伝票番号。

認不得標籤時（其他語系）還有一條後備規則：抓**出貨狀態區塊內**連到業者查詢頁的外部連結，
`aria-label` 當業者名，伝票番号必須是某個**查詢參數的完整值**（例如 `?oku01=568506023470`）。

> 這條規則限制得很嚴是有原因的。頁面上的活動連結（例如「○倍の注意点」）同樣是
> 「外部網域 + 有 `aria-label` + 網址帶長數字」，不限制範圍就會被當成配送業者，
> 產生假的伝票番号（實際發生過：`○倍の注意点 / 000031092`）。
> 這批資料會進 WMS，抓錯比抓不到更糟。回歸測試在 [rakuten.test.cjs](tests/rakuten.test.cjs) 第 8 項。

### 另外載入的頁面

配送狀況頁與注文詳細頁都是前端渲染，`fetch` 只拿得到空殼，必須讓瀏覽器真的載入。

**只用隱藏 iframe**：在目前頁面內用看不見的 iframe 載入（同網域，可直接讀 DOM），反覆讀到欄位出現為止
（上限 15 秒；只出現部分欄位時再等 2 秒）。不開新分頁、不需要背景程式，分頁列不會閃。
iframe 設了 `sandbox`（不給 `allow-top-navigation`），對方頁面的防嵌入程式無法把目前頁面導走。

被擋下時就**放棄那一頁**，相關欄位留空，不會另開分頁硬讀。

樂天的購買履歷頁會回 `x-frame-options: DENY`，所以 [rules.json](rules.json) 是**必要的**，不是最佳化 —
少了它，樂天的合計就抓不到。規則用 `declarativeNetRequest` 在**子框架請求**上移除這個標頭，
條件限定「由購買履歷頁發起、且指向購買履歷頁」，只影響本擴充功能自己載入的那個 iframe，正常瀏覽不受影響。
Amazon 的配送狀況頁目前沒有這個標頭，也加了一條預防性的規則。

所有要讀的頁面同時進行，且 HTML 解析完就開始讀，不等圖片載完。

## 多語系

只比對**實際出現過**的字樣，不做其他語言的推測。Amazon 支援日本語 / English / 简体中文，楽天支援日本語 / English。

Amazon 各語系的實際字樣（同一筆訂單）：

| | 合計 | 配送業者 | トラッキングID |
| --- | --- | --- | --- |
| 日本語 | `合計` `￥2,322` | `配送業者 日本郵便` | `トラッキングID: 421304890904` |
| English | `Total` `¥2,322` | `Shipped with 日本郵便` | `Tracking ID 421304890904` |
| 简体中文 | `总价` `JP¥2,322` | `由日本郵便配送` | `追踪编码 421304890904` |

處理方式（見 [sites/amazon.js](src/content/sites/amazon.js) 的 `TOTAL_LABEL_RE`、[readers.js](src/content/readers.js) 的 `CARRIER_*` / `TRACKING_LABEL_RE`）：

- **標籤字樣**不依賴冒號（英文、簡體中文都沒有冒號）
- **配送業者**支援「標籤在前」（`Shipped with X`）和「前後包住」（`由 X 配送`）兩種寫法
- **金額**接受 `￥` / `¥` / `JP¥`
- 認不得標籤時的後備規則（不依賴語言）：合計取標頭裡第一個含金額的欄位；トラッキングID 取最後一段像編號的字串

## 測試

```sh
npm install      # 需要 jsdom 與 puppeteer（E2E 用的 Chrome）
npm test         # 單元測試（jsdom，解析邏輯）
npm run e2e      # 端對端測試：真的開 Chrome 載入擴充功能，對模擬站台跑完整流程
```

E2E 的三種情境都要過：

```sh
npm run e2e                         # 一般情況
XFO_DENY=1 npm run e2e              # 站台回 x-frame-options: DENY → rules.json 應讓 iframe 仍可用
NO_DNR=1 XFO_DENY=1 npm run e2e     # 不套用 rules.json → iframe 真的被擋下，相關欄位應留空
```

E2E 會把整個擴充功能複製一份到暫存目錄、把網域換成 localhost 再載入 Chrome，所以不會動到工作目錄。
它用擴充功能自己的 popup 頁當驅動（沒有 service worker 可用了），並檢查**全程沒有另開分頁**。

[tests/fixtures/](tests/fixtures/) 是兩個站台的**實際頁面**，`amazon-real.test.cjs` 與 `rakuten.test.cjs`
直接對這些檔案跑解析，所以站台改版導致的解析失敗會被測出來：

| fixture | 內容 |
| --- | --- |
| `amazon-list-{jp,en,cn}` | 配送中的訂單，1 件商品、沒有數量標示（已移除 script / style，412 KB → 13 KB） |
| `amazon-list-qty-{jp,en,cn}` | 数量 4 件的訂單。這筆已送達，依規則不擷取，測試會另外補一個配送按鈕進去才驗數量 |
| `amazon-detail-{jp,en,cn}` | 配送狀況頁 |
| `rakuten-list-jp` | 3 筆訂單：配達完了（3 個伝票番号）、配送状況を確認できません、出荷準備中 |
| `rakuten-list-en` | 英文列表頁（不顯示配送資訊） |
| `rakuten-detail-{jp,en}` | 注文詳細頁：合計 / 配送業者 / 伝票番号 / 数量 |
| `shopify-dawn-{list,order}-ja` | ちいかわマーケット：Dawn 原版結構，合計寫成 `5,940.00JPY`，列表多一欄ノベルティ |
| `shopify-custom-{list,order}-ja` | jypj-store：大幅客製的佈景主題（詳下） |

> Amazon / 楽天的 fixture 是實際頁面，但**姓名與住址已置換成假資料**（倉庫是公開的）。測試不依賴這些欄位。
> 未經置換的原始頁面放在 `tmp/`，已在 `.gitignore` 內。
>
> `shopify-*` 也是實際頁面，姓名 / 住址 / 電話同樣已置換。

單元測試裡的 iframe 不是真的載入，而是把指定的 HTML 直接當成 `contentDocument`，
所以 readers.js 是在那份文件上**真的跑一次**，不是回傳假結果。

[readme.test.cjs](tests/readme.test.cjs) 會比對本文件與程式碼：連結是否有效、寫出來的數字與選擇器是否跟程式一致、
fixture 清單是否齊全、fixture 有沒有混進個資。改了程式忘了改 README，這個測試會失敗。

## 已知限制

- **只擷取目前頁面**，不會自動翻頁。訂單多的時候要自己在網站上翻頁，每頁按一次
- Shopify 的訂單列表看不出哪些訂單有追蹤號，所以列表上的每筆訂單都要讀一次詳細頁
- 只解析訂單列表頁與配送狀況頁 / 注文詳細頁，不會讀配送先住所、支付方式、單價
- 另外載入的頁面一律走隱藏 iframe。站台若擋住嵌入（`x-frame-options` / `content-security-policy: frame-ancestors`）
  且 [rules.json](rules.json) 沒涵蓋到，那一頁就讀不到，相關欄位留空
- 需要本人登入狀態。被導到登入頁時會中止並顯示訊息
- 解析依賴站台的 DOM 結構，改版可能失效。先跑 `npm test`，必要時把新的實際頁面放進 `tests/fixtures/` 再修
