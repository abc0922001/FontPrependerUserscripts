# Font Prepender - 自訂網頁與程式碼首選字型

[![Direct Install](https://img.shields.io/badge/Direct_Install-FontPrepender.user.js-brightgreen.svg?style=flat&logo=tampermonkey)](https://github.com/abc0922001/FontPrependerUserscripts/raw/main/src/FontPrepender.user.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-FontPrepender-red.svg)](https://greasyfork.org/zh-TW/users/1237813-abc0922001)

一鍵升級瀏覽體驗！**Font Prepender** 是一款專為追求極致字型排版體驗設計的 Userscript。能在不破壞網頁原有排版、多國語言回退機制（Fallback）與圖示字型（Icon Fonts）的前提下，將你喜愛的現代無襯線字型與專業等寬字型優雅前置（Prepend）於網頁字型堆疊最前方。

---

## 1. 核心字型配置

* **一般字型（內文與標題）**：
  前置 `"Google Sans", "Noto Sans CJK TC"` + 網頁原始字型清單
* **等寬字型（程式碼、終端機與區塊）**：
  前置 `"Intel One Mono", "Noto Sans Mono CJK TC"` + 網頁原始等寬字型清單

---

## 2. 前置需求：字型安裝

本腳本透過 CSS 指定本機字型名稱。為確保瀏覽器能正確渲染目標字型，請先於作業系統安裝以下字型家族：

1. **Google Sans**：
   * Google 旗艦品牌現代幾何無襯線字型。
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

[![直接安裝腳本 (Direct Install)](https://img.shields.io/badge/直接安裝-FontPrepender.user.js-brightgreen?style=for-the-badge&logo=tampermonkey)](https://github.com/abc0922001/FontPrependerUserscripts/raw/main/src/FontPrepender.user.js)

### 支援的腳本管理器
* [Tampermonkey（油猴）](https://www.tampermonkey.net/)（推薦）
* [Violentmonkey（暴力猴）](https://violentmonkey.github.io/)
* [ScriptCat（腳本貓）](https://scriptcat.org/)

### 安裝步驟
1. 安裝上述任一腳本管理器瀏覽器擴充功能。
2. 點擊上方 [直接安裝按鈕](https://github.com/abc0922001/FontPrependerUserscripts/raw/main/src/FontPrepender.user.js) 或前往 Greasy Fork 安裝頁面。
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
   * **低優先度注入**：採用 `:where(html, body)` 與 `:where(code, pre, ...)`，零權重覆蓋降級字型，不破壞網站自訂排版。
   * **同源 CSSOM 掃描**：直接改寫樣式規則，配合 MutationObserver 即時監聽動態載入之樣式表。
   * **智慧等寬識別**：結合 Selector 特徵與字型堆疊關鍵字，自動判定程式碼區塊。
2. **20% 特例邊界防護**：
   * **保護圖示字型（Icon Fonts）**：內建 FontAwesome、Material Icons、Codicon、Octicons 等排除特徵庫，徹底杜絕圖示變方塊或破圖。
   * **CSS 變數支援**：原生支援現代 CSS Custom Properties（如 `--font-sans`, `--font-mono`）。
   * **Shadow DOM 穿透**：攔截 `attachShadow` 並支援 `adoptedStyleSheets`，深度支援 Web Components 元件。
   * **CORS 跨域樣式修補**：安全攔截跨域錯誤，於空閒時間（`requestIdleCallback`）輕量修補。
   * **程式碼編輯器支援**：保證 Monaco Editor、CodeMirror、Ace Editor 等網頁編輯器字型品質。

### 量化效能評估指標 (Benchmark Verified)
* **字串解析吞吐量**：連續解析 10,000 條複雜規則僅耗時 **~5.5 ms**（單條 < 0.0006 ms）。
* **大型 CSSOM 掃描**：完整掃描 2,000 條規則僅耗時 **~2.5 ms**（遠低於 16.6 ms 畫面更新預算，60 FPS 零掉幀）。
* **突發 DOM 負載**：處理 5,000 個 DOM 節點變動主執行緒阻塞時間 **< 0.3 ms**。
* **零記憶體洩漏**：全站快取與節點記錄嚴格使用 `WeakSet`，生命週期隨原生 DOM 一同被 GC 自動釋放。

---

## 6. 常見問題（FAQ）

### Q1: 安裝後為什麼字型看起來沒有改變？
請確認：
1. 你的作業系統是否已下載並安裝所列的四款字型。
2. 安裝字型後是否已將瀏覽器完整關閉並重新啟動。
3. 目前造訪的網址是否包含在 `@exclude` 排除名單內。

### Q2: 某些網站上的圖示或特殊符號破圖怎麼辦？
本腳本已內建完善的圖示排除庫。若您遇到未涵蓋的私有圖示字型破圖，請至 GitHub Issues 提供：
- 發生問題的網址
- 破圖元素的 CSS 選擇器或 HTML 結構截圖
- 預期呈現樣式

---

## 7. 授權條款

本專案採用 [MIT License](LICENSE) 授權釋出。
