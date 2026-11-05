# FontPrepender 專案開發規劃書 (`plan.md`)

## 1. 專案概述與核心目標
本專案旨在開發一款符合 **Greasy Fork** 規範的高效能 Userscript（使用者腳本），目標是在不破壞網頁原始排版、Fallback 機制與圖示字型（Icon Fonts）的前提下，將使用者指定的字型前置（Prepend）於網頁原有的 `font-family` 設定最前方。

### 核心字型配置
* **一般字型（預設與非等寬）**：`"Google Sans", "Noto Sans CJK TC"` + 網頁原始字型清單
* **等寬與程式碼字型（Monospace / Code）**：`"Intel One Mono", "Noto Sans Mono CJK TC"` + 網頁原始等寬字型清單

---

## 2. 專案目錄結構與檔案規範
專案嚴格保持職責分離，確保發佈至 Greasy Fork 的腳本純淨且易於審查：

```text
.
├── src/
│   └── FontPrepender.user.js   # [核心產出] 僅包含 Userscript 程式碼、Metadata 與詳細註解
├── tests/
│   ├── parser.test.js          # 字型字串解析、分類與前置邏輯之單元測試
│   ├── dom.test.js             # DOM / CSSOM 與特例情境之整合測試
│   └── benchmark.perf.js       # 完整效能評估與壓力測試腳本
├── plan.md                     # 專案開發規劃書（本文件）
├── README.md                   # 給一般使用者的安裝、字型準備與常見問題說明
├── AGENTS.md                   # 給 AI Agent 的架構設計、開發規範與交接文件
└── package.json                # 測試與效能評估環境設定（不影響 src/ 獨立運作）
```

> **關鍵限制**：`src/FontPrepender.user.js` 必須為單一、無壓縮、無混淆之原生 JavaScript 檔案，**只放腳本程式碼與註解**，不得混入測試框架程式碼或外部打包工具的 Runtime 雜訊。

---

## 3. Greasy Fork 規範合規設計
根據 Greasy Fork 官方規範與作者帳號資訊，腳本將採納以下設計標準：

1. **Metadata Block 標頭規範**：
   * `@name` / `@name:zh-TW`：明確標示腳本名稱（例如：`Font Prepender - 自訂網頁與程式碼首選字型`）。
   * `@namespace`：綁定作者專屬空間 `https://greasyfork.org/zh-TW/users/1237813-abc0922001`。
   * `@version`：遵循語意化版本格式（如 `1.0.0`），每次程式碼變更皆須遞增。
   * `@description` / `@description:zh-TW`：清楚描述腳本將 `"Google Sans", "Noto Sans CJK TC"` 與 `"Intel One Mono", "Noto Sans Mono CJK TC"` 前置於網頁字型清單的行為，不做描述外的隱密操作。
   * `@author`：`abc0922001`
   * `@match`：`*://*/*`
   * `@exclude`：依據需求避開特定網站，防止版面破裂、線上文件渲染衝突或文字終端機錯位：
     ```javascript
     // @exclude      *://term.ptt.cc/*
     // @exclude      *://docs.google.com/*
     // @exclude      *://fonts.google.com/*
     // @exclude      *://91pu.com.tw/song/*
     // @exclude      *://yuantabank.com/*
     // @exclude      *://github.com/*
     ```
   * `@run-at`：`document-start`（確保儘早介入樣式載入，避免字型閃爍 FOUT）。
   * `@grant`：`none`（優先使用原生 API 降低權限要求；若跨域樣式表特例需介入再評估是否最小化引入權限）。
   * `@license`：`MIT`
2. **程式碼品質與安全規範**：
   * 禁止任何形式的混淆（Obfuscation）或最小化（Minification），保留完整變數名稱、排版縮排與正體中文註解。
   * 零外部執行碼依賴（不使用未經授權的 `@require` 或動態注入外部 `<script>`）。
   * 檔案大小遠低於 $2\text{ MB}$ 上限，並將換行符號統一為 Unix 風格（`LF`）。

---

## 4. 技術架構：$80\% / 20\%$ 階段式解決方案

### 第一階段：解決 $80\%$ 常見網頁（高覆蓋率、極低效能開銷）
大多數現代網站透過以下三種途徑決定字型：瀏覽器預設字型、同源（Same-Origin）`<style>` / `<link>` 樣式表中的 `font-family` 規則，以及標準語意化標籤。

