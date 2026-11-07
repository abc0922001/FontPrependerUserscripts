// ==UserScript==
// @name         Font Prepender - 自訂網頁與程式碼首選字型
// @name:zh-TW   Font Prepender - 自訂網頁與程式碼首選字型
// @namespace    https://greasyfork.org/zh-TW/users/1237813-abc0922001
// @version      1.0.3
// @description  將 Google Sans、Noto Sans CJK TC 與 Intel One Mono、Noto Sans Mono CJK TC 前置於網頁字型清單最前方，不破壞原始排版與圖示字型
// @description:zh-TW 將 Google Sans、Noto Sans CJK TC 與 Intel One Mono、Noto Sans Mono CJK TC 前置於網頁字型清單最前方，不破壞原始排版與圖示字型
// @author       abc0922001
// @match        *://*/*
// @exclude      *://term.ptt.cc/*
// @exclude      *://docs.google.com/*
// @exclude      *://fonts.google.com/*
// @exclude      *://91pu.com.tw/song/*
// @exclude      *://yuantabank.com/*
// @exclude      *://github.com/*
// @run-at       document-start
// @allFrames    true
// @grant        none
// @license      MIT
// ==/UserScript==

/**
 * FontPrepender
 * 
 * 核心功能與架構設計：
 * 1. 一般字型：前置 "Google Sans", "Noto Sans CJK TC"
 * 2. 等寬字型：前置 "Intel One Mono", "Noto Sans Mono CJK TC"
 * 3. 嚴格保護圖示字型 (Icon Fonts) 與專用區字型，避免符號破圖
 * 4. 跨域樣式表 (CORS) 雙重防護：同源改寫 + Fetch CDN 改寫注入 + 空閒期計算樣式抽樣修補
 * 5. 深度支援行內樣式 (Inline Style，含 !important) 自動掃描與動態屬性監聽
 * 6. 原型鏈深度攔截：CSSStyleSheet (insertRule, replaceSync) 與 CSSStyleDeclaration (setProperty)
 * 7. CSS 自訂變數 (--font-*) 智慧識別與前置
 * 8. 網頁程式碼編輯器 (Monaco, CodeMirror, Ace, xterm.js) 專屬樣式防護
 * 9. Shadow DOM (Web Components) 深度穿透與 adoptedStyleSheets 支援
 */
