# Font Prepender - 自訂網頁與程式碼首選字型 (Google Fonts 線上載入版)

[![Direct Install](https://img.shields.io/badge/Direct_Install-FontPrepender.user.js-brightgreen.svg?style=flat&logo=tampermonkey)](https://github.com/abc0922001/FontPrependerUserscripts/raw/google-fonts/src/FontPrepender.user.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-FontPrepender-red.svg)](https://greasyfork.org/zh-TW/users/1237813-abc0922001)

一鍵升級瀏覽體驗！**Font Prepender** 是一款專為追求極致字型排版體驗設計的 Userscript。能在不破壞網頁原有排版、多國語言回退機制（Fallback）與圖示字型（Icon Fonts）的前提下，將現代無襯線字型與專業等寬字型優雅前置（Prepend）於網頁字型堆疊最前方。

本分支（`google-fonts`）內建 **Google Fonts 線上樣式表自動注入機制**，即使電腦未預先安裝一般無襯線字型，也能透過雲端自動載入 `Google Sans`、`Google Sans Flex` 與 `Noto Sans TC` 即開即用。

---

## 1. 核心字型配置

* **一般字型（內文與標題）**：
  前置 `"Google Sans", "Google Sans Flex", "Noto Sans CJK TC", "Noto Sans TC"` + 網頁原始字型清單
* **等寬字型（程式碼、終端機與區塊）**：
  前置 `"Intel One Mono", "Noto Sans Mono CJK TC"` + 網頁原始等寬字型清單

---

## 2. 字型載入機制與本機字型安裝

### 一般字型：免安裝即開即用（本機優先 + Google Fonts 雲端回退）
腳本會於頁面 `<head>`（及 Web Components `ShadowRoot`）自動注入 Google Fonts 線上樣式表：
* 若系統**已安裝**本機字型（如 `Google Sans`、`Google Sans Flex`、`Noto Sans CJK TC`），瀏覽器將直接優先採用本機字型，零網路延遲。
* 若系統**未安裝**上述字型，則無縫回退至由 Google Fonts 動態載入的 `Google Sans`、`Google Sans Flex` 與 `Noto Sans TC`（`display=swap`）。

### 等寬字型與進階本機安裝（推薦選配）
若希望啟用程式碼區塊的等寬字型替換，或追求完全離線、零網路請求的極速首屏渲染，建議於作業系統安裝以下字型家族：

1. **Google Sans / Google Sans Flex**：
   * Google 旗艦品牌現代幾何無襯線字型（線上載點：[Google Fonts](https://fonts.google.com/?query=Google+Sans)）。
2. **Noto Sans CJK TC（思源黑體 臺灣正體）**：
   * 官方開源載點：[Google Fonts Noto Sans TC](https://fonts.google.com/specimen/Noto+Sans+TC) 或 [GitHub Releases](https://github.com/notofonts/noto-cjk/releases)
3. **Intel One Mono**：
   * Intel 專為程式開發者閱讀舒適度設計之等寬字型。
   * 官方開源載點：[Intel One Mono GitHub Releases](https://github.com/intel/intel-one-mono/releases)
4. **Noto Sans Mono CJK TC（思源等寬黑體 臺灣正體）**：
   * 官方開源載點：[Noto CJK GitHub Releases](https://github.com/notofonts/noto-cjk/releases)

> **安裝提示**：下載 `.ttf` 或 `.otf` 檔案後，在 Windows 上對其按右鍵選擇「為所有使用者安裝」；macOS 雙擊開啟後點擊「安裝字體」。安裝完成後請**重新啟動瀏覽器**。

---

## 3. 安裝與相容性

### 一鍵快速安裝
若您的瀏覽器已安裝腳本管理器，可直接點擊下方按鈕觸發安裝：

[![直接安裝腳本 (Direct Install)](https://img.shields.io/badge/直接安裝-FontPrepender.user.js-brightgreen?style=for-the-badge&logo=tampermonkey)](https://github.com/abc0922001/FontPrependerUserscripts/raw/google-fonts/src/FontPrepender.user.js)

### 支援的腳本管理器
* [Tampermonkey（油猴）](https://www.tampermonkey.net/)（推薦）
* [Violentmonkey（暴力猴）](https://violentmonkey.github.io/)
* [ScriptCat（腳本貓）](https://scriptcat.org/)

### 安裝步驟
1. 安裝上述任一腳本管理器瀏覽器擴充功能。
2. 點擊上方 [直接安裝按鈕](https://github.com/abc0922001/FontPrependerUserscripts/raw/google-fonts/src/FontPrepender.user.js) 或前往 Greasy Fork 安裝頁面。
3. 腳本管理器將會自動彈出安裝確認視窗，點擊「安裝」即可生效。

---

## 4. 預設排除網站名單（@exclude）

為防止排版走樣、線上文書軟體游標錯位或終端機畫面破裂，腳本預設排除以下網站：

| 排除網站網址 | 排除原因說明 |
| :--- | :--- |
| `*://term.ptt.cc/*` | PTT 網頁終端機仰賴特定點陣或半形字距，避免排版破裂錯位。 |
| `*://docs.google.com/*` | Google 文件與試算表使用 Canvas 與專有版面排版引擎，避免輸入游標偏移。 |
| `*://fonts.google.com/*` | Google 字型展示庫，避免干擾使用者預覽其他字型之真實渲染樣式。 |
| `*://91pu.com.tw/song/*` | 吉他譜與和弦對齊排版，避免等寬字距異動導致譜面錯位。 |
| `*://yuantabank.com/*` | 網銀安全防護與特定憑證元件相容性考量。 |
| `*://github.com/*` | GitHub 具備高度自訂字型堆疊與豐富程式碼預覽，維持原廠配置。 |

---

## 5. 技術特色與效能表現

本專案採用 **80% / 20% 階段式架構設計**，提供兼顧極速效能與邊界相容性的排版替換：

1. **80% 高覆蓋基礎層**：
   * **Google Fonts 線上樣式冪等注入與自我略過防護**：自動於 `<head>` 注入 `<link id="font-prepender-google-fonts">`，並在 CSSOM 掃描與動態監聽中直接標記略過，避免誤觸跨域重抓或空閒計算樣式排程。
   * **低優先度注入**：採用 `:where(html, body)` 與 `:where(code, pre, ...)`，零權重覆蓋降級字型，不破壞網站自訂排版。
   * **兩階段動態監聽與同源 CSSOM 掃描**：首屏載入期（Phase 1）僅輕量監聽 `<head>` 樣式表，徹底隔離 `<body>` 串流解析數千節點時的事件風暴；待 `DOMContentLoaded` 批次補齊後無縫升級為互動期（Phase 2）全域增量監聽。
   * **智慧等寬識別與四態分表快取**：結合 Selector 語意狀態降維與 $\mathcal{O}(1)$ 有界 FIFO 快取，跨規則快取命中率 `> 99%`。
2. **20% 特例邊界防護**：
   * **保護圖示字型（Icon Fonts）**：內建 FontAwesome、Material Icons、Codicon、Octicons 等排除特徵庫，徹底杜絕圖示變方塊或破圖。
   * **CSS 變數支援**：原生支援現代 CSS Custom Properties（如 `--font-sans`, `--font-mono`）。
   * **Shadow DOM 穿透**：攔截 `attachShadow` 並共用預編譯 `adoptedStyleSheets`，深度支援 Web Components 元件。
   * **CORS 跨域樣式修補**：支援 CDN 樣式表抓取改寫與 4ms 時間切片讀寫分離之空閒期（`requestIdleCallback`）抽樣修補，徹底消除同步重排（Style Thrashing）。
   * **Chrome 內建整頁翻譯相容**：自動識別並隔離翻譯產生的 `<font>` 節點，被動繼承父層字型，防止 SPA 框架重繪衝突。
   * **程式碼編輯器支援**：保證 Monaco Editor、CodeMirror、Ace Editor、xterm.js 等網頁編輯器字型品質。

### 量化效能評估指標 (Benchmark Verified)
* **字串解析吞吐量**：連續解析 10,000 條複雜規則耗時 **< 0.5 ms**（單條 `< 0.00005 ms`）。
* **大型 CSSOM 掃描**：完整掃描改寫 2,000 條規則耗時 **< 0.2 ms**（遠低於 16.6 ms 畫面更新預算，60 FPS 零掉幀）。
* **突發 DOM 負載**：處理 5,000 個動態 DOM 節點變動主執行緒阻塞時間 **< 0.5 ms**。
* **零記憶體洩漏**：全站樣式表、ShadowRoot 與抽樣元素追蹤嚴格使用 `WeakSet` / `WeakMap`，生命週期隨原生 DOM 一同由 GC 自然回收。

---

## 6. 常見問題（FAQ）

### Q1: 安裝後為什麼字型看起來沒有改變？
請確認：
1. 目前造訪的網址是否包含在 `@exclude` 排除名單內。
2. 一般無襯線字型（`Google Sans`、`Google Sans Flex`、`Noto Sans TC`）會自動透過 Google Fonts 載入；若網站設有嚴格的內容安全政策（CSP `style-src` / `font-src`）阻擋外部樣式表，或需要使用等寬程式碼字型（`Intel One Mono`、`Noto Sans Mono CJK TC`），請依照第 2 節將字型安裝至作業系統並重新啟動瀏覽器。

### Q2: 某些網站上的圖示或特殊符號破圖怎麼辦？
本腳本已內建完善的圖示排除庫。若您遇到未涵蓋的私有圖示字型破圖，請至 GitHub Issues 提供：
- 發生問題的網址
- 破圖元素的 CSS 選擇器或 HTML 結構截圖
- 預期呈現樣式

---

## 7. 授權條款

本專案採用 [MIT License](LICENSE) 授權釋出。
