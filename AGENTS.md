# FontPrepender AI Agent 開發與維護交接手冊 (`AGENTS.md`)

本文件為後續接手本專案的 AI Coding Agent 提供專案架構、設計約束、核心演算法細節與驗證標準。任何由 AI Agent 執行的變更均須嚴格遵守本文件規範。

---

## 1. 專案核心約束與工程紀律

### 1.1 產出檔案純淨度原則 (Critical)
* `src/FontPrepender.user.js` 為發佈至 **Greasy Fork** 的唯一核心產出。
* **嚴禁任何壓縮（Minification）或混淆（Obfuscation）**，變數名稱與函式名稱必須清晰直觀。
* 該檔案**僅能包含 Userscript 原始碼、Metadata Block 與詳細正體中文註解**。
* 不得混入 Babel、Webpack、Vite 等打包工具產生的 Polyfill 或 Runtime 雜訊。
* 檔案換行符號一律維持 Unix 風格（`LF`），編碼統一為 `UTF-8`。

### 1.2 Git 操作與提交紀律 (Git Discipline)
* **嚴禁執行 `git push`**：所有提交僅於本地 Git 儲存庫進行，禁止向遠端執行 push 操作。
* **呼叫 `git-commit` 技能標準**：每次完成階段性里程碑或明確需求時，必須產出符合規範的 Commit Message：
  * **語言**：正體中文（zh-TW）。
  * **格式**：首行主旨（<= 50 字元，結尾無句點），空一行後為內文（每行 <= 72 字元，清楚交代 Why 與 How）。
  * **禁止 Emoji**：Commit 訊息內嚴禁使用表情符號。

---

## 2. 目錄架構與職責

```text
.
├── src/
│   └── FontPrepender.user.js   # [唯一發佈產出] 核心腳本
├── tests/
│   ├── parser.test.js          # 單元測試：字串解析、等寬判定、圖示排除、冪等性
│   ├── dom.test.js             # 整合測試：DOM 注入、CSSOM 掃描、Shadow DOM、adoptedStyleSheets
│   ├── sites.test.js           # 真實網站覆蓋測試：Cool3c、XDA、9to5Google、電腦王阿達、4gTV、UNIKO、X (Twitter)
│   └── benchmark.perf.js       # 效能基準：解析吞吐量、CSSOM 耗時、DOM 突發、記憶體洩漏
├── scripts/
│   └── check.js                # 語法正確性自動檢驗腳本
├── plan.md                     # 原始專案開發規劃書
├── README.md                   # 使用者指南、字型安裝指引與常見問題
├── AGENTS.md                   # AI Agent 維護手冊（本文件）
└── package.json                # 開發與測試依賴環境設定
```

---

## 3. 核心演算法與實作邏輯

### 3.1 字型堆疊前置引擎 (Font Stack Prepender)
解析與前置流程遵循純函數設計：
1. **防禦性過濾**：
   * 空字串或非字串直接返回。
   * CSS 保留系統關鍵字（`inherit`、`initial`、`unset`、`revert`、`revert-layer`）原樣保留，禁止破壞 CSS 繼承鏈。
2. **圖示字型排除 (Icon Font Guard)**：
   * 檢查選擇器與字型名稱是否命中 `ICON_PATTERN_REGEX`（如 `FontAwesome`, `Material Icons`, `codicon`, `octicons` 等）。
   * 命中時直接跳過，不進行任何前置。
3. **等寬識別判定 (Monospace Detection)**：
   * 命中條件 A：選擇器包含程式碼語意標籤（`code`, `pre`, `kbd`, `samp`, `tt`, `var`）或常見類別（`.monospace`, `.code`, `.highlight`）。
   * 命中條件 B：字型值中包含等寬字型關鍵字（`monospace`, `ui-monospace`, `Consolas`, `Monaco`, `Menlo`, `Courier`, `Fira Code`, `JetBrains Mono`, `Source Code Pro`, `SFMono-Regular`, `Cascadia`, `Ubuntu Mono`, `Roboto Mono` 等）或變數名稱含 `mono`/`code`。
   * 判定為等寬時前置 `"Intel One Mono", "Noto Sans Mono CJK TC", `；否則前置 `"Google Sans", "Noto Sans CJK TC", `。
4. **冪等性防重複 (Idempotency)**：
   * 透過 `isAlreadyPrepended` 檢測字串前綴是否已含有目標字型，若已存在則不再疊加。
5. **CSS 變數容錯**：
   * 遇 `var(--font-sans)` 時，直接在其前方前置 `"Google Sans", "Noto Sans CJK TC", var(--font-sans)`，語法完全合規。

### 3.2 樣式掃描與監聽
* **CSSOM 掃描**：遞迴走訪 `CSSStyleRule` 與巢狀分組規則（`@media`, `@supports`, `@container`）。
* **WeakSet 弱引用追蹤**：樣式表（`processedStyleSheets`）、ShadowRoot（`processedShadowRoots`）與抽樣元素（`processedElements`）皆使用 `WeakSet`，確保原生節點釋放時垃圾回收順暢。
* **Shadow DOM 穿透**：攔截 `Element.prototype.attachShadow`，自動在 open 模式 ShadowRoot 下掛載樣式與監聽。

---

## 4. 特例擴充指南（如何新增排除與特殊站點支援）

### 4.1 新增 `@exclude` 排除站點
若某網站因特殊排版或防護需全域排除：
1. 開啟 `src/FontPrepender.user.js` 的 Metadata Block。
2. 在 `// @exclude` 區塊追加目標 URL 匹配模式（例如 `// @exclude      *://example.com/*`）。
3. 同步更新 `README.md` 中的排除網站清單與原因。
4. 遞增 `@version` 號碼（例如 `1.0.0` -> `1.0.1`）。

### 4.2 新增特殊圖示或程式碼編輯器支援
* **擴充圖示庫特徵**：在 `src/FontPrepender.user.js` 中的 `ICON_PATTERN_REGEX` 正則表達式加入新圖示名稱關鍵字。
* **擴充編輯器選擇器**：在 `EDITOR_CONTAINER_SELECTORS` 常數追加目標容器類別（如 `.my-custom-editor`）。

---

## 5. 自動化審查與品質檢驗指令

任何程式碼更動後，必須依序執行以下檢驗指令並確保 100% 通過：

### 5.1 語法與型態檢查 (Syntax & Code Quality)
```bash
npm run check
```
* **驗收標準**：所有 JavaScript 檔案通過 Node 語法檢驗，無任何錯誤或警告。

### 5.2 單元與整合測試 (Unit & Integration Tests)
```bash
npm run test
```
* **驗收標準**：`tests/parser.test.js`、`tests/dom.test.js` 與 `tests/sites.test.js` 全部 48 項測試綠燈通過。

### 5.3 量化效能評估 (Performance Benchmark)
```bash
npm run bench
```
* **通過門檻指標**：
  1. **字串解析吞吐量**：10,000 條複雜規則解析耗時 **< 15.0 ms**。
  2. **大型 CSSOM 掃描**：2,000 條樣式規則初次掃描改寫 **< 16.6 ms**（60 FPS 幀預算內）。
  3. **突發 DOM 負載**：5,000 個動態節點變動主執行緒阻塞 **< 10.0 ms**。
  4. **記憶體防護檢測**：所有全域追蹤結構使用 `WeakSet`，零強引用洩漏。