1. **基礎層注入（Base Fallback Injection）**：
   * 針對未明確指定 `font-family`、依賴瀏覽器預設字型的元素，於 `<head>` 注入基礎樣式：
     * `html, body` 設定為 `"Google Sans", "Noto Sans CJK TC", sans-serif`（低優先度 `:where(html, body)`，避免覆蓋子元素自訂字型）。
     * 程式碼語意標籤 `:where(code, pre, kbd, samp, tt, var)` 設定為 `"Intel One Mono", "Noto Sans Mono CJK TC", monospace`。
2. **純函數與字型字串解析器（Font Stack Parser & Prepender）**：
   * **防重複機制（Idempotency）**：檢查字型清單是否已包含目標字型，確保不會重複前置。
   * **等寬字型智慧識別**：
     * 條件 A：CSS Selector 明確針對 `code`, `pre`, `kbd`, `samp`, `tt`, `.monospace`, `.code` 等程式碼元素。
     * 條件 B：`font-family` 值中包含常見等寬字型關鍵字（如 `monospace`, `ui-monospace`, `Consolas`, `Monaco`, `Menlo`, `Courier`, `Fira Code`, `JetBrains Mono`, `Source Code Pro`, `SFMono-Regular`, `Cascadia`, `Inconsolata`, `Ubuntu Mono`, `Roboto Mono` 等）。
     * 符合上述任一條件時，前置 `"Intel One Mono", "Noto Sans Mono CJK TC", `；否則前置 `"Google Sans", "Noto Sans CJK TC", `。
   * **`!important` 與 `font` 簡寫屬性保留**：正確解析並保留原始規則的 `important` 優先權標記。
3. **同源 CSSOM 靜態與動態規則改寫**：
   * 掃描 `document.styleSheets` 中可存取的 `CSSStyleRule`，直接就地改寫（In-place Prepend）含有 `font-family` 的宣告。
   * 透過輕量級 `MutationObserver` 監聽 `<head>` 與文件根節點新增的 `<style>` 或 `<link rel="stylesheet">` 節點，在樣式表載入完成（`load` 事件）後立即套用相同改寫邏輯。

---

### 第二階段：解決 $20\%$ 特例網頁（邊界防禦與複雜架構處理）
針對第一階段無法涵蓋或容易產生副作用的特殊網站進行精準補強：

1. **特例一：保護圖示字型（Icon Fonts）與特殊符號字型**：
   * **問題**：若將一般字型前置於 FontAwesome、Material Icons 或 VS Code Codicons 前方，或因權重干擾，可能導致部分字元回退異常或渲染破圖。
   * **對策**：建立排除特徵庫（正則匹配 `/icon|fa-|fontawesome|material|glyph|symbol|codicon|feather|icomoon|dashicons|Octicons/i`），當 Selector 或 `font-family` 名稱命中圖示字型特徵，或僅包含專用區字型時，直接跳過不修改。
2. **特例二：跨域樣式表（CORS Stylesheets）與計算樣式修補**：
   * **問題**：外部 CDN 引入的 `<link rel="stylesheet">` 若未設定 CORS，讀取 `sheet.cssRules` 會拋出 `SecurityError`。
   * **對策**：使用 `try...catch` 捕捉跨域錯誤。針對含有跨域樣式表的頁面，啟用「計算樣式抽樣修補（Computed Style Patching）」：在主執行緒空閒時（`requestIdleCallback`）掃描可見區塊之代表性容器或自訂字型元素，透過 `window.getComputedStyle(el).fontFamily` 取得實際生效的字型鏈，並以 CSS Custom Properties 或輕量級類別將前置後的字型鏈寫回。
3. **特例三：CSS 變數（CSS Custom Properties）字型定義**：
   * **問題**：現代框架（如 Tailwind CSS、Bootstrap 5、GitHub Primer 等）常在 `:root` 使用 `--font-sans`、`--font-mono` 等變數定義字型，並在元件中使用 `font-family: var(--font-sans)`。
   * **對策**：
     * 若 `font-family` 包含 `var(...)`，直接在其前方前置目標字型（例如 `"Google Sans", "Noto Sans CJK TC", var(--font-sans)`）依然符合合法 CSS 語法。
     * 同時檢測 `:root` / `body` 中常見字型變數（名稱符合 `/^--.*font/i` 且值為字型堆疊），直接前置對應的一般或等寬字型。
4. **特例四：網頁版程式碼編輯器與終端機（Monaco / CodeMirror / Ace / xterm.js）**：
   * **問題**：VS Code Web、LeetCode、CodePen 等網站的編輯器常透過行內樣式（Inline Styles）或專屬變數動態指定等寬字型（註：已全域排除 GitHub、term.ptt.cc，其餘編輯器站點仍維持支援）。
   * **對策**：針對 `.monaco-editor`, `.cm-editor`, `.CodeMirror`, `.ace_editor`, `.xterm` 等常見容器與行內樣式建立專用規則與屬性監聽，確保強制前置 `"Intel One Mono", "Noto Sans Mono CJK TC"`。
