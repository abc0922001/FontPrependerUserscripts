# FontPrepender Google Fonts 分支開發計畫 (`plans/google-fonts-branch.md`)

## Context

建立獨立的 Git 分支（供發佈至 Greasy Fork 使用），透過注入 Google Fonts 樣式表：
`https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,1..1000&family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&family=Noto+Sans+TC:wght@100..900&display=swap`
解決使用者電腦未預先安裝字型時無法生效的問題，並將所有改動高度模組化集中於常數與注入層，確保未來從 `main` 分支執行 `git merge main` 時幾乎零衝突。

---

## Approach

### 1. 最小化未來 `git merge main` 衝突之架構設計
* **先行於 `main` 分支解耦測試常數**（可選／推薦）：
  * 目前 `tests/parser.test.js` 與 `tests/dom.test.js` 有少數斷言寫死了 `'"Google Sans", "Noto Sans CJK TC"'` 字串（而 `tests/sites.test.js` 則是動態引用匯出的 `SANS_PREPEND_STR`）。
  * 若先在 `main` 將測試改為引用 `SANS_PREPEND_STR` 與 `BASE_SANS_STACK`，再切出新分支，兩分支的 `tests/` 將完全一致，未來 `git merge main` 時測試檔案 **0 衝突**。
* **在 `src/FontPrepender.user.js` 集中差異點**：
  * 僅修改頂部常數區塊（`SANS_FONTS`、`GOOGLE_FONTS_URL`、`GOOGLE_FONTS_LINK_ID`）與 `injectBaseStyles` 中的 `<link rel="stylesheet">` 注入邏輯，不動動到底層解析與監聽演算法。

### 2. Google Fonts 樣式注入與字型配置機制
* **分支名稱**：`google-fonts`
* **一般字型優先順序 (`SANS_FONTS`)**：
  ```javascript
  const SANS_FONTS = ['"Google Sans"', '"Google Sans Flex"', '"Noto Sans CJK TC"', '"Noto Sans TC"'];
  ```
  * 優先使用系統本地安裝的字型（含 `"Noto Sans CJK TC"`），若電腦未安裝字型，則無縫回退至由 Google Fonts 動態載入的 `"Google Sans"`、`"Google Sans Flex"` 與 `"Noto Sans TC"`。
* **冪等檢查正則 (`ALREADY_SANS_REGEX`)**：
  * 同步擴充為 `/^\s*['"]?\s*(?:google sans(?: flex)?|noto sans(?: cjk)? tc)/i`，維持 $\mathcal{O}(1)$ 前綴檢測。
* **Google Fonts `<link>` 注入與自身排除保護**：
  * 常數定義：
    ```javascript
    const GOOGLE_FONTS_LINK_ID = 'font-prepender-google-fonts';
    const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,1..1000&family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&family=Noto+Sans+TC:wght@100..900&display=swap';
    ```
  * 於 `injectBaseStyles(targetRoot)` 中，若未存在 `#${GOOGLE_FONTS_LINK_ID}`，則建立 `<link id="font-prepender-google-fonts" rel="stylesheet" href="...">` 掛載至 `<head>`（或 ShadowRoot）。
  * 在 `processStyleSheet(sheet)` 與 `observeStyleSheets` 中，若 `sheet.ownerNode` 的 `id === GOOGLE_FONTS_LINK_ID`（或 `node.id === GOOGLE_FONTS_LINK_ID`），直接將其標記至 `processedStyleSheets` 並略過，避免因跨域讀取 Google Fonts `@font-face` 樣式表而誤觸 `hasCorsSheets` 或重複 `fetch`。

---

## Files to Modify

* `src/FontPrepender.user.js` — 更新 `SANS_FONTS` 清單、新增 `GOOGLE_FONTS_URL` 常數與 `<link>` 自動注入邏輯（並確保不誤觸 `hasCorsSheets`）。
* `tests/parser.test.js`、`tests/dom.test.js` — 改以匯出常數 `SANS_PREPEND_STR` / `BASE_SANS_STACK` 驗證，消除分支間測試硬編碼差異。

---

## Reuse

* 重用 `src/FontPrepender.user.js` 現有的 `SANS_FONTS.join(', ')` 衍生常數鏈（`SANS_PREPEND_STR`、`BASE_SANS_STACK`），一處修改自動套用至全腳本。
* 重用 `injectBaseStyles` 的幂等 ID 檢查機制與 `processedStyleSheets` (`WeakSet`)，將注入之 Google Fonts `<link>` 標記為無須重寫，防止觸發 CORS `fetch` 重抓。

---

## Steps

- [ ] **Step 1**：先於 `main` 分支將 `tests/parser.test.js` 與 `tests/dom.test.js` 中寫死的 `'"Google Sans", "Noto Sans CJK TC"'` 斷言改為動態引用匯出的 `SANS_PREPEND_STR` 與 `BASE_SANS_STACK` 並提交，確保未來 `main` merge 至 `google-fonts` 分支時測試檔零衝突。
- [ ] **Step 2**：自 `main` 切出新分支 `google-fonts`，在 `src/FontPrepender.user.js` 更新 `SANS_FONTS` 為 `['"Google Sans"', '"Google Sans Flex"', '"Noto Sans CJK TC"', '"Noto Sans TC"']`、更新 `ALREADY_SANS_REGEX`，並於 `injectBaseStyles` 加入 Google Fonts `<link>` 冪等注入與 `processStyleSheet` / `observeStyleSheets` 略過保護。
- [ ] **Step 3**：在 `tests/dom.test.js` 新增驗證 `<link id="font-prepender-google-fonts">` 注入正確性之測試，執行 `npm run check`、`npm run test`、`npm run bench` 驗證 100% 通過後完成本地 Commit。

---

## Verification

1. `npm run check`：語法檢查 100% 通過。
2. `npm run test`：驗證 `<head>` 正確注入 Google Fonts `<link>` 且 `SANS_FONTS` 依指定順序前置，全數測試通過。
3. `npm run bench`：效能基準測試全數通過。
4. 模擬 `git merge main` 驗證無衝突。
