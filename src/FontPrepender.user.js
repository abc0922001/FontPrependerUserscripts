// ==UserScript==
// @name         Font Prepender - 自訂網頁與程式碼首選字型
// @name:zh-TW   Font Prepender - 自訂網頁與程式碼首選字型
// @namespace    https://greasyfork.org/zh-TW/users/1237813-abc0922001
// @version      1.0.0
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
  const SANS_FONTS = ['"Google Sans"', '"Noto Sans CJK TC"'];
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
  const ICON_PATTERN_REGEX = /icon|fa-|fontawesome|material-icons|material-symbols|glyph|symbol|codicon|feather|icomoon|dashicons|octicons|fontello|ionicons|typicons|entypo|flowplayer/i;

  // CSS 保留系統關鍵字
  const CSS_SYSTEM_KEYWORDS_REGEX = /^(?:inherit|initial|unset|revert|revert-layer)$/i;

  // CSS 字型自訂變數特徵
  const CSS_VAR_FONT_REGEX = /^--.*(?:font|family)/i;

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
  const fetchedStyleSheetUrls = new Set();

  // 是否存在跨域樣式表標記
  let hasCorsSheets = false;
  let isIdlePatchScheduled = false;

  /**
   * 檢查是否為圖示或特殊符號字型
   * @param {string} [selector=''] 選擇器文字
   * @param {string} [fontFamily=''] 字型字串
   * @returns {boolean} 是否為圖示字型
   */
  function isIconFont(selector = '', fontFamily = '') {
    if (selector && ICON_PATTERN_REGEX.test(selector)) {
      return true;
    }
    if (fontFamily) {
      // 容錯防禦：過濾現代系統字型鏈末端常見之 "Segoe UI Symbol" 符號降級，避免誤判為純圖示字型
      const filteredFamily = fontFamily.replace(/['"]?segoe\s+ui\s+symbol['"]?/gi, '');
      if (ICON_PATTERN_REGEX.test(filteredFamily)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 判斷是否應歸類為等寬程式碼字型
   * @param {string} [selector=''] 選擇器文字
   * @param {string} [fontFamily=''] 字型字串
   * @returns {boolean} 是否為等寬字型
   */
  function isMonospace(selector = '', fontFamily = '') {
    if (selector && MONO_SELECTOR_REGEX.test(selector)) {
      return true;
    }
    if (fontFamily && (MONO_FONT_REGEX.test(fontFamily) || /var\([^)]*(?:mono|code)/i.test(fontFamily))) {
      return true;
    }
    return false;
  }

  /**
   * 檢查字型字串是否已包含目標前置字型（冪等性防重複檢查）
   * @param {string} fontFamily 原始字型字串
   * @param {boolean} isMono 是否為等寬字型
   * @returns {boolean} 是否已前置
   */
  function isAlreadyPrepended(fontFamily, isMono) {
    if (!fontFamily) return false;
    const cleanStr = fontFamily.replace(/['"]/g, '').trim().toLowerCase();
    if (isMono) {
      return cleanStr.startsWith('intel one mono') || cleanStr.startsWith('noto sans mono cjk tc');
    }
    return cleanStr.startsWith('google sans') || cleanStr.startsWith('noto sans cjk tc');
  }

  /**
   * 前置字型字串處理純函數
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

    // 特例一：圖示字型排除保護
    if (isIconFont(selector, trimmed)) {
      return fontFamily;
    }

    // 判斷是否為等寬字型
    const mono = isMonospace(selector, trimmed);

    // 冪等性防重複檢查
    if (isAlreadyPrepended(trimmed, mono)) {
      return fontFamily;
    }

    // 特例三：若含有 CSS 變數 var(...)，在其前方前置依然是合法 CSS 語法
    const prependStr = mono ? MONO_PREPEND_STR : SANS_PREPEND_STR;
    return `${prependStr}${trimmed}`;
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

    // 替換 font-family 宣告
    result = result.replace(/font-family\s*:\s*([^;!}]+)(!important)?/gi, (match, fontVal, important) => {
      if (!fontVal) return match;
      const prepended = prependFontFamily(fontVal);
      if (!prepended || prepended === fontVal) return match;
      return `font-family: ${prepended}${important ? ' !important' : ''}`;
    });

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
`;
      try {
        parent.appendChild(baseStyle);
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
      } catch {
        // 容錯防禦
      }
    }
  }

  /**
   * 遞迴處理 CSS 規則列表（支援媒體查詢、容器查詢與 CSS 變數）
   * @param {CSSRuleList} rules 規則列表
   */
  function processRules(rules) {
    if (!rules) return;
    const len = rules.length;
    for (let i = 0; i < len; i++) {
      const rule = rules[i];
      if (!rule) continue;

      // 標準樣式規則 (CSSStyleRule)
      if (rule.style && rule.selectorText) {
        // A. 處理常規 font-family
        const currentFont = rule.style.getPropertyValue('font-family');
        if (currentFont) {
          const newFont = prependFontFamily(currentFont, rule.selectorText);
          if (newFont !== currentFont) {
            const priority = rule.style.getPropertyPriority('font-family');
            rule.style.setProperty('font-family', newFont, priority);
          }
        }

        // B. 特例三：處理 CSS Custom Properties（例如 --font-sans, --code-font）
        if (rule.style.length) {
          for (let p = 0; p < rule.style.length; p++) {
            const propName = rule.style[p];
            if (propName && propName.startsWith('--') && CSS_VAR_FONT_REGEX.test(propName)) {
              const varVal = rule.style.getPropertyValue(propName);
              if (varVal && !CSS_SYSTEM_KEYWORDS_REGEX.test(varVal.trim())) {
                const isMonoVar = /mono|code/i.test(propName) || isMonospace('', varVal);
                if (!isAlreadyPrepended(varVal, isMonoVar)) {
                  const prependStr = isMonoVar ? MONO_PREPEND_STR : SANS_PREPEND_STR;
                  const newVarVal = `${prependStr}${varVal.trim()}`;
                  const varPriority = rule.style.getPropertyPriority(propName);
                  rule.style.setProperty(propName, newVarVal, varPriority);
                }
              }
            }
          }
        }
      }

      // 巢狀群組規則（例如 @media, @supports, @container）
      if (rule.cssRules) {
        processRules(rule.cssRules);
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

    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      // 特例二：跨域樣式表存取拋出 SecurityError
      hasCorsSheets = true;
      processedStyleSheets.add(sheet);

      // 若為外部 link 樣式表且支援 fetch，嘗試直接下載改寫注入（解決 XDA 等 CDN 外部樣式表）
      const href = sheet.href;
      const owner = sheet.ownerNode;
      if (typeof fetch === 'function' && href && !fetchedStyleSheetUrls.has(href)) {
        fetchedStyleSheetUrls.add(href);
        fetch(href)
          .then((res) => (res.ok ? res.text() : null))
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
            scheduleIdleComputedStylePatch();
          });
      } else {
        scheduleIdleComputedStylePatch();
      }
      return;
    }

    if (rules) {
      processedStyleSheets.add(sheet);
      processRules(rules);
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
   * 處理單一 DOM 元素的行內樣式 font-family（支援 !important 優先級保留）
   * 解決 UNIKO's Hardware 等 CMS 文章標題與連結直接嵌入 style="font-family: ... !important;" 的問題
   * @param {HTMLElement} el 目標 DOM 元素
   */
  function patchElementInlineStyle(el) {
    if (!el || !el.style || typeof el.style.getPropertyValue !== 'function') return;

    const inlineFont = el.style.getPropertyValue('font-family');
    if (!inlineFont || CSS_SYSTEM_KEYWORDS_REGEX.test(inlineFont.trim())) {
      return;
    }

    const selectorHint = (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : '') || (el.tagName ? el.tagName.toLowerCase() : '');
    if (isIconFont(selectorHint, inlineFont)) {
      return;
    }

    const isMono = el.matches ? (
      el.matches('code, pre, kbd, samp, tt, var, .monospace, .code, .xterm') ||
      MONO_FONT_REGEX.test(inlineFont)
    ) : false;

    if (isAlreadyPrepended(inlineFont, isMono)) {
      return;
    }

    const newFont = prependFontFamily(inlineFont, selectorHint);
    if (newFont !== inlineFont) {
      const priority = el.style.getPropertyPriority('font-family');
      el.style.setProperty('font-family', newFont, priority);
    }
  }

  /**
   * 掃描並改寫所有帶有行內 font-family 樣式之元素
   * @param {Document|Element|ShadowRoot} root 根節點
   */
  function scanAndPatchInlineStyles(root = document) {
    if (!root) return;

    // 若目標節點本身包含行內樣式
    if (root.style && root.style.getPropertyValue && root.style.getPropertyValue('font-family')) {
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
   * 涵蓋 h1-h6、文章標題卡片（如 XDA）、連結與正文區塊
   */
  function patchComputedStyles() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    // 涵蓋全階層標題 (h1-h6)、文章卡片、標題容器、連結、內文與列表
    const sampleTargets = document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], [class*="card"] a, [class*="post"] a, main, article, section, header, p, code, pre, [class*="content"], [class*="editor"]'
    );

    const count = Math.min(sampleTargets.length, 300);
    for (let i = 0; i < count; i++) {
      const el = sampleTargets[i];
      if (!el || processedElements.has(el)) continue;
      processedElements.add(el);

      try {
        const computed = window.getComputedStyle(el);
        const computedFont = computed ? computed.fontFamily : '';
        if (computedFont && !CSS_SYSTEM_KEYWORDS_REGEX.test(computedFont)) {
          const isMono = el.matches ? (
            el.matches('code, pre, kbd, samp, tt, var, .monospace, .code, .xterm') ||
            MONO_FONT_REGEX.test(computedFont)
          ) : false;

          const selectorHint = (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : '') || (el.tagName ? el.tagName.toLowerCase() : '');

          if (!isAlreadyPrepended(computedFont, isMono) && !isIconFont(selectorHint, computedFont)) {
            const prependStr = isMono ? MONO_PREPEND_STR : SANS_PREPEND_STR;
            el.style.setProperty('font-family', `${prependStr}${computedFont}`, 'important');

            // 若父容器為標題且包含 a 標籤，同步確保 a 標籤不被其他預設樣式覆蓋
            const childLink = el.querySelector ? el.querySelector('a') : null;
            if (childLink && !processedElements.has(childLink)) {
              processedElements.add(childLink);
              childLink.style.setProperty('font-family', `${prependStr}${computedFont}`, 'important');
            }
          }
        }
      } catch {
        // 容錯防禦
      }
    }
  }

  /**
   * 排程空閒時間執行計算樣式修補
   */
  function scheduleIdleComputedStylePatch() {
    if (isIdlePatchScheduled || typeof window === 'undefined') return;
    isIdlePatchScheduled = true;

    const runner = () => {
      isIdlePatchScheduled = false;
      patchComputedStyles();
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runner, { timeout: 1500 });
    } else {
      setTimeout(runner, 120);
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
        if (!processedShadowRoots.has(shadowRoot)) {
          processedShadowRoots.add(shadowRoot);
          try {
            injectBaseStyles(shadowRoot);
            scanAndPatchStyleSheets(shadowRoot);
            scanAndPatchInlineStyles(shadowRoot);
            observeStyleSheets(shadowRoot);
          } catch {
            // 防禦性容錯
          }
        }
      }
      return shadowRoot;
    };
  }

  /**
   * 原型鏈 API 攔截層：攔截動態 insertRule, replaceSync 與 CSSStyleDeclaration.setProperty
   * 確保 CSS-in-JS 與動態腳本產生的字型樣式第一時間被前置
   */
  function hookCSSPrototypes() {
    // 1. 攔截 CSSStyleDeclaration.prototype.setProperty
    try {
      if (typeof CSSStyleDeclaration !== 'undefined' && CSSStyleDeclaration.prototype.setProperty) {
        const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function(prop, val, priority) {
          if (prop === 'font-family' && typeof val === 'string' && val) {
            const prepended = prependFontFamily(val);
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
      if (typeof CSSStyleDeclaration !== 'undefined') {
        const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'fontFamily');
        if (desc && desc.set) {
          const origSet = desc.set;
          Object.defineProperty(CSSStyleDeclaration.prototype, 'fontFamily', {
            get: desc.get,
            set: function(val) {
              if (typeof val === 'string' && val) {
                const prepended = prependFontFamily(val);
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
      let shouldScanInline = false;

      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];

        // 1. 監聽行內 style 屬性動態變更
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          patchElementInlineStyle(mutation.target);
        } else if (mutation.type === 'childList') {
          for (let j = 0; j < mutation.addedNodes.length; j++) {
            const node = mutation.addedNodes[j];
            if (node.nodeType !== 1) continue;
            const tagName = node.tagName.toLowerCase();

            if (tagName === 'style') {
              shouldScanStylesheets = true;
            } else if (tagName === 'link' && node.rel === 'stylesheet') {
              node.addEventListener('load', () => {
                if (node.sheet) processStyleSheet(node.sheet);
              }, { once: true });
            } else {
              // 檢查新節點是否包含行內 style 元素
              shouldScanInline = true;
            }
          }
        }
      }

      if (shouldScanStylesheets) {
        scanAndPatchStyleSheets(targetDoc);
      }
      if (shouldScanInline) {
        scanAndPatchInlineStyles(targetDoc);
        if (hasCorsSheets) {
          scheduleIdleComputedStylePatch();
        }
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

    // 5. 掃描行內樣式 (解決 UNIKO's Hardware 等 CMS 文章行內樣式覆寫)
    scanAndPatchInlineStyles(document);

    // 6. 監聽動態樣式注入與行內樣式變更
    observeStyleSheets(document);

    // 7. 若在 DOMContentLoaded 或 load 事件發生前載入，註冊生命週期鉤子再次掃描
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        injectBaseStyles(document);
        scanAndPatchStyleSheets(document);
        scanAndPatchInlineStyles(document);
        if (hasCorsSheets) {
          scheduleIdleComputedStylePatch();
        }
      }, { once: true });
    }

    // 8. window load 完成後若有 CORS 樣式表，執行一次 computed style patch
    if (typeof window !== 'undefined') {
      window.addEventListener('load', () => {
        scanAndPatchInlineStyles(document);
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
      hookShadowDOM,
      hookCSSPrototypes,
      observeStyleSheets,
      init
    };
  }
})();