5. **特例五：Shadow DOM（Web Components）封裝元件**：
   * **問題**：YouTube、部分 Web Components 使用 Shadow DOM，外部 `document.styleSheets` 無法穿透。
   * **對策**：攔截 `Element.prototype.attachShadow`，當開啟 `open` 模式的 Shadow Root 建立時，自動掛載基礎字型樣式並監聽其內部的 `<style>` 與 `adoptedStyleSheets`。

---

## 5. 腳本審查：單元測試與完整效能評估規範

為確保腳本品質達到生產環境標準，必須建立自動化測試與量化效能基準：

### 5.1 單元測試計畫（Unit Testing）
使用測試框架（如 Vitest + JSDOM）針對腳本核心邏輯進行獨立驗證（透過條件匯出或 AST 載入 `src/FontPrepender.user.js`，確保不污染腳本原始碼）：
1. **一般字型前置測試**：驗證 `"Arial", sans-serif` 正確轉為 `"Google Sans", "Noto Sans CJK TC", "Arial", sans-serif`。
2. **等寬字型識別與前置測試**：驗證 `"Fira Code", monospace` 或 `pre, code` 選擇器正確前置 `"Intel One Mono", "Noto Sans Mono CJK TC"`。
3. **冪等性測試（Idempotency）**：對同一個字串或規則執行 $2$ 次以上處理，結果必須與執行 $1$ 次完全相同，不得重複疊加。
4. **圖示字型排除測試**：驗證 `"Font Awesome 6 Free"`、`Material Icons`、`codicon` 等完全原封不動保留。
5. **特殊語法容錯測試**：驗證空字串、`inherit`、`initial`、`unset`、含 `var(--custom-font)` 以及複合引號格式皆能安全處理。
6. **DOM / Shadow DOM 整合測試**：驗證動態插入 `<style>`、行內 `style` 變更及 `attachShadow` 時的攔截正確性。

### 5.2 完整效能評估計畫（Performance Evaluation）
建立 `tests/benchmark.perf.js` 進行量化基準測試，所有指標必須通過以下門檻方可發佈：
1. **字串解析吞吐量（Parser Throughput）**：
   * 連續解析並轉換 $10,000$ 條複雜 `font-family` 規則，總耗時必須 $< 15\text{ ms}$（平均單條 $< 0.0015\text{ ms}$）。
2. **大型 CSSOM 掃描耗時（Cold Start Budget）**：
   * 模擬包含 $2,000$ 條 CSS Rules 的大型網頁樣式表，初次完整掃描與改寫耗時必須控制在單一畫面更新週期內（$< 16.6\text{ ms}$，即 $60\text{ FPS}$ 不掉幀）。
3. **動態 DOM 突發負載測試（Mutation Burst Overhead）**：
   * 模擬 SPA 網頁瞬間插入 $5,000$ 個 DOM 節點，驗證 `MutationObserver` 的防抖（Debounce）/ 節流與批次處理機制，主執行緒阻塞時間（Total Blocking Time）必須 $< 10\text{ ms}$。
4. **記憶體洩漏檢測（Memory Footprint）**：
   * 確保使用 `WeakSet` / `WeakMap` 記錄已處理的 `CSSStyleSheet`、DOM 節點與 Shadow Root，避免強引用造成垃圾回收（GC）無法釋放記憶體。

---

## 6. 開發里程碑與 `git-commit` 工作流規範

> ### ⚠️ Git 操作重要守則（CRITICAL）
> 1. 每完成下方一個開發里程碑（需求節點），開發者或 AI Agent **必須立即呼叫 `git-commit` 技能** 進行本地版本提交。
> 2. **Commit Message 必須使用正體中文**，清楚描述該階段完成的具體內容。
> 3. **嚴禁執行 `git push`**：所有變更僅保留在本地倉庫，禁止向遠端儲存庫推送任何 Commit。

