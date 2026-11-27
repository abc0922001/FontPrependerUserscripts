# FontPrepender 診斷與量尺校正計畫

## 1. 目標說明

在**不更動** [FontPrepender.user.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js) 任何正式業務邏輯的前提下，先解決現有基準測試 [benchmark.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.perf.js) 過度理想化導致的四項觀測盲點、將檔案頂部既有的零成本條件剖析器 `wrap()` 接上 8 個核心熱點函式，並在三個具代表性的公開真實網頁採集 `window.__fpProf` 與 Chromium Performance Trace（`LoAF`、`styleDuration`、`forcedStyleDuration`、`forcedLayoutDuration`）作為後續最佳化的客觀基線。

---

## 2. 現有基準盲點與靜態追蹤診斷

透過靜態追蹤 [FontPrepender.user.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js) 與 [benchmark.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.perf.js)，目前量尺存在以下五項結構性失真與兩個需於實測重點驗證的結構熱點：

1. **統計方式掩蓋配置與 GC 成本（[benchmark.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.perf.js#L129-L140)）**：
   - **問題**：`measureStableDuration` 僅執行 3 次並取最小值（`minDuration`）。
   - **具體追蹤**：字串切片（ConsString 展平）、`Set`/`Map` 擴容與 V8 新生代 GC 停頓皆出現在非最小樣本中，取最小值會系統性低估常態耗時。
   - **校正方案**：保留原 [benchmark.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.perf.js) 作為歷史微基準對照，新增 [benchmark.realistic.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.realistic.perf.js) 並全面改採 **5 次獨立採樣中位數（`sorted[2]`，同步輸出 `min / median / max`）**。

2. **盲點一：`<link>` 樣式表無預篩、屬性迴圈空轉與 `style.fontFamily` 雙重／三重取值（[processStyleSheet](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L896-L904)、[processRules](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L814-L849)）**：
   - **問題**：[benchmark.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.perf.js#L179-L192) 模擬的 2,000 條規則 100% 含有字型、`style.fontFamily` 為 `undefined` 且將 `style.length` 硬編碼為 `0`，導致真實瀏覽器的兩大熱路徑完全未執行。
   - **具體追蹤**：
     - [processStyleSheet](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L897-L904) 僅對 `<style>` 執行 `textContent` 正則預篩；對於同源 `<link rel="stylesheet">`，`hasFontVars` 恆為 `true`。當 2,000 條規則每條有 12 個屬性（85% = 1,700 條無字型，且夾雜 `--tw-*`、`--color-*` 等非字型變數）時，`processRules` 會執行 `2,000 × 12 = 24,000` 次 `style[p]` 跨界索引讀取，並對每個 `--*` 屬性執行 `CSS_VAR_FONT_REGEX.test(propName)`。
     - 在 [processRules](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L818-L820) 與 [patchElementInlineStyle](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1083-L1085) 中：
       ```javascript
       const currentFont = typeof style.fontFamily === 'string'
         ? (style.fontFamily ? style.getPropertyValue('font-family') : '')
         : style.getPropertyValue('font-family');
       ```
       在 85% 無字型規則上，`typeof style.fontFamily` 與 `style.fontFamily ?` 連續觸發 **2 次** `fontFamily` getter；在 15% 有字型規則上更觸發 **2 次 `fontFamily` getter + 1 次 `getPropertyValue('font-family')` = 3 次跨界讀取**。

3. **盲點二：`MutationObserver` 巢狀容器、`attributes: style` 高頻變動與 `takeRecords()` 回音檢測（[startPhase2Observer](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1523-L1683)）**：
   - **問題**：原基準僅塞入 `firstElementChild: null` 的扁平假節點，且 `MockMutationObserver` 未實作 `takeRecords()`。
   - **具體追蹤**：完全未覆蓋 `containerSet` 祖先回溯（[L1588-L1599](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1588-L1599)）、子樹 `node.querySelectorAll('[style*="font-family" i], style, link[rel="stylesheet"]')`（[L1638](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1638)）、動畫／定位腳本高頻改寫 `style="transform: ...; top: ..."` 的 `attributes: style` 空轉路徑；亦未驗證 [L1670-L1672](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1670-L1672) 的 `observer.takeRecords()` 是否精準排空自身寫入回音，以及在「零寫入批次」下仍無條件呼叫 `takeRecords()` 的行為。

4. **盲點三：500KB 混合外部 CDN CSS 雙趟掃描與高頻 `insertRule`（[rewriteCssContent](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L577-L694)、[hookCSSPrototypes](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1444-L1460)）**：
   - **具體追蹤**：面對含 `baseUrl` 的 500KB 外部 CDN 樣式表（90%+ 無關規則、大量 `url("data:image/svg+xml,...")` 與相對路徑）時，`rewriteCssContent` 會先以全域 `.replace(/url\(...\)/gi)` 掃描並配置整份 500KB 新字串，再跑第二趟 `indexOf('font-family')` 與單行壓縮 CSS 逆向 `extractSelectorBefore`。此外，X.com（React Native for Web）大量透過 `sheet.insertRule(...)` 注入原子化樣式，攔截器的淨增量開銷尚無獨立量尺。

5. **盲點四：`HTMLElement.prototype.style` Getter 全域攔截外溢成本（[hookCSSPrototypes](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1351-L1377)）**：
   - **具體追蹤**：頁面內任何與字型無關的動畫或虛擬捲動存取 `el.style` 時，皆會經過 JS 包裝函式執行 `origStyleGet.call(this)` 與 `!styleToElementMap.has(s)`（首次存取另加 `styleToElementMap.set(s, this)`），並退化 V8/Blink 原生 DOM Accessor 快速路徑。

6. **實測需重點關注的兩個附加結構熱點**：
   - **字型 CDN 觸發全頁計算樣式重掃**：[processStyleSheet](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L940-L944) 遇到 `fonts.googleapis.com` 或 `use.typekit.net` 時會將 `hasCorsSheets` 設為 `true`；此後捲動時任何新增節點都會排程 [patchComputedStyles](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1163-L1168)，一旦前一輪佇列歸零便會再次對整份 `document` 執行 23 組複雜選擇器的 `querySelectorAll`。
   - **全頁星號查詢**：`DOMContentLoaded` 時 [scanAndPatchShadowRoots](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1314-L1320) 會執行 `document.querySelectorAll('*')` 並於 JS 迴圈逐一檢查全頁元素的 `el.shadowRoot`。

---

## 3. 預計變更一：真實場景效能基準測試套件

保留既有 [benchmark.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.perf.js) 作為微基準對照，新增真實負載基準並納入語法檢查與腳本入口。

### [NEW] [benchmark.realistic.perf.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/benchmark.realistic.perf.js)

統一實作 `measureMedian(fn, { runs = 5, beforeEach })`（狀態重設不計入計時，取 5 次排序後中位數 `sorted[2]`，並同步回報 `median / min / max`），涵蓋以下四大壓測：

- **R1 — 真實 CSSOM `<link>` 規則壓測（2,000 條 × 12 屬性、85% 無字型）**：
  - 建構 2,000 條規則（含 20% `@media` 巢狀規則），85%（1,700 條）無 `font-family`、15%（300 條）含各式字型鏈與 `!important`；每條 `style.length = 12`，包含真實 `style.fontFamily` getter 與 4 個非字型 CSS 變數（`--tw-bg-opacity`、`--color-surface` 等）及 `:root` 字型變數。
  - **R1-A**：`ownerNode = <link rel="stylesheet">` 經 `processStyleSheet` 掃描耗時（觸發 `hasFontVars = true` 全量 24,000 次 `style[p]` 迴圈），並統計單趟 `fontFamily` getter 次數、`getPropertyValue` 次數與 `style[p]` 索引讀取次數。
  - **R1-B**：相同規則掛載於無變數 `<style>`（`hasFontVars = false`）之對照耗時，直接分離 `<link>` 屬性空轉淨開銷。
  - **R1-C**：JSDOM 真實 `CSSStyleSheet` 2,000 條規則實例掃描中位數耗時。

- **R2 — 真實 `MutationObserver` 壓測（JSDOM 真實微任務佇列）**：
  - **R2-A 多層巢狀容器批次插入**：單次插入 60 張 4 層結構文章卡片（約 1,200 節點，含 `article > div > h3 > a`、`svg > path` 剪枝對象、15% 行內 `!important` 字型，並在同一微任務混合父容器與子節點 `addedNodes` 以強制觸發 `containerSet` 祖先回溯與子樹 `querySelectorAll`）。
  - **R2-B 高頻 `attributes: style` 變動**：對 150 個元素派發 500 筆 `style` 變更（90% 為 `transform`/`opacity`/`top` 非字型屬性、5% 為已前置元素改色、5% 為新增行內字型）。
  - **R2-C `takeRecords()` 回音抑制與空呼叫檢測**：攔截並統計 `observer.takeRecords()` 排空之自寫入回音數，斷言下一輪微任務 `callback` 零二次喚醒，並記錄純非字型變動批次下 `takeRecords()` 的無條件呼叫次數。

- **R3 — 500KB 外部 CDN CSS 改寫與高頻 `insertRule` 壓測**：
  - **R3-A 500KB 混合外部 CDN CSS (`rewriteCssContent`)**：合成約 500KB 壓縮格式 CSS（92% 無關規則、150 個含大型 `data:image/svg+xml` 與 `../` 相對路徑之 `url(...)`、15 個 `@font-face`、含 `--font-family-base` 連字號干擾項與 8% 目標字型規則），量測 `rewriteCssContent(css500KB, baseUrl)` 5 次中位數耗時。
  - **R3-B 高頻 `insertRule`（模擬 X.com React Native for Web）**：連續執行 5,000 次 `sheet.insertRule`（90% 無字型原子類 + 10% `TwitterChirp` 或等寬原子類），對照 **Unhooked 原生 `insertRule`** vs **Hooked `insertRule`** 5 次中位數耗時與淨增量。

- **R4 — `HTMLElement.prototype.style` 高頻讀取開銷對照測試**：
  - 對照 **Unhooked 原生 `el.style` getter** vs **Hooked `el.style` getter**：
    - **R4-A 冷讀取（Cold）**：1,000 個新建 `HTMLElement` 首次存取 `el.style`（含 `WeakMap.has` + `WeakMap.set`）。
    - **R4-B 熱讀取（Warm）**：對 1,000 個元素執行 100,000 次 `el.style` 讀取，輸出中位數耗時、淨增量與相對倍率。

*(註：基線採集階段 `benchmark.realistic.perf.js` 完整輸出中位數與計數器報表並以 `exit 0` 結束，待後續最佳化階段再依實測基線鎖定防退化硬門檻。)*

### [MODIFY] [package.json](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/package.json) & [check.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/scripts/check.js)

- [package.json](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/package.json) 的 `scripts` 新增 `"bench:realistic": "node tests/benchmark.realistic.perf.js"`。
- [check.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/scripts/check.js) 的 `targetFiles` 陣列加入 `'tests/benchmark.realistic.perf.js'`。

---

## 4. 預計變更二：條件式剖析器 `wrap()` 熱點接線

### [MODIFY] [FontPrepender.user.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js)

嚴格維持正式邏輯零更動：`PROFILE === false`（未設定 `localStorage['fp-profile'] === '1'`）時，`wrap(name, fn)` 直接回傳原函式，不產生任何執行期包裝閉包。

1. **防止 `@media` / `@import` 遞迴重複計時（[L47-L59](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L47-L59)）**：
   - `processRules` 處理 `@media` 時會遞迴呼叫自身；若直接累加 `(end - start)`，巢狀耗時會被重複計算。僅在 `PROFILE === true` 分支內加入輕量重入深度計數 `prof.d[name]`，`prof.n[name]` 照常累計每次呼叫，但 `prof.t[name]` 僅於 `depth === 0` 最外層結束時累加牆鐘時間：
     ```javascript
     const prof = PROFILE ? { t: Object.create(null), n: Object.create(null), d: Object.create(null) } : null;
     const wrap = (name, fn) => {
       if (!PROFILE) return fn;
       return function(...args) {
         const depth = prof.d[name] || 0;
         prof.d[name] = depth + 1;
         const start = depth === 0 ? performance.now() : 0;
         try {
           return fn.apply(this, args);
         } finally {
           prof.d[name] = depth;
           if (depth === 0) {
             prof.t[name] = (prof.t[name] || 0) + (performance.now() - start);
           }
           prof.n[name] = (prof.n[name] || 0) + 1;
         }
       };
     };
     ```

2. **接上 8 個核心熱點函式**：
   - `phase2Observer`：於 [startPhase2Observer](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1523) 建立 `MutationObserver` 時套用 `wrap('phase2Observer', (mutations) => { ... })`。
   - 其餘 7 個具名函式於 `init()` 前（[L1837](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js#L1837) 前方）在 `if (PROFILE)` 守衛內重綁定，保留原 `function` 宣告、JSDoc 與呼叫堆疊函式名稱，並使 `module.exports` 在測試開啟 `fp-profile=1` 時同步匯出包裝版本：
     ```javascript
     if (PROFILE) {
       prependFontFamily = wrap('prependFontFamily', prependFontFamily);
       rewriteCssContent = wrap('rewriteCssContent', rewriteCssContent);
       processStyleSheet = wrap('processStyleSheet', processStyleSheet);
       processRules = wrap('processRules', processRules);
       scanAndPatchInlineStyles = wrap('scanAndPatchInlineStyles', scanAndPatchInlineStyles);
       patchElementInlineStyle = wrap('patchElementInlineStyle', patchElementInlineStyle);
       patchComputedStyles = wrap('patchComputedStyles', patchComputedStyles);
     }
     ```

3. **8 大熱點呼叫階層關係（解讀 `window.__fpProf` Inclusive Time 對照圖）**：
   ```mermaid
   flowchart TD
     MO["phase2Observer (MutationObserver)"] --> PEIS["patchElementInlineStyle"]
     MO --> PSS["processStyleSheet"]
     SAPIS["scanAndPatchInlineStyles"] --> PEIS
     PSS --> PR["processRules"]
     PSS -. "CORS fetch async" .-> RCC["rewriteCssContent"]
     PR --> PFF["prependFontFamily"]
     PEIS --> PFF
     RCC --> PFF
     PCS["patchComputedStyles (Idle Slice)"]
   ```

### [MODIFY] [dom.test.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/tests/dom.test.js)

- 新增條件剖析器驗證測試：
  1. 預設環境（未設定 `fp-profile`）下 `window.__fpProf` 為 `undefined`。
  2. 設定 `localStorage.setItem('fp-profile', '1')` 後，執行樣式表掃描（含 `@media` 巢狀規則）、行內樣式掃描、計算樣式修補、`rewriteCssContent` 與 `MutationObserver` 變動，驗證 `window.__fpProf.n` 與 `window.__fpProf.t` 準確記錄全部 8 個熱點鍵名，且巢狀 `@media` 不會造成重複計時。

---

## 5. 預計變更三：三站公開網頁 `fp-profile=1` 與 Performance Trace 基線採集

針對三個真實公開網頁採集 **Control（未注入）** 與 **Treatment（`fp-profile=1` 注入）** 對照基線：
- `https://www.xda-developers.com/archive/`（外部 CORS CDN CSS + 卡片標題）
- `https://unikoshardware.com/`（大量行內 `!important` 樣式 + `.jeg_post_meta`）
- `https://9to5google.com/`（Typekit + `:root` CSS 自訂變數）

1. **真實 `@run-at document-start` 前置注入**：
   - 於導覽／重新整理前透過 `addScriptToEvaluateOnNewDocument` 依序執行：
     1. `localStorage.setItem('fp-profile', '1')`
     2. 掛載 `PerformanceObserver`（`type: 'long-animation-frame'`, `buffered: true`）收集每筆 LoAF 的 `duration`、`blockingDuration`、`renderStart`、`styleAndLayoutStart` 與 `scripts[]`（含原生 `forcedStyleAndLayoutDuration` 與函式歸因）至 `window.__fpLoAF`
     3. 注入執行 [FontPrepender.user.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js)
   - **安全邊界**：全程使用可視視窗；若遇 Cloudflare Turnstile 或驗證碼挑戰，立即暫停並請使用者手動完成或略過該站，絕不以腳本自動點擊或繞過。

2. **標準化互動劇本**：
   - 啟動 Performance Trace -> 導覽並等待 `load` 後靜置 `2,000 ms`（收斂異步 CORS `fetch` 與首次 `requestIdleCallback`）-> 以每步 `650 px`、間隔 `250 ms` 向下捲動 6 次（共 `3,900 px`）再上捲 `1,300 px` -> 靜置 `1,500 ms` 停止 Trace -> 讀取 `window.__fpProf` 與 `window.__fpLoAF`（並附帶於瀏覽器內執行一組 100,000 次 `div.style` 原生 vs Hooked 對照）。

3. **指標提取定義**：
   - **`window.__fpProf`**：8 個熱點的呼叫次數 `n`、累積耗時 `t (ms)`、單次平均 `t/n (ms)`。
   - **`LoAF`**：總筆數、總 `duration`、最大單幀 `duration`、總 `blockingDuration`、歸因於腳本之 `forcedStyleAndLayoutDuration`。
   - **`Performance Trace`（`CrRendererMain` 主執行緒）**：
     - `styleDuration`：頂層 `UpdateLayoutTree`（`RecalcStyle`）總耗時（ms）。
     - `forcedStyleDuration`：巢狀於 JS 執行任務（`FunctionCall` / `EvaluateScript` / `RunMicrotasks` / `TimerFire` / `FireIdleCallback` / `EventDispatch`）內或帶 `stackTrace` 之強制同步 `UpdateLayoutTree` 總耗時（ms）。
     - `forcedLayoutDuration`：巢狀於上述 JS 執行任務內之強制同步 `Layout` 總耗時（ms）。

---

## 6. 驗證計畫

核准並執行完成後，依序執行以下命令確保零破壞與基線完整產出：

```bash
npm run check
npm run test
npm run bench
npm run bench:realistic
```

- 確認 [FontPrepender.user.js](file:///C:/Users/DIDI/Documents/Git/FontPrependerUserscripts/src/FontPrepender.user.js) 維持純淨 UTF-8 與 `LF` 換行符號。
- 產出三站 Control vs Treatment 基線報告至 Artifact 目錄。

---

## 7. 執行前待確認事項

1. **`chrome-devtools` MCP 連線方式**：目前對話環境僅掛載 `rea` 與 `taiwanmd`，尚未掛載 `chrome-devtools` MCP（本機已具備 `C:\Program Files\Google\Chrome\Application\chrome.exe` 與內建 `WebSocket` 之 Node.js `v26.13.1`）：
   - **方案 A**：您先於 Antigravity 設定啟用 `chrome-devtools` MCP 後核准執行，我將優先透過 `chrome-devtools` MCP 採集（並視工具支援度確保 `document-start` 注入時序）。
   - **方案 B**：不調整 MCP 設定，由我撰寫暫存 Node 原生 Chrome CDP 採集腳本啟動可視 Chrome 視窗，透過標準 DevTools Protocol（`Page.addScriptToEvaluateOnNewDocument` + `Tracing.start/end`）採集一致的 Trace 與 `window.__fpProf` 基線。
2. **8 個熱點清單確認**：第 8 個熱點選用捲動互動期的 `phase2Observer`（搭配僅於 `PROFILE === true` 生效的 `prof.d` 遞迴防重複計時），請確認是否同意或需調整（例如改為／另納入 `scanAndPatchShadowRoots`）。