(() => {
  'use strict';

  // --- 字型配置常數 ---
  const SANS_FONTS = ['"Google Sans"', '"Google Sans Flex"', '"Noto Sans CJK TC"'];
  const MONO_FONTS = ['"Intel One Mono"', '"Noto Sans Mono CJK TC"'];

  const SANS_PREPEND_STR = `${SANS_FONTS.join(', ')}, `;
  const MONO_PREPEND_STR = `${MONO_FONTS.join(', ')}, `;

  // 基礎樣式注入字型鏈
  const BASE_SANS_STACK = `${SANS_FONTS.join(', ')}, sans-serif`;
  const BASE_MONO_STACK = `${MONO_FONTS.join(', ')}, monospace`;

  // 樣式元素識別 ID
  const BASE_STYLE_ID = 'font-prepender-base-style';
  const EDITOR_STYLE_ID = 'font-prepender-editor-style';

  // --- 規則判斷正則表達式 ---
  // 等寬選擇器特徵
  const MONO_SELECTOR_REGEX = /(?:^|[,\s>+~])(?:code|pre|kbd|samp|tt|var|\.monospace|\.code|\.highlight|\.blob-code)(?:$|[,\s.#:[])/i;

  // 等寬字型關鍵字
  const MONO_FONT_REGEX = /\b(?:monospace|ui-monospace|consolas|monaco|menlo|courier|fira\s*code|jetbrains\s*mono|source\s*code\s*pro|sfmono-regular|cascadia|inconsolata|ubuntu\s*mono|roboto\s*mono)\b/i;

  // 排除圖示與特殊字型特徵
  const ICON_PATTERN_REGEX = /icon|fa-|fontawesome|(?:^|[\s.#,>+~[:])fa[srbltd]?(?=$|[\s.#,>+~[:\]])|material-icons|material-symbols|mat-icon|gem-icon|lucide|remixicon|ri-|tabler|ti-|devicon|lumi|glyph|symbol|codicon|feather|icomoon|dashicons|octicons|fontello|ionicons|typicons|entypo|flowplayer/i;

  // 具體標準正文與中文字型特徵（排除純 generic-family 關鍵字如 sans-serif/serif）
  const SPECIFIC_TEXT_FONT_REGEX = /(?:apple\s*lihei|microsoft\s*jhenghei|noto\s*sans|pingfang|heiti|system-ui|-apple-system|blinkmacsystemfont|roboto|arial|helvetica|segoe\s*ui|ubuntu|cantarell|meiryo)/i;

  // CSS 保留系統關鍵字
  const CSS_SYSTEM_KEYWORDS_REGEX = /^(?:inherit|initial|unset|revert|revert-layer)$/i;

  // CSS 字型自訂變數特徵
  const CSS_VAR_FONT_REGEX = /^--.*(?:font|family)/i;

  // 選擇器快速特徵篩選正則（自動合併圖示與等寬選擇器特徵，用於 O(1) 快取鍵狀態正規化）
  const SELECTOR_HINT_REGEX = new RegExp(`(?:${ICON_PATTERN_REGEX.source}|${MONO_SELECTOR_REGEX.source})`, 'i');

  // 等寬語意標籤名稱正則（用於 DOM 元素 tagName O(1) 快速判定）
  const MONO_TAG_REGEX = /^(?:code|pre|kbd|samp|tt|var)$/i;

  // 程式碼編輯器常見容器選擇器
  const EDITOR_CONTAINER_SELECTORS = [
    '.monaco-editor',
    '.cm-editor',
    '.CodeMirror',
    '.ace_editor',
    '.xterm',
    '.monaco-editor .view-lines',
    '.cm-content',
    '.CodeMirror-code',
    '.ace_line'
  ].join(', ');

  // 弱引用記錄集合（防止記憶體洩漏）
  const processedStyleSheets = new WeakSet();
  const processedShadowRoots = new WeakSet();
  const processedElements = new WeakSet();
  const styleToElementMap = new WeakMap();
  const fetchedStyleSheetUrls = new Set();

  // LRU / FIFO 快取結構（O(1) 查詢，上限 1000 筆防止記憶體洩漏）
  const MAX_CACHE_SIZE = 1000;
  const fontCache = new Map();

  // 冪等性快速前綴判定正則（O(1) 時間，零字串拷貝與配置開銷）
  const ALREADY_SANS_REGEX = /^\s*['"]?\s*(?:google sans|noto sans cjk tc)/i;
  const ALREADY_MONO_REGEX = /^\s*['"]?\s*(?:intel one mono|noto sans mono cjk tc)/i;

  // 是否存在跨域樣式表標記
  let hasCorsSheets = false;
  let isIdlePatchScheduled = false;

  // 內部樣式寫入重入防護標記（避免內部 setProperty 觸發原型鏈攔截器二次解析）
  let isInternalStyleWrite = false;

  /**
   * 內部安全寫入 CSSStyleDeclaration 屬性（繞過原型鏈攔截器之重複前置計算）
   * @param {CSSStyleDeclaration} style 目標樣式宣告物件
   * @param {string} prop 屬性名稱
   * @param {string} val 屬性值
   * @param {string} [priority=''] 優先級（如 'important'）
   */
  function setStylePropertyInternal(style, prop, val, priority = '') {
    isInternalStyleWrite = true;
    try {
      style.setProperty(prop, val, priority);
    } finally {
      isInternalStyleWrite = false;
    }
  }

  /**
   * 以零陣列配置方式檢查選擇器字串是否全數由圖示特徵選擇器組成
   * @param {string} selector 選擇器字串
   * @returns {boolean} 是否全為圖示選擇器
   */
  function isAllSelectorPartsIcon(selector) {
    if (!selector || !ICON_PATTERN_REGEX.test(selector)) return false;
    let commaIdx = selector.indexOf(',');
    if (commaIdx === -1) return true;

    let start = 0;
    const len = selector.length;
    while (start < len) {
      const end = commaIdx === -1 ? len : commaIdx;
      if (!ICON_PATTERN_REGEX.test(selector.slice(start, end))) {
        return false;
      }
      if (commaIdx === -1) break;
      start = commaIdx + 1;
      commaIdx = selector.indexOf(',', start);
    }
    return true;
  }

  /**
   * 檢查是否為圖示或特殊符號字型
   * @param {string} [selector=''] 選擇器文字
   * @param {string} [fontFamily=''] 字型字串
   * @param {boolean} [precomputedAllIcons] 預先計算之選擇器全圖示標記（省略重複掃描）
   * @returns {boolean} 是否為圖示字型
   */
  function isIconFont(selector = '', fontFamily = '', precomputedAllIcons) {
    let isSpecificText = false;

    if (fontFamily) {
      if (ICON_PATTERN_REGEX.test(fontFamily)) {
        // 僅在字型包含 segoe ui symbol 時執行正則替換排除，其餘情況零配置直接判斷
        if (/segoe\s+ui\s+symbol/i.test(fontFamily)) {
          const filteredFamily = fontFamily.replace(/['"]?segoe\s+ui\s+symbol['"]?/gi, '').trim();
          if (filteredFamily && ICON_PATTERN_REGEX.test(filteredFamily)) {
            return true;
          }
          if (SPECIFIC_TEXT_FONT_REGEX.test(filteredFamily)) {
            isSpecificText = true;
          }
        } else {
          return true;
        }
      } else if (SPECIFIC_TEXT_FONT_REGEX.test(fontFamily)) {
        isSpecificText = true;
      }
    }

    // 2. 檢查選擇器特徵（若命中圖示特徵，群組選擇器需全數為圖示且無正文字型鏈）
    if (!isSpecificText) {
      const allAreIcons = precomputedAllIcons !== undefined
        ? precomputedAllIcons
        : isAllSelectorPartsIcon(selector);
      if (allAreIcons) {
        return true;
      }
    }

    return false;
  }

  /**
   * 判斷是否應歸類為等寬程式碼字型
   * @param {string} [selector=''] 選擇器文字
   * @param {string} [fontFamily=''] 字型字串
   * @param {boolean} [precomputedMonoSelector] 預先計算之等寬選擇器標記
   * @returns {boolean} 是否為等寬字型
   */
  function isMonospace(selector = '', fontFamily = '', precomputedMonoSelector) {
    const isSelectorMono = precomputedMonoSelector !== undefined
      ? precomputedMonoSelector
      : Boolean(selector && MONO_SELECTOR_REGEX.test(selector));
    if (isSelectorMono) {
      return true;
    }
    if (fontFamily && (MONO_FONT_REGEX.test(fontFamily) || /var\([^)]*(?:mono|code)/i.test(fontFamily))) {
      return true;
    }
    return false;
  }

  /**
   * 檢查字型字串是否已包含目標前置字型（冪等性防重複檢查）
   * 以錨定正規表示式進行 O(1) 前綴匹配，免除全字串替換與轉小寫之記憶體配置
   * @param {string} fontFamily 原始字型字串
   * @param {boolean} isMono 是否為等寬字型
   * @returns {boolean} 是否已前置
   */
  function isAlreadyPrepended(fontFamily, isMono) {
    if (!fontFamily) return false;
    return isMono ? ALREADY_MONO_REGEX.test(fontFamily) : ALREADY_SANS_REGEX.test(fontFamily);
  }

  /**
   * 前置字型字串處理純函數（整合選擇器語意狀態正規化與 O(1) Map 快取）
   * 將任意選擇器降維映射至 4 種語意狀態（中性 / 等寬 / 圖示 / 雙重），使跨規則快取命中率 > 99%
   * @param {string} fontFamily 原始 font-family 值
   * @param {string} [selector=''] 對應的選擇器（輔助判斷）
   * @returns {string} 前置處理後的 font-family 值
   */
  function prependFontFamily(fontFamily, selector = '') {
    if (!fontFamily || typeof fontFamily !== 'string') {
      return fontFamily;
    }

    const trimmed = fontFamily.trim();
    if (!trimmed || CSS_SYSTEM_KEYWORDS_REGEX.test(trimmed)) {
      return fontFamily;
    }

    // 選擇器語意狀態正規化：> 98% 常規選擇器不具圖示或等寬特徵，直接共用 trimmed 作為快取鍵
    let selIcon = false;
    let selMono = false;
    let cacheKey = trimmed;

    if (selector && SELECTOR_HINT_REGEX.test(selector)) {
      selIcon = isAllSelectorPartsIcon(selector);
      selMono = MONO_SELECTOR_REGEX.test(selector);
      if (selIcon || selMono) {
        cacheKey = `${selIcon ? (selMono ? 3 : 2) : 1}|${trimmed}`;
      }
    }

    // 優先查詢 O(1) 快取
    const cached = fontCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // 特例一：圖示字型排除保護
    if (isIconFont(selector, trimmed, selIcon)) {
      if (fontCache.size >= MAX_CACHE_SIZE) {
        fontCache.delete(fontCache.keys().next().value);
      }
      fontCache.set(cacheKey, fontFamily);
      return fontFamily;
    }

    // 判斷是否為等寬字型
    const mono = isMonospace(selector, trimmed, selMono);

    // 冪等性防重複檢查
    if (isAlreadyPrepended(trimmed, mono)) {
      if (fontCache.size >= MAX_CACHE_SIZE) {
        fontCache.delete(fontCache.keys().next().value);
      }
      fontCache.set(cacheKey, fontFamily);
      return fontFamily;
    }

    // 特例三：若含有 CSS 變數 var(...)，在其前方前置依然是合法 CSS 語法
    const prependStr = mono ? MONO_PREPEND_STR : SANS_PREPEND_STR;
    const result = `${prependStr}${trimmed}`;

    if (fontCache.size >= MAX_CACHE_SIZE) {
      fontCache.delete(fontCache.keys().next().value);
    }
    fontCache.set(cacheKey, result);
    return result;
  }

  /**
   * 從 CSS 原始字串之指定偏移位置逆向提取當前規則區塊的選擇器文字
   * @param {string} cssText 完整 CSS 文字
   * @param {number} offset 匹配屬性所在偏移量
   * @returns {string|null} 提取出的選擇器字串（若是 @font-face 等字型定義規則則回傳 null，若無則回傳空字串）
   */
  function extractSelectorBefore(cssText, offset) {
    if (!cssText || typeof offset !== 'number' || offset <= 0) return '';
    const openBraceIdx = cssText.lastIndexOf('{', offset);
    if (openBraceIdx === -1) return '';

    let startIdx = openBraceIdx - 1;
    while (startIdx >= 0) {
      const ch = cssText.charCodeAt(startIdx);
      // 遇到前一個規則結尾 '}' (125)、外層 '@media {' 的 '{' (123) 或 ';' (59) 時停止
      if (ch === 125 || ch === 123 || ch === 59) {
        break;
      }
      startIdx--;
    }

    const rawSelector = cssText.slice(startIdx + 1, openBraceIdx).trim();
    if (!rawSelector) return '';
    if (rawSelector.charCodeAt(0) === 64) {
      // 若為 @font-face、@font-palette-values 等字型註冊或自訂描述符，返回 null 哨兵值跳過改寫
      if (/^@font-(?:face|palette-values|feature-values)\b/i.test(rawSelector)) {
        return null;
      }
      return '';
    }
    return rawSelector;
  }

  /**
   * 改寫文字版 CSS 內容（用於跨域樣式表重新載入注入或 replaceSync）
   * @param {string} cssText 原始 CSS 文字
   * @param {string} [baseUrl=''] 基礎路徑（修復相對 url 資源）
   * @returns {string} 改寫後的 CSS 文字
   */
  function rewriteCssContent(cssText, baseUrl = '') {
    if (!cssText || typeof cssText !== 'string') return cssText;

    let result = cssText;
    // 修復相對 url(...) 路徑
    if (baseUrl && result.includes('url(')) {
      result = result.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, rawUrl) => {
        const trimmed = rawUrl.trim();
        if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#') || /^(?:https?:)?\/\//i.test(trimmed)) {
          return match;
        }
        try {
          const absUrl = new URL(trimmed, baseUrl).href;
          return `url(${quote || '"'}${absUrl}${quote || '"'})`;
        } catch {
          return match;
        }
      });
    }

    // 替換 font-family 宣告（若無關鍵字則 O(1) 短路跳過正則掃描）
    if (result.includes('font-family')) {
      result = result.replace(/font-family\s*:\s*([^;!}]+)(!important)?/gi, (match, fontVal, important, offset, fullStr) => {
        if (!fontVal) return match;
        const selector = extractSelectorBefore(fullStr, offset);
        if (selector === null) return match;
        const prepended = prependFontFamily(fontVal, selector);
        if (!prepended || prepended === fontVal) return match;
        return `font-family: ${prepended}${important ? ' !important' : ''}`;
      });
    }

    return result;
  }

  /**
   * 注入基礎層降級樣式與編輯器專屬樣式
   * @param {Document|ShadowRoot} targetRoot 注入目標根節點
   */
  function injectBaseStyles(targetRoot = document) {
    const parent = targetRoot.head || targetRoot.documentElement || targetRoot;
    if (!parent || !parent.appendChild) return;

    // 1. 注入基礎低優先度 :where 降級樣式（涵蓋常見文字區塊標籤，提供安全全站排版墊底）
    if (!parent.querySelector || !parent.querySelector(`#${BASE_STYLE_ID}`)) {
      const baseStyle = document.createElement('style');
      baseStyle.id = BASE_STYLE_ID;
      baseStyle.textContent = `
:where(html, body) {
  font-family: ${BASE_SANS_STACK};
}
:where(code, pre, kbd, samp, tt, var) {
  font-family: ${BASE_MONO_STACK};
}
:where(h1, h2, h3, h4, h5, h6, p, blockquote, q, li, dt, dd, td, th, label, summary, details) {
  font-family: ${BASE_SANS_STACK};
}
:where(input, textarea, select, button, [contenteditable="true"]) {
  font-family: ${BASE_SANS_STACK};
}
`;
      try {
        parent.appendChild(baseStyle);
        if (baseStyle.sheet) {
          processedStyleSheets.add(baseStyle.sheet);
        }
      } catch {
        // 容錯防禦
      }
    }

    // 2. 特例四：注入網頁程式碼編輯器專用等寬保證樣式
    if (!parent.querySelector || !parent.querySelector(`#${EDITOR_STYLE_ID}`)) {
      const editorStyle = document.createElement('style');
      editorStyle.id = EDITOR_STYLE_ID;
      editorStyle.textContent = `
:where(${EDITOR_CONTAINER_SELECTORS}) {
  font-family: ${BASE_MONO_STACK} !important;
}
`;
      try {
        parent.appendChild(editorStyle);
        if (editorStyle.sheet) {
          processedStyleSheets.add(editorStyle.sheet);
        }
      } catch {
        // 容錯防禦
      }
    }
  }

  /**
   * 遞迴處理 CSS 規則列表（支援媒體查詢、容器查詢與 CSS 變數）
   * @param {CSSRuleList} rules 規則列表
   * @param {boolean} [hasFontVars=true] 樣式表是否可能含有字型相關 CSS 自訂變數
   */
  function processRules(rules, hasFontVars = true) {
    if (!rules) return;
    const len = rules.length;
    for (let i = 0; i < len; i++) {
      const rule = rules[i];
      if (!rule) continue;

      // 標準樣式規則 (CSSStyleRule)
      if (rule.style && rule.selectorText) {
        // A. 處理常規 font-family
        // 若環境支援 style.fontFamily 且為空字串，直接 O(1) 短路跳過 getPropertyValue 呼叫
        const currentFont = typeof rule.style.fontFamily === 'string'
          ? (rule.style.fontFamily ? rule.style.getPropertyValue('font-family') : '')
          : rule.style.getPropertyValue('font-family');
        if (currentFont) {
          const newFont = prependFontFamily(currentFont, rule.selectorText);
          if (newFont !== currentFont) {
            const priority = rule.style.getPropertyPriority('font-family');
            setStylePropertyInternal(rule.style, 'font-family', newFont, priority);
          }
        }

        // B. 特例三：處理 CSS Custom Properties（例如 --font-sans, --code-font）
        // 由樣式表層級 hasFontVars 預篩與 rule.style.length 雙重守衛，免除 rule.style.cssText 序列化開銷
        if (hasFontVars && rule.style.length > 0) {
          const styleLen = rule.style.length;
          for (let p = 0; p < styleLen; p++) {
            const propName = rule.style[p];
            if (propName && propName.charCodeAt(0) === 45 && propName.charCodeAt(1) === 45 && CSS_VAR_FONT_REGEX.test(propName)) {
              const varVal = rule.style.getPropertyValue(propName);
              if (varVal && !CSS_SYSTEM_KEYWORDS_REGEX.test(varVal.trim())) {
                const isMonoVar = /mono|code/i.test(propName) || isMonospace('', varVal, false);
                if (!isAlreadyPrepended(varVal, isMonoVar)) {
                  const prependStr = isMonoVar ? MONO_PREPEND_STR : SANS_PREPEND_STR;
                  const newVarVal = `${prependStr}${varVal.trim()}`;
                  const varPriority = rule.style.getPropertyPriority(propName);
                  setStylePropertyInternal(rule.style, propName, newVarVal, varPriority);
                }
              }
            }
          }
        }
      }

      // 巢狀群組規則（例如 @media, @supports, @container）
      if (rule.cssRules) {
        processRules(rule.cssRules, hasFontVars);
      }

      // @import 匯入之子樣式表 (CSSImportRule)
      if (rule.styleSheet) {
        processStyleSheet(rule.styleSheet);
      }
    }
  }

  /**
   * 處理單一樣式表（CSSOM）
   * @param {CSSStyleSheet} sheet 樣式表物件
   */
  function processStyleSheet(sheet) {
    if (!sheet || processedStyleSheets.has(sheet)) {
      return;
    }

    const owner = sheet.ownerNode;
    // 自身樣式表防護：若為腳本自身注入的基礎樣式或編輯器樣式，直接加入已處理集合並跳過
    if (owner && (owner.id === BASE_STYLE_ID || owner.id === EDITOR_STYLE_ID)) {
      processedStyleSheets.add(sheet);
      return;
    }

    // 樣式表層級預篩：若為內嵌 <style> 標籤且內容完全不含字型關鍵字，O(1) 短路跳過 cssRules 走訪
    let hasFontVars = true;
    if (owner && (owner.tagName === 'STYLE' || owner.tagName === 'style') && typeof owner.textContent === 'string') {
      const sheetText = owner.textContent;
      if (!/font|family|@import/i.test(sheetText)) {
        processedStyleSheets.add(sheet);
        return;
      }
      hasFontVars = /--[\w-]*(?:font|family)/i.test(sheetText);
    }

    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      // 特例二：跨域樣式表存取拋出 SecurityError
      processedStyleSheets.add(sheet);

      // 若為外部 link 樣式表且支援 fetch，嘗試直接下載改寫注入（解決 XDA 等 CDN 外部樣式表）
      const href = sheet.href;
      if (typeof fetch === 'function' && href && !fetchedStyleSheetUrls.has(href)) {
        fetchedStyleSheetUrls.add(href);
        fetch(href)
          .then((res) => {
            if (!res || !res.ok) {
              hasCorsSheets = true;
              scheduleIdleComputedStylePatch();
              return null;
            }
            return res.text();
          })
          .then((cssText) => {
            if (!cssText || !cssText.includes('font-family')) return;
            const rewritten = rewriteCssContent(cssText, href);
            if (rewritten && rewritten !== cssText) {
              const style = document.createElement('style');
              style.setAttribute('data-prepended-source', href);
              style.textContent = rewritten;

              if (owner && owner.parentNode) {
                owner.parentNode.insertBefore(style, owner.nextSibling);
              } else {
                const parent = document.head || document.documentElement;
                if (parent) parent.appendChild(style);
              }

              if (style.sheet) {
                processedStyleSheets.add(style.sheet);
              }
            }
          })
          .catch(() => {
            // fetch 失敗時退避至空閒計算樣式修補
            hasCorsSheets = true;
            scheduleIdleComputedStylePatch();
          });
      } else {
        hasCorsSheets = true;
        scheduleIdleComputedStylePatch();
      }
      return;
    }

    if (rules) {
      processedStyleSheets.add(sheet);
      processRules(rules, hasFontVars);
    }
  }

  /**
   * 掃描處理目前所有可讀取的樣式表與 adoptedStyleSheets
   * @param {Document|ShadowRoot} docOrRoot 根節點
   */
  function scanAndPatchStyleSheets(docOrRoot = document) {
    // 1. 標準 styleSheets
    const sheets = docOrRoot.styleSheets;
    if (sheets) {
      const count = sheets.length;
      for (let i = 0; i < count; i++) {
        processStyleSheet(sheets[i]);
      }
    }

    // 2. 特例五：adoptedStyleSheets (Constructable Stylesheets)
    if (docOrRoot.adoptedStyleSheets && docOrRoot.adoptedStyleSheets.length) {
      const adopted = docOrRoot.adoptedStyleSheets;
      for (let i = 0; i < adopted.length; i++) {
        processStyleSheet(adopted[i]);
      }
    }
  }

  /**
   * 取得 DOM 元素的選擇器提示字串（若命中圖示或等寬特徵則組裝提示，否則回傳空字串）
   * @param {Element|HTMLElement} el 目標 DOM 元素
   * @returns {string} 選擇器提示字串
   */
  function getElementSelectorHint(el) {
    if (!el) return '';
    const idStr = el.id || '';
    const classStr = el.className && typeof el.className === 'string' ? el.className : '';
    const tagStr = el.tagName || '';

    if (
      (idStr && SELECTOR_HINT_REGEX.test(idStr)) ||
      (classStr && SELECTOR_HINT_REGEX.test(classStr)) ||
      (tagStr && MONO_TAG_REGEX.test(tagStr))
    ) {
      return (idStr ? `#${idStr}` : '') + (classStr ? `.${classStr.trim().replace(/\s+/g, '.')}` : '') || tagStr.toLowerCase();
    }
    return '';
  }

  /**
   * 取得 CSSStyleDeclaration 物件對應的選擇器上下文（關聯之 DOM 元素或父 CSS 規則）
   * @param {CSSStyleDeclaration} styleDecl 目標樣式宣告物件
   * @returns {string} 選擇器上下文
   */
  function getStyleContextSelector(styleDecl) {
    if (!styleDecl) return '';
    const ownerEl = styleToElementMap.get(styleDecl);
    if (ownerEl) {
      return getElementSelectorHint(ownerEl);
    }
    if (styleDecl.parentRule && styleDecl.parentRule.selectorText) {
      return styleDecl.parentRule.selectorText;
    }
    return '';
  }

  /**
   * 處理單一 DOM 元素的行內樣式 font-family（支援 !important 優先級保留）
   * 解決 UNIKO's Hardware 等 CMS 文章標題與連結直接嵌入 style="font-family: ... !important;" 的問題
   * @param {HTMLElement} el 目標 DOM 元素
   */
  function patchElementInlineStyle(el) {
    if (!el || !el.style || typeof el.style.getPropertyValue !== 'function') return;

    styleToElementMap.set(el.style, el);

    const inlineFont = el.style.getPropertyValue('font-family');
    if (!inlineFont || CSS_SYSTEM_KEYWORDS_REGEX.test(inlineFont.trim())) {
      return;
    }

    // O(1) 快速前綴檢測：若已前置則立即退出，免除選擇器特徵提取與重複前置運算
    if (ALREADY_SANS_REGEX.test(inlineFont) || ALREADY_MONO_REGEX.test(inlineFont)) {
      return;
    }

    const selectorHint = getElementSelectorHint(el);
    const newFont = prependFontFamily(inlineFont, selectorHint);
    if (newFont !== inlineFont) {
      const priority = el.style.getPropertyPriority('font-family');
      setStylePropertyInternal(el.style, 'font-family', newFont, priority);
    }
  }

  /**
   * 掃描並改寫目標根節點或局部子樹內帶有行內 font-family 樣式之元素
   * 對無子元素之葉節點以 firstElementChild O(1) 短路，避免無謂的 querySelectorAll 呼叫
   * @param {Document|Element|ShadowRoot} root 根節點或局部元素
   */
  function scanAndPatchInlineStyles(root = document) {
    if (!root) return;

    if (root.nodeType === 1) {
      if (
        (typeof root.hasAttribute !== 'function' || root.hasAttribute('style')) &&
        root.style &&
        typeof root.style.getPropertyValue === 'function' &&
        root.style.getPropertyValue('font-family')
      ) {
        patchElementInlineStyle(root);
      }
      // 葉節點 O(1) 短路：無任何子元素時直接返回
      if ('firstElementChild' in root && !root.firstElementChild) {
        return;
      }
    } else if (root.style && root.style.getPropertyValue && root.style.getPropertyValue('font-family')) {
      patchElementInlineStyle(root);
    }

    if (typeof root.querySelectorAll !== 'function') return;

    try {
      const inlineElements = root.querySelectorAll('[style*="font-family" i]');
      const len = inlineElements.length;
      for (let i = 0; i < len; i++) {
        patchElementInlineStyle(inlineElements[i]);
      }
    } catch {
      try {
        const fallbackEls = root.querySelectorAll('[style]');
        const len = fallbackEls.length;
        for (let i = 0; i < len; i++) {
          patchElementInlineStyle(fallbackEls[i]);
        }
      } catch {
        // 容錯防禦
      }
    }
  }

  /**
   * 特例二：針對含有跨域樣式表的頁面，在主執行緒空閒時進行計算樣式抽樣修補
   * 採用「兩階段讀寫分離（Batch Read -> Batch Write）」，消除迴圈內讀寫交錯造成的強制同步重排 (Style Thrashing)
   */
  function patchComputedStyles() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    // 涵蓋全階層標題 (h1-h6)、文章卡片、標題容器、連結、內文、代碼塊與文章後設資料 (日期、作者、時間標籤)
    const sampleTargets = document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], [class*="card"] a, [class*="post"] a, main, article, section, header, p, code, pre, [class*="content"], [class*="editor"], time, [class*="date"], [class*="meta"], [class*="author"], [class*="byline"], [class*="time"], [class*="published"]'
    );

    const totalLen = sampleTargets.length;
    let sampledCount = 0;
    const pendingWrites = [];

    // 第一階段（Batch Read）：純讀取 getComputedStyle 並收集待修補節點，期間零 DOM 樣式寫入
    for (let i = 0; i < totalLen && sampledCount < 500; i++) {
      const el = sampleTargets[i];
      if (!el || processedElements.has(el)) continue;
      processedElements.add(el);
      sampledCount++;

      try {
        const computed = window.getComputedStyle(el);
        const computedFont = computed ? computed.fontFamily : '';
        if (computedFont && !CSS_SYSTEM_KEYWORDS_REGEX.test(computedFont)) {
          const isMono = el.matches ? (
            el.matches('code, pre, kbd, samp, tt, var, .monospace, .code, .xterm') ||
            MONO_FONT_REGEX.test(computedFont)
          ) : false;

          // 優先以 O(1) 前綴檢查是否已前置，命中時提早跳過免除選擇器特徵提取與重複運算
          if (isAlreadyPrepended(computedFont, isMono)) {
            continue;
          }

          const idStr = el.id || '';
          const classStr = el.className && typeof el.className === 'string' ? el.className : '';
          let selectorHint = '';
          if ((idStr && ICON_PATTERN_REGEX.test(idStr)) || (classStr && ICON_PATTERN_REGEX.test(classStr))) {
            selectorHint = (idStr ? `#${idStr}` : '') + (classStr ? `.${classStr.trim().replace(/\s+/g, '.')}` : '');
          }

          if (!isIconFont(selectorHint, computedFont)) {
            const targetFont = `${isMono ? MONO_PREPEND_STR : SANS_PREPEND_STR}${computedFont}`;
            pendingWrites.push({ el, targetFont });

            // 若父容器為標題或元數據容器且包含 a、span、time 標籤，同步將內部文字節點加入批次寫入佇列（排除內嵌圖示節點）
            const isContainer = el.matches ? el.matches('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], [class*="card"], [class*="post"], [class*="meta"], [class*="byline"]') : true;
            if (isContainer) {
              const childElements = el.querySelectorAll ? el.querySelectorAll('a, span, time') : null;
              if (childElements && childElements.length) {
                for (let c = 0; c < childElements.length; c++) {
                  const child = childElements[c];
                  if (child && !processedElements.has(child)) {
                    processedElements.add(child);
                    const childId = child.id || '';
                    const childClass = child.className && typeof child.className === 'string' ? child.className : '';
                    if ((childId && ICON_PATTERN_REGEX.test(childId)) || (childClass && ICON_PATTERN_REGEX.test(childClass))) {
                      continue;
                    }
                    pendingWrites.push({ el: child, targetFont });
                  }
                }
              }
            }
          }
        }
      } catch {
        // 容錯防禦
      }
    }

    // 第二階段（Batch Write）：一次性批次寫入所有樣式變更，使瀏覽器僅需單次樣式樹重算
    const writeLen = pendingWrites.length;
    for (let i = 0; i < writeLen; i++) {
      const item = pendingWrites[i];
      if (item.el && item.el.style) {
        setStylePropertyInternal(item.el.style, 'font-family', item.targetFont, 'important');
      }
    }
  }

  /**
   * 排程空閒時間執行計算樣式修補（僅在存在無法同源改寫之跨域樣式表時啟動）
   */
  function scheduleIdleComputedStylePatch() {
    if (!hasCorsSheets || isIdlePatchScheduled || typeof window === 'undefined') return;
    isIdlePatchScheduled = true;

    const runner = () => {
      isIdlePatchScheduled = false;
      patchComputedStyles();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runner, { timeout: 1500 });
    } else if (typeof setTimeout === 'function') {
      setTimeout(runner, 120);
    } else {
      runner();
    }
  }

  /**
   * 處理單一 ShadowRoot（注入基礎樣式、掃描既有樣式表與行內樣式，並掛載監聽器）
   * @param {ShadowRoot} shadowRoot 目標 ShadowRoot 節點
   */
  function processShadowRoot(shadowRoot) {
    if (!shadowRoot || processedShadowRoots.has(shadowRoot)) return;
    processedShadowRoots.add(shadowRoot);
    try {
      injectBaseStyles(shadowRoot);
      scanAndPatchStyleSheets(shadowRoot);
      scanAndPatchInlineStyles(shadowRoot);
      observeStyleSheets(shadowRoot);
      scanAndPatchShadowRoots(shadowRoot);
    } catch {
      // 防禦性容錯
    }
  }

  /**
   * 穿透掃描目標節點或子樹內包含之 Declarative Shadow DOM 與既有 ShadowRoot
   * @param {Document|Element|ShadowRoot} root 目標根節點
   */
  function scanAndPatchShadowRoots(root = document) {
    if (!root) return;
    if (root.shadowRoot) {
      processShadowRoot(root.shadowRoot);
    }
    if (typeof root.querySelectorAll !== 'function') return;
    try {
      const hosts = root.querySelectorAll('*');
      const len = hosts.length;
      for (let i = 0; i < len; i++) {
        const el = hosts[i];
        if (el && el.shadowRoot) {
          processShadowRoot(el.shadowRoot);
        }
      }
    } catch {
      // 容錯防禦
    }
  }

  /**
   * 特例五：攔截 Element.prototype.attachShadow 支援 Web Components
   */
  function hookShadowDOM() {
    if (typeof Element === 'undefined' || !Element.prototype || !Element.prototype.attachShadow) {
      return;
    }

    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(initOptions) {
      const shadowRoot = originalAttachShadow.call(this, initOptions);
      if (shadowRoot && initOptions && initOptions.mode === 'open') {
        processShadowRoot(shadowRoot);
      }
      return shadowRoot;
    };
  }

  /**
   * 原型鏈 API 攔截層：攔截動態 insertRule, replaceSync 與 CSSStyleDeclaration.setProperty
   * 確保 CSS-in-JS 與動態腳本產生的字型樣式第一時間被前置
   */
  function hookCSSPrototypes() {
    // 0. 攔截 HTMLElement.prototype.style getter 以建立 style 物件與 DOM 元素的弱引用關聯
    try {
      const proto = (typeof HTMLElement !== 'undefined' && HTMLElement.prototype) ||
                    (typeof window !== 'undefined' && window.HTMLElement && window.HTMLElement.prototype) ||
                    (typeof Element !== 'undefined' && Element.prototype);
      if (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'style');
        if (desc && desc.get) {
          const origStyleGet = desc.get;
          Object.defineProperty(proto, 'style', {
            get: function() {
              const s = origStyleGet.call(this);
              if (s && typeof s === 'object') {
                styleToElementMap.set(s, this);
              }
              return s;
            },
            configurable: true,
            enumerable: true
          });
        }
      }
    } catch {
      // 容錯防禦
    }

    // 1. 攔截 CSSStyleDeclaration.prototype.setProperty
    try {
      if (typeof CSSStyleDeclaration !== 'undefined' && CSSStyleDeclaration.prototype.setProperty) {
        const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function(prop, val, priority) {
          if (!isInternalStyleWrite && prop === 'font-family' && typeof val === 'string' && val) {
            const selectorContext = getStyleContextSelector(this);
            const prepended = prependFontFamily(val, selectorContext);
            if (prepended) val = prepended;
          }
          return origSetProperty.call(this, prop, val, priority);
        };
      }
    } catch {
      // 容錯防禦
    }

    // 2. 攔截 CSSStyleDeclaration.prototype.fontFamily setter
    try {
      let styleProto = typeof CSSStyleDeclaration !== 'undefined' ? CSSStyleDeclaration.prototype : null;
      if (typeof document !== 'undefined' && document.createElement) {
        const dummy = document.createElement('div');
        if (dummy.style) {
          let curr = Object.getPrototypeOf(dummy.style);
          while (curr && curr !== Object.prototype) {
            if (Object.getOwnPropertyDescriptor(curr, 'fontFamily')) {
              styleProto = curr;
              break;
            }
            curr = Object.getPrototypeOf(curr);
          }
        }
      }

      if (styleProto) {
        const desc = Object.getOwnPropertyDescriptor(styleProto, 'fontFamily');
        if (desc && desc.set) {
          const origSet = desc.set;
          Object.defineProperty(styleProto, 'fontFamily', {
            get: desc.get,
            set: function(val) {
              if (!isInternalStyleWrite && typeof val === 'string' && val) {
                const selectorContext = getStyleContextSelector(this);
                const prepended = prependFontFamily(val, selectorContext);
                if (prepended) val = prepended;
              }
              return origSet.call(this, val);
            },
            configurable: true,
            enumerable: true
          });
        }
      }
    } catch {
      // 容錯防禦
    }

    // 3. 攔截 CSSStyleSheet.prototype.insertRule
    try {
      if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.insertRule) {
        const origInsertRule = CSSStyleSheet.prototype.insertRule;
        CSSStyleSheet.prototype.insertRule = function(ruleText, index) {
          if (typeof ruleText === 'string' && ruleText.includes('font-family')) {
            try {
              ruleText = rewriteCssContent(ruleText);
            } catch {
              // 容錯防禦
            }
          }
          return origInsertRule.call(this, ruleText, index);
        };
      }
    } catch {
      // 容錯防禦
    }

    // 4. 攔截 CSSStyleSheet.prototype.replaceSync
    try {
      if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replaceSync) {
        const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
        CSSStyleSheet.prototype.replaceSync = function(text) {
          if (typeof text === 'string' && text.includes('font-family')) {
            try {
              text = rewriteCssContent(text);
            } catch {
              // 容錯防禦
            }
          }
          return origReplaceSync.call(this, text);
        };
      }
    } catch {
      // 容錯防禦
    }

    // 5. 攔截 CSSStyleSheet.prototype.replace (非同步 Constructable Stylesheet)
    try {
      if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replace) {
        const origReplace = CSSStyleSheet.prototype.replace;
        CSSStyleSheet.prototype.replace = function(text) {
          if (typeof text === 'string' && text.includes('font-family')) {
            try {
              text = rewriteCssContent(text);
            } catch {
              // 容錯防禦
            }
          }
          return origReplace.call(this, text);
        };
      }
    } catch {
      // 容錯防禦
    }
  }

  /**
   * 監聽樣式表動態插入與載入事件、行內樣式屬性變更
   * @param {Document|ShadowRoot} targetDoc 目標文件或根節點
   */
  function observeStyleSheets(targetDoc = document) {
    const targetNode = targetDoc.documentElement || targetDoc;
    if (!targetNode || typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      let shouldScanStylesheets = false;
      let hasAddedElements = false;

      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];

        // 1. 監聽行內 style 屬性動態變更
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          patchElementInlineStyle(mutation.target);
        } else if (mutation.type === 'childList') {
          const added = mutation.addedNodes;
          const addedLen = added.length;
          for (let j = 0; j < addedLen; j++) {
            const node = added[j];
            if (!node || node.nodeType !== 1) continue;
            const tagName = node.tagName;

            if (node.shadowRoot) {
              processShadowRoot(node.shadowRoot);
            }

            if (tagName === 'STYLE' || tagName === 'style') {
              if (node.sheet) {
                processStyleSheet(node.sheet);
              } else {
                shouldScanStylesheets = true;
              }
            } else if ((tagName === 'LINK' || tagName === 'link') && node.rel === 'stylesheet') {
              if (node.sheet) {
                processStyleSheet(node.sheet);
              } else if (typeof node.addEventListener === 'function') {
                node.addEventListener('load', () => {
                  if (node.sheet) processStyleSheet(node.sheet);
                }, { once: true });
              }
            } else {
              hasAddedElements = true;
              const isDocLoading = (targetDoc.ownerDocument || targetDoc).readyState === 'loading';
              if (isDocLoading) {
                // 首屏 HTML 解析期：原生串流解析器會逐一派發節點，僅做 O(1) 自身單節點行內樣式檢查，避免子樹重複遍歷
                if (
                  (typeof node.hasAttribute !== 'function' || node.hasAttribute('style')) &&
                  node.style &&
                  typeof node.style.getPropertyValue === 'function' &&
                  node.style.getPropertyValue('font-family')
                ) {
                  patchElementInlineStyle(node);
                }
              } else {
                // 互動期（SPA 動態渲染）：增量掃描新增之局部子樹（葉節點 O(1) 短路，容器子樹 O(ΔN)）
                scanAndPatchInlineStyles(node);
                scanAndPatchShadowRoots(node);
                if (node.firstElementChild && typeof node.querySelectorAll === 'function') {
                  const nestedStyles = node.querySelectorAll('style, link[rel="stylesheet"]');
                  const nestedLen = nestedStyles.length;
                  for (let k = 0; k < nestedLen; k++) {
                    const styleNode = nestedStyles[k];
                    if (styleNode.sheet) {
                      processStyleSheet(styleNode.sheet);
                    } else if ((styleNode.tagName === 'LINK' || styleNode.tagName === 'link') && typeof styleNode.addEventListener === 'function') {
                      styleNode.addEventListener('load', () => {
                        if (styleNode.sheet) processStyleSheet(styleNode.sheet);
                      }, { once: true });
                    } else {
                      shouldScanStylesheets = true;
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (shouldScanStylesheets) {
        scanAndPatchStyleSheets(targetDoc);
      }
      if (hasAddedElements && hasCorsSheets) {
        scheduleIdleComputedStylePatch();
      }
    });

    observer.observe(targetNode, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style']
    });
  }

  // --- 初始化流程 ---
  function init() {
    if (typeof document === 'undefined') return;

    // 1. 原型鏈深度攔截
    hookCSSPrototypes();

    // 2. 攔截 Shadow DOM
    hookShadowDOM();

    // 3. 注入基礎降級層與程式碼編輯器樣式
    injectBaseStyles(document);

    // 4. 靜態同源 CSSOM 掃描
    scanAndPatchStyleSheets(document);

    // 5. 掃描行內樣式與 Declarative Shadow DOM (若已進入 DOMContentLoaded 之後則立即執行，loading 期間留待 DOMContentLoaded 統一執行)
    if (document.readyState !== 'loading') {
      scanAndPatchInlineStyles(document);
      scanAndPatchShadowRoots(document);
    }

    // 6. 監聽動態樣式注入與行內樣式變更
    observeStyleSheets(document);

    // 7. 若在 DOMContentLoaded 或 load 事件發生前載入，註冊生命週期鉤子再次掃描
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        injectBaseStyles(document);
        scanAndPatchStyleSheets(document);
        scanAndPatchInlineStyles(document);
        scanAndPatchShadowRoots(document);
        if (hasCorsSheets) {
          scheduleIdleComputedStylePatch();
        }
      }, { once: true });
    }

    // 8. window load 完成後若存在跨域樣式表，執行一次 computed style patch
    if (typeof window !== 'undefined') {
      window.addEventListener('load', () => {
        if (hasCorsSheets) {
          scheduleIdleComputedStylePatch();
        }
      }, { once: true });
    }
  }

  if (typeof document !== 'undefined') {
    init();
  }

  // --- 供單元測試獨立引用（不污染 Userscript 瀏覽器環境）---
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SANS_FONTS,
      MONO_FONTS,
      SANS_PREPEND_STR,
      MONO_PREPEND_STR,
      BASE_SANS_STACK,
      BASE_MONO_STACK,
      processedStyleSheets,
      isIconFont,
      isMonospace,
      isAlreadyPrepended,
      prependFontFamily,
      rewriteCssContent,
      injectBaseStyles,
      processStyleSheet,
      processRules,
      scanAndPatchStyleSheets,
      patchElementInlineStyle,
      scanAndPatchInlineStyles,
      patchComputedStyles,
      scheduleIdleComputedStylePatch,
      getHasCorsSheets: () => hasCorsSheets,
      hookShadowDOM,
      processShadowRoot,
      scanAndPatchShadowRoots,
      hookCSSPrototypes,
      observeStyleSheets,
      init
    };
  }
})();
