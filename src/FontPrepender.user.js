// ==UserScript==
// @name         Font Prepender - 自訂網頁與程式碼首選字型
// @name:zh-TW   Font Prepender - 自訂網頁與程式碼首選字型
// @namespace    https://greasyfork.org/zh-TW/users/1237813-abc0922001
// @version      1.0.5
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

  // --- 零成本條件式剖析器 (Profiling Infrastructure - Issue #2 Task 0) ---
  const PROFILE = (() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('fp-profile') === '1';
    } catch {
      return false;
    }
  })();
  const prof = PROFILE ? { t: Object.create(null), n: Object.create(null) } : null;
  const wrap = (name, fn) => {
    if (!PROFILE) return fn;
    return function(...args) {
      const start = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        prof.t[name] = (prof.t[name] || 0) + (performance.now() - start);
        prof.n[name] = (prof.n[name] || 0) + 1;
      }
    };
  };
  if (PROFILE && typeof window !== 'undefined') {
    window.__fpProf = prof;
  }

  // --- 字型配置常數 ---
  const SANS_FONTS = ['"Google Sans"', '"Google Sans Flex"', '"Noto Sans CJK TC"', '"Noto Sans TC"'];
  const MONO_FONTS = ['"Intel One Mono"', '"Noto Sans Mono CJK TC"'];

  const SANS_PREPEND_STR = `${SANS_FONTS.join(', ')}, `;
  const MONO_PREPEND_STR = `${MONO_FONTS.join(', ')}, `;

  // 基礎樣式注入字型鏈
  const BASE_SANS_STACK = `${SANS_FONTS.join(', ')}, sans-serif`;
  const BASE_MONO_STACK = `${MONO_FONTS.join(', ')}, monospace`;

  // Google Fonts 線上字型注入常數
  const GOOGLE_FONTS_LINK_ID = 'font-prepender-google-fonts';
  const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,1..1000&family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&family=Noto+Sans+TC:wght@100..900&display=swap';

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

  // 字型家族字串專用圖示特徵正則（不含選擇器組合子與正向前瞻，大幅加速字型名稱冷解析）
  const ICON_FONT_FAMILY_REGEX = /icon|fa-|fontawesome|\bfa[srbltd]?\b|material-icons|material-symbols|mat-icon|gem-icon|lucide|remixicon|ri-|tabler|ti-|devicon|lumi|glyph|symbol|codicon|feather|icomoon|dashicons|octicons|fontello|ionicons|typicons|entypo|flowplayer/i;

  // 具體標準正文與中文字型特徵（排除純 generic-family 關鍵字如 sans-serif/serif）
  const SPECIFIC_TEXT_FONT_REGEX = /(?:apple\s*lihei|microsoft\s*jhenghei|noto\s*sans|pingfang|heiti|system-ui|-apple-system|blinkmacsystemfont|roboto|arial|helvetica|segoe\s*ui|ubuntu|cantarell|meiryo)/i;

  // CSS 保留系統關鍵字
  const CSS_SYSTEM_KEYWORDS_REGEX = /^(?:inherit|initial|unset|revert|revert-layer)$/i;

  // CSS 字型自訂變數特徵
  const CSS_VAR_FONT_REGEX = /^--.*(?:font|family)/i;

  // 非文本節點子樹剪枝特徵（跳過完全不包含排版文本之大型節點）
  const PRUNE_TAG_REGEX = /^(?:SCRIPT|STYLE|SVG|PATH|NOSCRIPT|IFRAME|CANVAS|VIDEO|AUDIO|HEAD|META|LINK)$/i;

  // 跨域 CSS fetch 跳過主機（字型發布庫或圖示專用 CDN 無需重複下載改寫）
  const SKIP_FETCH_HOST_REGEX = /(?:^|\.)(?:fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net|(?:use|kit)\.fontawesome\.com)$/i;
  const MAX_FETCH_BYTES = 1000000; // 1 MB

  // Computed Style 時間切片預算（毫秒）
  const SLICE_BUDGET_MS = 4.0;

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
  const observedRoots = new WeakSet();

  // 共用 Constructable Stylesheets 實例（Web Components ShadowRoot 資源共用）
  let sharedBaseSheet = null;
  let sharedEditorSheet = null;

  // Computed Style 候選節點增量佇列與游標
  let computedCandidates = [];
  let computedCandidateSet = new WeakSet();
  let computedCursor = 0;

  // 初始化與 Hook 狀態旗標（保證冪等性）
  let isInitialized = false;
  let isCSSPrototypesHooked = false;
  let isShadowDOMHooked = false;

  // LRU / FIFO 快取結構（O(1) 查詢，上限 1000 筆防止記憶體洩漏）
  const MAX_CACHE_SIZE = 1000;
  const fontCache = new Map();
  const neutralFontCache = new Map();
  let selectorStateCache = new Map();

  // 選擇器狀態對應之快取前綴常數（避免熱路徑模板字串重複拼接）
  const SELECTOR_STATE_PREFIX = ['', '1|', '2|', '3|'];

  // 冪等性快速前綴判定正則（O(1) 時間，零字串拷貝與配置開銷）
  const ALREADY_SANS_REGEX = /^\s*['"]?\s*(?:google sans(?: flex)?|noto sans(?: cjk)? tc)/i;
  const ALREADY_MONO_REGEX = /^\s*['"]?\s*(?:intel one mono|noto sans mono cjk tc)/i;

  // CSS 保留系統關鍵字 O(1) 查詢集合（免除每次呼叫正規表示式引擎）
  const CSS_SYSTEM_KEYWORDS_SET = new Set([
    'inherit', 'initial', 'unset', 'revert', 'revert-layer',
    'INHERIT', 'INITIAL', 'UNSET', 'REVERT', 'REVERT-LAYER'
  ]);

  // 單一最近查詢快取（One-Element Memoization，加速連續相同呼叫）
  let lastRawFont = '';
  let lastRawSelector = '';
  let lastPrependedResult = '';

  // 是否存在跨域樣式表標記
  let hasCorsSheets = false;
  let isIdlePatchScheduled = false;

  // 內部樣式寫入重入防護標記（避免內部 setProperty 觸發原型鏈攔截器二次解析）
  let isInternalStyleWrite = false;

  /**
   * 寫入字型快取（達上限時採用 FIFO 淘汰最舊單筆項目，保持高命中率並免除全量清除之快取抖動）
   * @param {Map<string, string>} targetMap 目標快取結構
   * @param {string} key 快取鍵
   * @param {string} val 快取值
   */
  function setCacheEntry(targetMap, key, val) {
    if (targetMap.size >= MAX_CACHE_SIZE) {
      const oldestKey = targetMap.keys().next().value;
      if (oldestKey !== undefined) {
        targetMap.delete(oldestKey);
      }
    }
    targetMap.set(key, val);
  }

  /**
   * 取得選擇器語意狀態碼（0: 中性, 1: 等寬, 2: 全圖示, 3: 圖示且等寬）
   * 結合 O(1) 快取避免對重複出現之選擇器反覆執行複合正規表示式掃描
   * @param {string} selector 選擇器字串
   * @returns {number} 語意狀態碼 (0 | 1 | 2 | 3)
   */
  function getSelectorState(selector) {
    if (!selector) return 0;
    let state = selectorStateCache.get(selector);
    if (state !== undefined) return state;

    state = 0;
    if (SELECTOR_HINT_REGEX.test(selector)) {
      const selIcon = isAllSelectorPartsIcon(selector);
      const selMono = MONO_SELECTOR_REGEX.test(selector);
      state = selIcon ? (selMono ? 3 : 2) : selMono ? 1 : 0;
    }
    if (selectorStateCache.size >= MAX_CACHE_SIZE) {
      selectorStateCache.clear();
    }
    selectorStateCache.set(selector, state);
    return state;
  }

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
   * 檢測是否為 Chrome / Google 內建整頁翻譯動態注入之包裝節點（如 <font>）
   * 針對純翻譯包裝節點採取被動字型繼承，避免觸發子樹掃描、空閒修補排程與前端框架重繪
   * @param {Node|Element} node 目標 DOM 元素節點
   * @returns {boolean} 是否為純翻譯包裝節點
   */
  function isTranslationNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === 'FONT' || tag === 'font') {
      if (!node.style || typeof node.style.getPropertyValue !== 'function' || !node.style.getPropertyValue('font-family')) {
        return true;
      }
    }
    return false;
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
      if (ICON_FONT_FAMILY_REGEX.test(fontFamily)) {
        // 僅在字型包含 segoe ui symbol 時執行正則替換排除，其餘情況零配置直接判斷
        if (/segoe\s+ui\s+symbol/i.test(fontFamily)) {
          const filteredFamily = fontFamily.replace(/['"]?segoe\s+ui\s+symbol['"]?/gi, '').trim();
          if (filteredFamily && ICON_FONT_FAMILY_REGEX.test(filteredFamily)) {
            return true;
          }
          if (SPECIFIC_TEXT_FONT_REGEX.test(filteredFamily)) {
            isSpecificText = true;
          }
        } else {
          return true;
        }
      } else {
        // 若已知選擇器非全圖示，無須再跑 SPECIFIC_TEXT_FONT_REGEX（省去每次非圖示規則之正則開銷）
        if (precomputedAllIcons === false) {
          return false;
        }
        if (SPECIFIC_TEXT_FONT_REGEX.test(fontFamily)) {
          isSpecificText = true;
        }
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
    if (fontFamily && (MONO_FONT_REGEX.test(fontFamily) || (fontFamily.includes('var(') && /var\([^)]*(?:mono|code)/i.test(fontFamily)))) {
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
    const c0 = fontFamily.charCodeAt(0);
    // 快速首字元預篩：'G'/'g' (71/103), 'N'/'n' (78/110), 'I'/'i' (73/105), '"' (34), "'" (39), 空白 (<=32)
    if (
      c0 !== 34 &&
      c0 !== 39 &&
      c0 !== 71 &&
      c0 !== 103 &&
      c0 !== 78 &&
      c0 !== 110 &&
      c0 !== 73 &&
      c0 !== 105 &&
      c0 > 32
    ) {
      return false;
    }
    if (c0 === 34 || c0 === 39) {
      const c1 = fontFamily.charCodeAt(1);
      if (
        c1 !== 71 &&
        c1 !== 103 &&
        c1 !== 78 &&
        c1 !== 110 &&
        c1 !== 73 &&
        c1 !== 105 &&
        c1 > 32
      ) {
        return false;
      }
    }
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

    if (fontFamily === lastRawFont && selector === lastRawSelector) {
      return lastPrependedResult;
    }

    const len = fontFamily.length;
    const trimmed = (fontFamily.charCodeAt(0) <= 32 || fontFamily.charCodeAt(len - 1) <= 32)
      ? fontFamily.trim()
      : fontFamily;
    if (!trimmed || (trimmed.length <= 12 && (CSS_SYSTEM_KEYWORDS_SET.has(trimmed) || CSS_SYSTEM_KEYWORDS_REGEX.test(trimmed)))) {
      return fontFamily;
    }

    // 選擇器語意狀態正規化：> 98% 常規選擇器不具圖示或等寬特徵，直接查表 neutralFontCache 免除字串拼接
    const selState = selector ? getSelectorState(selector) : 0;
    if (selState === 0) {
      const cachedNeutral = neutralFontCache.get(trimmed);
      if (cachedNeutral !== undefined) {
        lastRawFont = fontFamily;
        lastRawSelector = selector;
        lastPrependedResult = cachedNeutral;
        return cachedNeutral;
      }

      if (isIconFont('', trimmed, false)) {
        setCacheEntry(neutralFontCache, trimmed, fontFamily);
        lastRawFont = fontFamily;
        lastRawSelector = selector;
        lastPrependedResult = fontFamily;
        return fontFamily;
      }

      const mono = isMonospace('', trimmed, false);
      if (isAlreadyPrepended(trimmed, mono)) {
        setCacheEntry(neutralFontCache, trimmed, fontFamily);
        lastRawFont = fontFamily;
        lastRawSelector = selector;
        lastPrependedResult = fontFamily;
        return fontFamily;
      }

      const result = (mono ? MONO_PREPEND_STR : SANS_PREPEND_STR) + trimmed;
      setCacheEntry(neutralFontCache, trimmed, result);
      lastRawFont = fontFamily;
      lastRawSelector = selector;
      lastPrependedResult = result;
      return result;
    }

    const cacheKey = SELECTOR_STATE_PREFIX[selState] + trimmed;

    // 優先查詢 O(1) 快取
    const cached = fontCache.get(cacheKey);
    if (cached !== undefined) {
      lastRawFont = fontFamily;
      lastRawSelector = selector;
      lastPrependedResult = cached;
      return cached;
    }

    const selIcon = selState >= 2;
    const selMono = (selState & 1) === 1;

    // 特例一：圖示字型排除保護
    if (isIconFont(selector, trimmed, selIcon)) {
      setCacheEntry(fontCache, cacheKey, fontFamily);
      lastRawFont = fontFamily;
      lastRawSelector = selector;
      lastPrependedResult = fontFamily;
      return fontFamily;
    }

    // 判斷是否為等寬字型
    const mono = isMonospace(selector, trimmed, selMono);

    // 冪等性防重複檢查
    if (isAlreadyPrepended(trimmed, mono)) {
      setCacheEntry(fontCache, cacheKey, fontFamily);
      lastRawFont = fontFamily;
      lastRawSelector = selector;
      lastPrependedResult = fontFamily;
      return fontFamily;
    }

    // 特例三：若含有 CSS 變數 var(...)，在其前方前置依然是合法 CSS 語法
    const prependStr = mono ? MONO_PREPEND_STR : SANS_PREPEND_STR;
    const result = prependStr + trimmed;

    setCacheEntry(fontCache, cacheKey, result);
    lastRawFont = fontFamily;
    lastRawSelector = selector;
    lastPrependedResult = result;
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
      let normalizedBase = '';
      let baseParentDir = '';
      try {
        const parsedBase = new URL(baseUrl);
        const lastSlash = parsedBase.pathname.lastIndexOf('/');
        const dirPath = lastSlash !== -1 ? parsedBase.pathname.slice(0, lastSlash + 1) : '/';
        normalizedBase = `${parsedBase.origin}${dirPath}`;
        const parentSlash = dirPath.length > 1 ? dirPath.lastIndexOf('/', dirPath.length - 2) : -1;
        baseParentDir = parentSlash !== -1 ? `${parsedBase.origin}${dirPath.slice(0, parentSlash + 1)}` : normalizedBase;
      } catch {
        // 忽略無效 baseUrl
      }

      result = result.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, rawUrl) => {
        const trimmed = rawUrl.trim();
        if (!trimmed) return match;
        const c0 = trimmed.charCodeAt(0);
        // 快速排除 '#' (35) 或協定相對/絕對路徑
        if (
          c0 === 35 ||
          trimmed.startsWith('data:') ||
          trimmed.startsWith('blob:') ||
          trimmed.startsWith('http://') ||
          trimmed.startsWith('https://') ||
          trimmed.startsWith('//')
        ) {
          return match;
        }
        const q = quote || '"';
        // 針對最常見的 '../xxx' 與 './xxx' 或純相對檔名執行零配置字串拼接，免除每次建構 new URL() 實例開銷
        if (normalizedBase && !trimmed.includes('://')) {
          if (trimmed.startsWith('../') && !trimmed.startsWith('../../') && baseParentDir) {
            return `url(${q}${baseParentDir}${trimmed.slice(3)}${q})`;
          }
          if (trimmed.startsWith('./') && !trimmed.includes('../')) {
            return `url(${q}${normalizedBase}${trimmed.slice(2)}${q})`;
          }
          if (c0 !== 47 && !trimmed.startsWith('.') && !trimmed.includes('../')) {
            return `url(${q}${normalizedBase}${trimmed}${q})`;
          }
        }
        try {
          const absUrl = new URL(trimmed, baseUrl).href;
          return `url(${q}${absUrl}${q})`;
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
   * 初始化共用 Constructable Stylesheets（供 ShadowRoot 高效共用，免除重複注入 <style>）
   */
  function initSharedConstructableStyles() {
    if (sharedBaseSheet !== null) return;
    try {
      if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
        sharedBaseSheet = new CSSStyleSheet();
        sharedBaseSheet.replaceSync(`
:where(html, body) { font-family: ${BASE_SANS_STACK}; }
:where(code, pre, kbd, samp, tt, var) { font-family: ${BASE_MONO_STACK}; }
:where(h1, h2, h3, h4, h5, h6, p, blockquote, q, li, dt, dd, td, th, label, summary, details) { font-family: ${BASE_SANS_STACK}; }
:where(input, textarea, select, button, [contenteditable="true"]) { font-family: ${BASE_SANS_STACK}; }
`);
        processedStyleSheets.add(sharedBaseSheet);

        sharedEditorSheet = new CSSStyleSheet();
        sharedEditorSheet.replaceSync(`
:where(${EDITOR_CONTAINER_SELECTORS}) { font-family: ${BASE_MONO_STACK} !important; }
`);
        processedStyleSheets.add(sharedEditorSheet);
      }
    } catch {
      sharedBaseSheet = null;
      sharedEditorSheet = null;
    }
  }

  /**
   * 注入基礎層降級樣式與編輯器專屬樣式（含 Google Fonts 線上樣式表）
   * @param {Document|ShadowRoot} targetRoot 注入目標根節點
   */
  function injectBaseStyles(targetRoot = document) {
    // Web Components: 若目標為 ShadowRoot 且支援 adoptedStyleSheets，共用預編譯之 Constructable Stylesheet
    if (targetRoot && targetRoot.adoptedStyleSheets && sharedBaseSheet && sharedEditorSheet) {
      const adopted = targetRoot.adoptedStyleSheets;
      if (!adopted.includes(sharedBaseSheet)) {
        try {
          targetRoot.adoptedStyleSheets = [...adopted, sharedBaseSheet, sharedEditorSheet];
          return;
        } catch {
          // 若寫入失敗則平滑退回傳統 <style> 注入
        }
      } else {
        return;
      }
    }

    const parent = targetRoot.head || targetRoot.documentElement || targetRoot;
    if (!parent || !parent.appendChild) return;

    // 0. 注入 Google Fonts 線上樣式表（若尚未注入）
    if (!parent.querySelector || !parent.querySelector(`#${GOOGLE_FONTS_LINK_ID}`)) {
      const fontLink = document.createElement('link');
      fontLink.id = GOOGLE_FONTS_LINK_ID;
      fontLink.rel = 'stylesheet';
      fontLink.href = GOOGLE_FONTS_URL;
      try {
        parent.appendChild(fontLink);
        if (fontLink.sheet) {
          processedStyleSheets.add(fontLink.sheet);
        }
      } catch {
        // 容錯防禦
      }
    }

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
      if (rule.selectorText && rule.style) {
        const style = rule.style;
        // A. 處理常規 font-family
        // 若環境支援 style.fontFamily 且為空字串，直接 O(1) 短路跳過 getPropertyValue 呼叫
        const currentFont = typeof style.fontFamily === 'string'
          ? (style.fontFamily ? style.getPropertyValue('font-family') : '')
          : style.getPropertyValue('font-family');
        if (currentFont) {
          const newFont = prependFontFamily(currentFont, rule.selectorText);
          if (newFont !== currentFont) {
            const priority = style.getPropertyPriority('font-family');
            setStylePropertyInternal(style, 'font-family', newFont, priority);
          }
        }

        // B. 特例三：處理 CSS Custom Properties（例如 --font-sans, --code-font）
        // 由樣式表層級 hasFontVars 預篩與 style.length 雙重守衛，免除 style.cssText 序列化開銷
        if (hasFontVars && style.length > 0) {
          const styleLen = style.length;
          for (let p = 0; p < styleLen; p++) {
            const propName = style[p];
            if (propName && propName.charCodeAt(0) === 45 && propName.charCodeAt(1) === 45 && CSS_VAR_FONT_REGEX.test(propName)) {
              const varVal = style.getPropertyValue(propName);
              if (varVal && !CSS_SYSTEM_KEYWORDS_REGEX.test(varVal.trim())) {
                const isMonoVar = /mono|code/i.test(propName) || isMonospace('', varVal, false);
                if (!isAlreadyPrepended(varVal, isMonoVar)) {
                  const prependStr = isMonoVar ? MONO_PREPEND_STR : SANS_PREPEND_STR;
                  const newVarVal = `${prependStr}${varVal.trim()}`;
                  const varPriority = style.getPropertyPriority(propName);
                  setStylePropertyInternal(style, propName, newVarVal, varPriority);
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
   * 安全讀取 CSSStyleSheet.cssRules（隔離 try-catch 避免 V8 TurboFan 內聯受阻）
   * @param {CSSStyleSheet} sheet 目標樣式表
   * @returns {CSSRuleList|null} 規則列表或 null（跨域安全例外）
   */
  function getSheetRulesSafe(sheet) {
    try {
      return sheet.cssRules;
    } catch {
      return null;
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
    // 自身樣式表防護：若為腳本自身注入的基礎樣式、編輯器樣式或 Google Fonts 外部樣式表，直接加入已處理集合並跳過
    if ((owner && (owner.id === BASE_STYLE_ID || owner.id === EDITOR_STYLE_ID || owner.id === GOOGLE_FONTS_LINK_ID)) || (sheet.href && sheet.href === GOOGLE_FONTS_URL)) {
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

    const rules = getSheetRulesSafe(sheet);
    if (!rules) {
      // 特例二：跨域樣式表存取拋出 SecurityError
      processedStyleSheets.add(sheet);

      const href = sheet.href;
      // 跨域 CDN 過濾：若為 Google Fonts / Typekit / FontAwesome 等字型與圖示分發主機，無需重複 fetch 改寫
      if (href) {
        try {
          const host = new URL(href).hostname;
          if (SKIP_FETCH_HOST_REGEX.test(host)) {
            hasCorsSheets = true;
            scheduleIdleComputedStylePatch();
            return;
          }
        } catch {
          // 容錯防禦
        }
      }

      // 若為外部 link 樣式表且支援 fetch，嘗試直接下載改寫注入（解決 XDA 等 CDN 外部樣式表）
      if (typeof fetch === 'function' && href && !fetchedStyleSheetUrls.has(href)) {
        fetchedStyleSheetUrls.add(href);
        fetch(href, { cache: 'force-cache' })
          .then((res) => {
            if (!res || !res.ok) {
              hasCorsSheets = true;
              scheduleIdleComputedStylePatch();
              return null;
            }
            // 檔案大小防護：若 Content-Length 超過 1MB 則放棄文字改寫，避免記憶體暴增
            const cl = res.headers && res.headers.get('content-length');
            if (cl && parseInt(cl, 10) > MAX_FETCH_BYTES) {
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

    processedStyleSheets.add(sheet);
    processRules(rules, hasFontVars);
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

    if (!styleToElementMap.has(el.style)) {
      styleToElementMap.set(el.style, el);
    }

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
    if (root.nodeType === 1 && (isTranslationNode(root) || PRUNE_TAG_REGEX.test(root.tagName))) return;

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
   * 採用「4ms 時間切片 + 增量佇列 + 兩階段讀寫分離（Batch Read -> Batch Write）」，徹底消除同步長任務與 Style Thrashing
   * @param {IdleDeadline} [deadline] 瀏覽器傳入之 IdleDeadline 物件
   */
  function patchComputedStyles(deadline) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    // 若佇列已消化完畢或尚未初始化，初次建立候選目標清單
    if (computedCandidates.length === 0 || computedCursor >= computedCandidates.length) {
      const sampleTargets = document.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], [class*="card"] a, [class*="post"] a, main, article, section, header, p, code, pre, [class*="content"], [class*="editor"], time, [class*="date"], [class*="meta"], [class*="author"], [class*="byline"], [class*="time"], [class*="published"]'
      );
      computedCandidates = Array.from(sampleTargets);
      computedCursor = 0;
    }

    const totalLen = computedCandidates.length;
    const pendingWrites = [];
    const isSliceMode = Boolean(deadline || isIdlePatchScheduled);
    const sliceStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

    // 第一階段（Batch Read）：純讀取 getComputedStyle 並收集待修補節點
    while (computedCursor < totalLen) {
      // 僅在排程切片模式下進行時間片預算檢查 (4ms)
      if (isSliceMode) {
        if (deadline && typeof deadline.timeRemaining === 'function') {
          if (deadline.timeRemaining() <= 1.0) break;
        } else {
          const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
          if (now - sliceStart >= SLICE_BUDGET_MS) break;
        }
      }

      const el = computedCandidates[computedCursor++];
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

            // 若父容器為標題或元數據容器且包含 a、span、time 標籤，同步將內部文字節點加入批次寫入佇列（排除內嵌圖示節點與純翻譯標籤）
            const isContainer = el.matches ? el.matches('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], [class*="card"], [class*="post"], [class*="meta"], [class*="byline"]') : true;
            if (isContainer) {
              const childElements = el.querySelectorAll ? el.querySelectorAll('a, span, time') : null;
              if (childElements && childElements.length) {
                for (let c = 0; c < childElements.length; c++) {
                  const child = childElements[c];
                  if (child && !processedElements.has(child)) {
                    if (isTranslationNode(child)) {
                      continue;
                    }
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

    // 自動續排：若本輪切片時間用盡但佇列尚未消化完畢，自動排程下一次空閒批次推進
    if (computedCursor < computedCandidates.length) {
      scheduleIdleComputedStylePatch();
    } else {
      computedCandidates = [];
      computedCursor = 0;
    }
  }

  /**
   * 排程空閒時間執行計算樣式修補（僅在存在無法同源改寫之跨域樣式表時啟動）
   */
  function scheduleIdleComputedStylePatch() {
    if (!hasCorsSheets || isIdlePatchScheduled || typeof window === 'undefined') return;
    isIdlePatchScheduled = true;

    const runner = (deadline) => {
      isIdlePatchScheduled = false;
      patchComputedStyles(deadline);
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runner, { timeout: 1500 });
    } else if (typeof setTimeout === 'function') {
      setTimeout(runner, 60);
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
    if (isShadowDOMHooked || typeof Element === 'undefined' || !Element.prototype || !Element.prototype.attachShadow) {
      return;
    }
    isShadowDOMHooked = true;

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
   * 原型鏈 API 攔截層：攔截動態 insertRule, replaceSync, replace 與 CSSStyleDeclaration.setProperty
   * 確保 CSS-in-JS 與動態腳本產生的字型樣式第一時間被前置（以 _fpHooked 標記防止重複包裝）
   */
  function hookCSSPrototypes() {
    // 0. 攔截 HTMLElement.prototype.style getter 以建立 style 物件與 DOM 元素的弱引用關聯
    try {
      const proto = (typeof HTMLElement !== 'undefined' && HTMLElement.prototype) ||
                    (typeof window !== 'undefined' && window.HTMLElement && window.HTMLElement.prototype) ||
                    (typeof Element !== 'undefined' && Element.prototype);
      if (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'style');
        if (desc && desc.get && !desc.get._fpHooked) {
          const origStyleGet = desc.get;
          const hookedStyleGet = function() {
            const s = origStyleGet.call(this);
            if (s && typeof s === 'object' && !styleToElementMap.has(s)) {
              styleToElementMap.set(s, this);
            }
            return s;
          };
          hookedStyleGet._fpHooked = true;
          Object.defineProperty(proto, 'style', {
            get: hookedStyleGet,
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
        if (!origSetProperty._fpHooked) {
          const hookedSetProperty = function(prop, val, priority) {
            if (!isInternalStyleWrite && prop === 'font-family' && typeof val === 'string' && val) {
              const selectorContext = getStyleContextSelector(this);
              const prepended = prependFontFamily(val, selectorContext);
              if (prepended) val = prepended;
            }
            return origSetProperty.call(this, prop, val, priority);
          };
          hookedSetProperty._fpHooked = true;
          CSSStyleDeclaration.prototype.setProperty = hookedSetProperty;
        }
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
        if (desc && desc.set && !desc.set._fpHooked) {
          const origSet = desc.set;
          const hookedSet = function(val) {
            if (!isInternalStyleWrite && typeof val === 'string' && val) {
              const selectorContext = getStyleContextSelector(this);
              const prepended = prependFontFamily(val, selectorContext);
              if (prepended) val = prepended;
            }
            return origSet.call(this, val);
          };
          hookedSet._fpHooked = true;
          Object.defineProperty(styleProto, 'fontFamily', {
            get: desc.get,
            set: hookedSet,
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
        if (!origInsertRule._fpHooked) {
          const hookedInsert = function(ruleText, index) {
            if (typeof ruleText === 'string' && ruleText.includes('font-family')) {
              try {
                ruleText = rewriteCssContent(ruleText);
              } catch {
                // 容錯防禦
              }
            }
            return origInsertRule.call(this, ruleText, index);
          };
          hookedInsert._fpHooked = true;
          CSSStyleSheet.prototype.insertRule = hookedInsert;
        }
      }
    } catch {
      // 容錯防禦
    }

    // 4. 攔截 CSSStyleSheet.prototype.replaceSync
    try {
      if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replaceSync) {
        const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
        if (!origReplaceSync._fpHooked) {
          const hookedSync = function(text) {
            if (typeof text === 'string' && text.includes('font-family')) {
              try {
                text = rewriteCssContent(text);
              } catch {
                // 容錯防禦
              }
            }
            return origReplaceSync.call(this, text);
          };
          hookedSync._fpHooked = true;
          CSSStyleSheet.prototype.replaceSync = hookedSync;
        }
      }
    } catch {
      // 容錯防禦
    }

    // 5. 攔截 CSSStyleSheet.prototype.replace (非同步 Constructable Stylesheet)
    try {
      if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replace) {
        const origReplace = CSSStyleSheet.prototype.replace;
        if (!origReplace._fpHooked) {
          const hookedAsync = function(text) {
            if (typeof text === 'string' && text.includes('font-family')) {
              try {
                text = rewriteCssContent(text);
              } catch {
                // 容錯防禦
              }
            }
            return origReplace.call(this, text);
          };
          hookedAsync._fpHooked = true;
          CSSStyleSheet.prototype.replace = hookedAsync;
        }
      }
    } catch {
      // 容錯防禦
    }
  }

  /**
   * 監聽樣式表動態插入與載入事件、行內樣式屬性變更（整合單次遍歷、祖先去重與屬性變更合併）
   * @param {Document|ShadowRoot} targetDoc 目標文件或根節點
   */
  function observeStyleSheets(targetDoc = document) {
    if (observedRoots.has(targetDoc)) {
      return;
    }
    observedRoots.add(targetDoc);

    const targetNode = targetDoc.documentElement || targetDoc;
    if (!targetNode || typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      let shouldScanStylesheets = false;
      let hasAddedElements = false;
      const modifiedStyleTargets = new Set();
      const rawAddedElements = [];

      const mutLen = mutations.length;
      for (let i = 0; i < mutLen; i++) {
        const mutation = mutations[i];

        // 1. 收集行內 style 屬性動態變更（以 Set 合併同一批次的重複目標）
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          const targetEl = mutation.target;
          if (!isInternalStyleWrite && targetEl && !isTranslationNode(targetEl)) {
            modifiedStyleTargets.add(targetEl);
          }
        } else if (mutation.type === 'childList') {
          const added = mutation.addedNodes;
          const addedLen = added.length;
          for (let j = 0; j < addedLen; j++) {
            const node = added[j];
            if (node && node.nodeType === 1 && !isTranslationNode(node)) {
              rawAddedElements.push(node);
            }
          }
        }
      }

      // 執行屬性變更批次處理（每元素保證僅執行一次樣式檢查）
      if (modifiedStyleTargets.size > 0) {
        modifiedStyleTargets.forEach((el) => {
          patchElementInlineStyle(el);
        });
      }

      // 2. 處理新增節點（祖先去重與單次整合遍歷）
      if (rawAddedElements.length > 0) {
        hasAddedElements = true;
        const isDocLoading = (targetDoc.ownerDocument || targetDoc).readyState === 'loading';

        let topRoots = rawAddedElements;
        if (rawAddedElements.length > 1) {
          const batchSet = new Set(rawAddedElements);
          topRoots = [];
          for (let i = 0; i < rawAddedElements.length; i++) {
            const node = rawAddedElements[i];
            let parent = node.parentNode;
            if (!parent) {
              topRoots.push(node);
              continue;
            }
            let hasAncestorInBatch = false;
            while (parent) {
              if (batchSet.has(parent)) {
                hasAncestorInBatch = true;
                break;
              }
              parent = parent.parentNode;
            }
            if (!hasAncestorInBatch) {
              topRoots.push(node);
            }
          }
        }

        const topLen = topRoots.length;
        for (let i = 0; i < topLen; i++) {
          const node = topRoots[i];
          const tagName = node.tagName;

          // 剪枝特徵：跳過純腳本、向量圖與非排版標籤
          if (PRUNE_TAG_REGEX.test(tagName)) {
            continue;
          }

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
            if (node.id === GOOGLE_FONTS_LINK_ID) {
              if (node.sheet) processedStyleSheets.add(node.sheet);
              continue;
            }
            if (node.sheet) {
              processStyleSheet(node.sheet);
            } else if (typeof node.addEventListener === 'function') {
              node.addEventListener('load', () => {
                if (node.sheet) processStyleSheet(node.sheet);
              }, { once: true });
            }
          } else {
            // 首屏 HTML 解析期：原生串流解析器會逐一派發節點，僅做 O(1) 自身單節點行內樣式檢查
            if (
              (typeof node.hasAttribute !== 'function' || node.hasAttribute('style')) &&
              node.style &&
              typeof node.style.getPropertyValue === 'function' &&
              node.style.getPropertyValue('font-family')
            ) {
              patchElementInlineStyle(node);
            }

            // 互動期（SPA 動態渲染）：以單次 querySelectorAll 取代原先 3 次獨立子樹遍歷
            if (!isDocLoading && node.firstElementChild && typeof node.querySelectorAll === 'function') {
              try {
                const subItems = node.querySelectorAll('[style*="font-family" i], style, link[rel="stylesheet"]');
                const subLen = subItems.length;
                for (let k = 0; k < subLen; k++) {
                  const subNode = subItems[k];
                  const subTag = subNode.tagName;
                  if (subTag === 'STYLE' || subTag === 'style') {
                    if (subNode.sheet) {
                      processStyleSheet(subNode.sheet);
                    } else {
                      shouldScanStylesheets = true;
                    }
                  } else if ((subTag === 'LINK' || subTag === 'link') && subNode.rel === 'stylesheet') {
                    if (subNode.id === GOOGLE_FONTS_LINK_ID) {
                      if (subNode.sheet) processedStyleSheets.add(subNode.sheet);
                      continue;
                    }
                    if (subNode.sheet) {
                      processStyleSheet(subNode.sheet);
                    } else if (typeof subNode.addEventListener === 'function') {
                      subNode.addEventListener('load', () => {
                        if (subNode.sheet) processStyleSheet(subNode.sheet);
                      }, { once: true });
                    }
                  } else {
                    patchElementInlineStyle(subNode);
                  }
                }
              } catch {
                // 容錯防禦
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
    if (typeof document === 'undefined' || isInitialized) return;
    isInitialized = true;

    // 0. 初始化共用 Constructable Stylesheets
    initSharedConstructableStyles();

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
      GOOGLE_FONTS_LINK_ID,
      GOOGLE_FONTS_URL,
      MAX_CACHE_SIZE,
      SLICE_BUDGET_MS,
      PRUNE_TAG_REGEX,
      SKIP_FETCH_HOST_REGEX,
      MAX_FETCH_BYTES,
      fontCache,
      neutralFontCache,
      selectorStateCache,
      processedStyleSheets,
      observedRoots,
      isIconFont,
      isMonospace,
      isAlreadyPrepended,
      isTranslationNode,
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
      initSharedConstructableStyles,
      getSharedBaseSheet: () => sharedBaseSheet,
      getSharedEditorSheet: () => sharedEditorSheet,
      getIsInitialized: () => isInitialized,
      init
    };
  }
})();