| 階段 | 對應需求 | 開發項目與驗收內容 | 完成後執行動作（使用 `git-commit` 技能） |
| :--- | :--- | :--- | :--- |
| **Milestone 1** | 專案規劃與環境初始化 | 建立 `plan.md`、基礎專案目錄結構（`src/`, `tests/`）與測試環境設定。 | 呼叫 `git-commit` 技能（**嚴禁 push**）<br>範例訊息：`docs: 建立專案開發規劃書與初始化測試環境` |
| **Milestone 2** | 需求 5、6<br>Greasy Fork 規範與腳本骨架 | 建立 `src/FontPrepender.user.js`，撰寫包含 6 個 `@exclude` 站點之 Metadata Block、IIFE 結構與正體中文註解。 | 呼叫 `git-commit` 技能（**嚴禁 push**）<br>範例訊息：`feat: 建立符合 Greasy Fork 規範的腳本骨架與排除網站名單` |
| **Milestone 3** | 需求 1、2、3 (Part A)<br>解決 $80\%$ 常見網頁核心功能 | 於 `src/FontPrepender.user.js` 實作一般字型（`"Google Sans", "Noto Sans CJK TC"`）與等寬字型（`"Intel One Mono", "Noto Sans Mono CJK TC"`）解析前置引擎、基礎樣式注入與同源 CSSOM 掃描。 | 呼叫 `git-commit` 技能（**嚴禁 push**）<br>範例訊息：`feat: 實作 80% 常見網頁的一般與等寬字型前置核心邏輯` |
| **Milestone 4** | 需求 3 (Part B)<br>解決 $20\%$ 特例網頁邊界情況 | 於 `src/FontPrepender.user.js` 補齊 Icon Fonts 排除、CSS 變數處理、跨域樣式表退避修補、網頁程式碼編輯器（Monaco/CodeMirror）及 Shadow DOM 支援。 | 呼叫 `git-commit` 技能（**嚴禁 push**）<br>範例訊息：`feat: 實作圖示字型排除、Shadow DOM 與程式碼編輯器等 20% 特例支援` |
| **Milestone 5** | 需求 4<br>單元測試與完整效能評估 | 撰寫 `tests/parser.test.js`、`tests/dom.test.js` 與 `tests/benchmark.perf.js`，執行測試並根據效能數據最佳化 `src/FontPrepender.user.js`（確保該檔僅保留腳本與註解）。 | 呼叫 `git-commit` 技能（**嚴禁 push**）<br>範例訊息：`test: 新增字型解析單元測試與完整效能評估基準腳本` |
| **Milestone 6** | 需求 7<br>使用者與 AI Agent 文件撰寫 | 撰寫給使用者看的 `README.md`（功能介紹、排除網站說明、字型安裝指引）與給 AI Agent 看的 `AGENTS.md`（架構設計、禁止 git push 守則、提交流程）。 | 呼叫 `git-commit` 技能（**嚴禁 push**）<br>範例訊息：`docs: 撰寫 README 使用者說明與 AGENTS 交接文件` |

---

## 7. 文件內容規劃（`README.md` 與 `AGENTS.md`）

### 7.1 `README.md`（給使用者的說明文件）
* **功能簡介**：說明本腳本如何將 `"Google Sans"`、`"Noto Sans CJK TC"` 與 `"Intel One Mono"`、`"Noto Sans Mono CJK TC"` 優雅地前置於網頁字型最前方，同時保留網站原有的多國語言回退與圖示字型。
* **排除網站清單**：列出預設排除的網站（`term.ptt.cc`、`docs.google.com`、`fonts.google.com`、`91pu.com.tw/song/*`、`yuantabank.com`、`github.com`）並說明原因（防止排版走樣或編輯衝突）。
* **前置需求**：提供上述四款字型的官方下載連結與安裝說明（提醒使用者需先於作業系統安裝字型，瀏覽器才能正確渲染）。
* **安裝方式**：提供 Greasy Fork 安裝步驟與支援的腳本管理器（Tampermonkey、Violentmonkey、ScriptCat）。
* **技術特色與效能表現**：展示 $80/20$ 架構設計與實測效能數據（例如毫秒級啟動、零記憶體洩漏）。
* **常見問題（FAQ）**：說明遇到特定網站需要回報時的提供資訊。

### 7.2 `AGENTS.md`（給 AI Agent 的交接文件）
* **專案核心約束**：
  * 強調 `src/FontPrepender.user.js` 必須維持單一純淨檔案（僅含腳本與註解）、嚴禁混淆壓縮、遵守 Greasy Fork 條款。
  * **Git 操作紀律**：完成每個階段需求時使用 `git-commit` 技能並以正體中文撰寫 commit message，**嚴禁執行任何 `git push` 行為**。
* **核心演算法說明**：詳述字型堆疊解析器的狀態機／正則邏輯、等寬字型判定準則，以及圖示字型白名單／黑名單維護方式。
* **特例擴充指南**：教導後續接手的 AI Agent 如何新增特定網站的排除規則或特例支援。
* **自動化審查指令**：列出執行單元測試與效能基準測試的標準指令與通過門檻。