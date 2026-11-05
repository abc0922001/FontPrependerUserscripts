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
 * 核心功能：
 * 1. 一般字型：前置 "Google Sans", "Noto Sans CJK TC"
 * 2. 等寬字型：前置 "Intel One Mono", "Noto Sans Mono CJK TC"
 * 3. 嚴格保護圖示字型 (Icon Fonts) 與專用區字型，避免符號破圖
 * 4. 支援同源 CSSOM 動態掃描、Shadow DOM、CSS 變數與網頁編輯器
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

  // 基礎樣式元素 ID
  const BASE_STYLE_ID = 'font-prepender-base-style';

  // --- 規則判斷正則表達式 ---
  // 等寬選擇器特徵
  const MONO_SELECTOR_REGEX = /(?:^|[,\s>+~])(?:code|pre|kbd|samp|tt|var|\.monospace|\.code|\.highlight|\.blob-code)(?:$|[,\s.#:[])/i;

  // 等寬字型關鍵字
  const MONO_FONT_REGEX = /\b(?:monospace|ui-monospace|consolas|monaco|menlo|courier|fira\s*code|jetbrains\s*mono|source\s*code\s*pro|sfmono-regular|cascadia|inconsolata|ubuntu\s*mono|roboto\s*mono)\b/i;

  // 排除圖示與特殊字型特徵
  const ICON_PATTERN_REGEX = /icon|fa-|fontawesome|material|glyph|symbol|codicon|feather|icomoon|dashicons|octicons/i;

  // CSS 保留系統關鍵字
  const CSS_SYSTEM_KEYWORDS_REGEX = /^(?:inherit|initial|unset|revert|revert-layer)$/i;

  // 已處理樣式表記錄（弱引用避免記憶體洩漏）
  const processedStyleSheets = new WeakSet();

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
    if (fontFamily && ICON_PATTERN_REGEX.test(fontFamily)) {
      return true;
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
    if (fontFamily && MONO_FONT_REGEX.test(fontFamily)) {
      return true;
    }
    return false;
  }

  /**
   * 檢查字型字串是否已包含目標前置字型（冪等性檢查）
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

    // 檢查是否為圖示字型，若是則原樣保留
    if (isIconFont(selector, trimmed)) {
      return fontFamily;
    }

    // 判斷是否為等寬字型
    const mono = isMonospace(selector, trimmed);

    // 冪等性防重複檢查
    if (isAlreadyPrepended(trimmed, mono)) {
      return fontFamily;
    }

    // 根據類別前置指定字型
    const prependStr = mono ? MONO_PREPEND_STR : SANS_PREPEND_STR;
    return `${prependStr}${trimmed}`;
  }

  /**
   * 注入基礎層降級樣式（低優先度 :where 選擇器）
   * @param {Document|ShadowRoot} targetRoot 注入目標根節點
   */
  function injectBaseStyles(targetRoot = document) {
    const parent = targetRoot.head || targetRoot.documentElement || targetRoot;
    if (!parent) return;

    if (parent.querySelector && parent.querySelector(`#${BASE_STYLE_ID}`)) {
      return;
    }

    const style = document.createElement('style');
    style.id = BASE_STYLE_ID;
    style.textContent = `
:where(html, body) {
  font-family: ${BASE_SANS_STACK};
}
:where(code, pre, kbd, samp, tt, var) {
  font-family: ${BASE_MONO_STACK};
}
`;
    try {
      parent.appendChild(style);
    } catch {
      // 容錯防禦：部分受限 DOM 結構可能拒絕插入節點
    }
  }

  /**
   * 遞迴處理 CSS 規則列表（支援媒體查詢、容器查詢等巢狀規則）
   * @param {CSSRuleList} rules 規則列表
   */
  function processRules(rules) {
    if (!rules) return;
    const len = rules.length;
    for (let i = 0; i < len; i++) {
      const rule = rules[i];
      if (!rule) continue;

      // 標準樣式規則
      if (rule.style && rule.selectorText) {
        const currentFont = rule.style.getPropertyValue('font-family');
        if (currentFont) {
          const newFont = prependFontFamily(currentFont, rule.selectorText);
          if (newFont !== currentFont) {
            const priority = rule.style.getPropertyPriority('font-family');
            rule.style.setProperty('font-family', newFont, priority);
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
      // 跨域樣式表存取限制 (SecurityError)，留待特例修補模組處理
      return;
    }

    if (rules) {
      processedStyleSheets.add(sheet);
      processRules(rules);
    }
  }

  /**
   * 掃描處理目前所有可讀取的同源樣式表
   * @param {Document|ShadowRoot} docOrRoot 根節點
   */
  function scanAndPatchStyleSheets(docOrRoot = document) {
    const sheets = docOrRoot.styleSheets;
    if (!sheets) return;
    const count = sheets.length;
    for (let i = 0; i < count; i++) {
      processStyleSheet(sheets[i]);
    }
  }

  /**
   * 監聽樣式表動態插入與載入事件
   * @param {Document|ShadowRoot} targetDoc 目標文件或根節點
   */
  function observeStyleSheets(targetDoc = document) {
    const targetNode = targetDoc.documentElement || targetDoc;
    if (!targetNode || typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        if (mutation.type === 'childList') {
          for (let j = 0; j < mutation.addedNodes.length; j++) {
            const node = mutation.addedNodes[j];
            if (node.nodeType !== 1) continue;
            const tagName = node.tagName.toLowerCase();
            if (tagName === 'style') {
              shouldScan = true;
            } else if (tagName === 'link' && node.rel === 'stylesheet') {
              node.addEventListener('load', () => {
                if (node.sheet) processStyleSheet(node.sheet);
              }, { once: true });
            }
          }
        }
      }
      if (shouldScan) {
        scanAndPatchStyleSheets(targetDoc);
      }
    });

    observer.observe(targetNode, {
      childList: true,
      subtree: true
    });
  }

  // --- 初始化流程 ---
  function init() {
    if (typeof document === 'undefined') return;

    // 1. 注入基礎降級層
    injectBaseStyles(document);

    // 2. 靜態同源 CSSOM 掃描
    scanAndPatchStyleSheets(document);

    // 3. 監聽動態樣式注入
    observeStyleSheets(document);

    // 4. 若在 DOMContentLoaded 或 load 事件發生前載入，註冊生命週期鉤子再次掃描
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        injectBaseStyles(document);
        scanAndPatchStyleSheets(document);
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
      injectBaseStyles,
      processStyleSheet,
      processRules,
      scanAndPatchStyleSheets,
      observeStyleSheets,
      init
    };
  }
})();
