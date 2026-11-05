// ==UserScript==
// @name         網頁字體前置替換器-Custom (Font Prepender with Perf)
// @namespace    https://greasyfork.org/zh-TW/users/1237813-abc0922001
// @version      1.5.6-perf
// @description  將自訂字體前置於網站字體；採用兩階段 DOM 監聽、精準樣式表預篩與零 WeakSet 規則走訪，極致壓低 CPU 耗時。
// @author       abc0922001
// @match        *://*/*
// @exclude      *://term.ptt.cc/*
// @exclude      *://docs.google.com/*
// @exclude      *://fonts.google.com/*
// @exclude      *://91pu.com.tw/song/*
// @exclude      *://yuantabank.com/*
// @exclude      *://github.com/*
// @allFrames    true
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function fontPrepender() {
    'use strict';

    /**
     * 效能測試開關：評估完畢後可改為 false 關閉所有測量開銷
     * @type {boolean}
     */
    const ENABLE_PERF_METRICS = false;

    // =========================================================================
    // 效能遙測模組 (Performance Telemetry)
    // =========================================================================

    const perfData = {
        scriptStartTime: performance.now(),
        domReadyWallClockMs: 0,
        initCpuTimeMs: 0,
        sheetsSkippedFastPath: 0,
        rulesChecked: 0,
        rulesRewritten: 0,
        rulesProcessTimeMs: 0,
        replaceSyncCount: 0,
        replaceSyncTimeMs: 0,
        insertRuleCount: 0,
        insertRuleTimeMs: 0,
        mutationBatches: 0,
        mutationTimeMs: 0,
        shadowRootsInjected: 0,
        cacheHits: 0,
        cacheMisses: 0
    };

    function printPerfReport() {
        if (!ENABLE_PERF_METRICS || window.top !== window.self) return;

        const totalTrackedCpuTime =
            perfData.initCpuTimeMs +
            perfData.rulesProcessTimeMs +
            perfData.replaceSyncTimeMs +
            perfData.insertRuleTimeMs +
            perfData.mutationTimeMs;

        console.group('%c[Font Prepender v1.5.4] 效能評估報告 (Top Frame)', 'color: #10b981; font-weight: bold; font-size: 13px;');
        console.table({
            '1. 腳本初始化純 CPU 耗時': {
                '數值 / 計數': `${perfData.initCpuTimeMs.toFixed(2)} ms`,
                '說明': `網頁 DOMReady 牆鐘時間為 ${perfData.domReadyWallClockMs.toFixed(2)} ms`
            },
            '2. 靜態 CSSOM 規則改寫': {
                '數值 / 計數': `${perfData.rulesRewritten} / ${perfData.rulesChecked} (條)`,
                '說明': `累積耗時 ${perfData.rulesProcessTimeMs.toFixed(2)} ms (預篩跳過 ${perfData.sheetsSkippedFastPath} 張表)`
            },
            '3. replaceSync 攔截 (Web Components)': {
                '數值 / 計數': `${perfData.replaceSyncCount} 次`,
                '說明': `累積耗時 ${perfData.replaceSyncTimeMs.toFixed(2)} ms`
            },
            '4. insertRule 攔截 (CSS-in-JS)': {
                '數值 / 計數': `${perfData.insertRuleCount} 次`,
                '說明': `累積耗時 ${perfData.insertRuleTimeMs.toFixed(2)} ms`
            },
            '5. DOM Mutation 純監聽開銷': {
                '數值 / 計數': `${perfData.mutationBatches} 次觸發`,
                '說明': `扣除樣式表掃描後之純 DOM 檢查耗時 ${perfData.mutationTimeMs.toFixed(2)} ms`
            },
            '6. Shadow DOM 注入數': {
                '數值 / 計數': `${perfData.shadowRootsInjected} 個`,
                '說明': '含 Declarative 與 attachShadow Root'
            },
            '7. 字體快取命中率 (Memoization)': {
                '數值 / 計數': `${perfData.cacheHits} 命中 / ${perfData.cacheMisses} 未命中`,
                '說明': 'O(1) 字體解析快取池效率'
            },
            '8. 腳本純 CPU 累積總耗時': {
                '數值 / 計數': `${totalTrackedCpuTime.toFixed(2)} ms`,
                '說明': '所有攔截、掃描與改寫執行的純 JS 運算時間總和'
            }
        });
        console.log('%c💡 提示：在 DevTools 主控台輸入 window.__fontPrependerPerf.report() 可隨時重新產出最新數據。', 'color: #6b7280; font-style: italic;');
        console.groupEnd();
    }

    if (ENABLE_PERF_METRICS && window.top === window.self) {
        window.__fontPrependerPerf = {
            data: perfData,
            report: printPerfReport
        };

        window.addEventListener('load', () => {
            setTimeout(printPerfReport, 1500);
        }, { once: true });
    }

    // =========================================================================
    // 字體與樣式基礎常數
    // =========================================================================

    const CUSTOM_FONTS = [
        'Google Sans',
        'Google Sans Flex',
        'Noto Sans CJK TC'
    ];

    const MONO_FONTS = [
        'Intel One Mono',
        'Noto Sans Mono CJK TC',
        'Consolas',
        'Courier New',
        'monospace'
    ];

    const STYLE_ID = 'custom-font-prepender-style';
    const PREPEND_FONTS = CUSTOM_FONTS.map((font) => `"${font}"`).join(', ');
    const MONO_PREPEND_FONTS = MONO_FONTS.map((font) => `"${font}"`).join(', ');

    function normalizeSingleFontName(fontName) {
        return fontName
            .replace(/["'‘’“”]/g, '')
            .trim()
            .toLowerCase();
    }

    const CUSTOM_FONT_SET = new Set(CUSTOM_FONTS.map(normalizeSingleFontName));
    const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

    const SKIP_SELECTOR_RE = /(?:^|[\s_-])(?:icon|icons|symbol|symbols|lumi|material|glyph|glyphicons?|fontawesome|feather|tabler|octicon|octicons|remixicon|fa|fas|far|fab|fal|fad|chevron|arrow|caret|lucide|codicon|icomoon|ionicons|typicons|mat-icon|gem-icon|svg|mono|code|highlight|hljs|syntax|terminal|console|editor|codemirror|ace_editor|monaco|prism|pre|kbd|samp|tt|var)(?=$|[\s_-])/i;
    const SKIP_FONT_RE = /(?:(?:google|material)\s*(?:icons?|symbols?)|font\s*awesome|lumi|glyphicons?|feather|tabler\s*icons?|octicons?|remixicon|\bsymbols?\b|icomoon|ionicons|codicon|lucide|typicons|devicon|mono|consolas|courier|menlo|monaco|fira\s*code|source\s*code|jetbrains\s*mono|cascadia\s*code|hack|dejavu\s*sans\s*mono|inconsolata)/i;

    /**
     * 精準預篩正則：只匹配 font-family:、font: 簡寫或 @import，自動忽略 font-size / font-weight 等無關屬性。
     * @type {RegExp}
     */
    const HAS_FONT_DECL_RE = /font(?:-family)?\s*:|@import/i;

    const GLOBAL_RULES = `
        
		/* 1. 基底內文：400 -> 500 (Medium) */
		html, body {
			font-weight: 500 !important;
			font-variation-settings: "wght" 500 !important;
		}
		
		/* 2. 一般文字容器繼承父層字重，避免蓋掉內部粗體標籤 */
		:where(p, li, dt, dd, td, label, summary, details, blockquote, q, cite, div, span) {
			font-weight: inherit;
		}
		
		/* 3. 次標題與中粗體：500/600 -> 600/700 */
		:where(h4, h5, h6, figcaption) {
			font-weight: 600 !important;
			font-variation-settings: "wght" 600 !important;
		}
		
		/* 4. 主標題與粗體強調：700 -> 800（若覺得粗體 800 筆畫太擠，可改回 700） */
		:where(h1, h2, h3, strong, b, th) {
			font-weight: 800 !important;
			font-variation-settings: "wght" 800 !important;
		}
		
		/* 5. 行內樣式 (Inline Style) 全面 +100 對齊 */
		[style*="font-weight: 100"], [style*="font-weight:100"] { font-weight: 200 !important; font-variation-settings: "wght" 200 !important; }
		[style*="font-weight: 200"], [style*="font-weight:200"] { font-weight: 300 !important; font-variation-settings: "wght" 300 !important; }
		[style*="font-weight: 300"], [style*="font-weight:300"] { font-weight: 400 !important; font-variation-settings: "wght" 400 !important; }
		[style*="font-weight: 400"], [style*="font-weight:400"] { font-weight: 500 !important; font-variation-settings: "wght" 500 !important; }
		[style*="font-weight: 500"], [style*="font-weight:500"] { font-weight: 600 !important; font-variation-settings: "wght" 600 !important; }
		[style*="font-weight: 600"], [style*="font-weight:600"] { font-weight: 700 !important; font-variation-settings: "wght" 700 !important; }
		[style*="font-weight: 700"], [style*="font-weight:700"] { font-weight: 800 !important; font-variation-settings: "wght" 800 !important; }
		[style*="font-weight: 800"], [style*="font-weight:800"] { font-weight: 900 !important; font-variation-settings: "wght" 900 !important; }
		[style*="font-weight: 900"], [style*="font-weight:900"] { font-weight: 900 !important; font-variation-settings: "wght" 900 !important; }
		
        html, body {
            font-family: ${PREPEND_FONTS}, sans-serif !important;
        }        

        input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]),
        textarea,
        select,
        button {
            font-family: ${PREPEND_FONTS}, sans-serif;
        }

        pre, code, kbd, samp, tt, var,
        pre *, code *, kbd *, samp *, tt *, var * {
            font-family: ${MONO_PREPEND_FONTS} !important;
        }

        :where(
            h1, h2, h3, h4, h5, h6,
            p, blockquote, q,
            li, dt, dd,
            td, th,
            caption, figcaption,
            label, legend,
            summary, details,
            cite, b, strong, em,
            u, s, del, ins, mark, sub, sup,
            dialog
        ) {
            font-family: ${PREPEND_FONTS}, sans-serif;
        }
    `;

    const SHADOW_RULES = `
        :host, :host-context(*) {
            font-family: ${PREPEND_FONTS}, sans-serif;
        }

        input, textarea, select, button {
            font-family: ${PREPEND_FONTS}, sans-serif;
        }

        pre, code, kbd, samp, tt, var,
        pre *, code *, kbd *, samp *, tt *, var * {
            font-family: ${MONO_PREPEND_FONTS} !important;
        }
    `;

    // =========================================================================
    // O(1) 字體字串解析快取池 (Memoization Layer)
    // =========================================================================

    const fontFamilyCache = new Map();
    const MAX_CACHE_SIZE = 512;

    function getPrependedFontFamily(fontFamily) {
        if (!fontFamily) return null;

        const cached = fontFamilyCache.get(fontFamily);
        if (cached !== undefined) {
            if (ENABLE_PERF_METRICS) perfData.cacheHits++;
            return cached;
        }
        if (ENABLE_PERF_METRICS) perfData.cacheMisses++;

        const trimmed = fontFamily.trim();
        if (!trimmed || CSS_WIDE_KEYWORDS.has(trimmed.toLowerCase())) {
            fontFamilyCache.set(fontFamily, null);
            return null;
        }

        const commaIdx = trimmed.indexOf(',');
        const firstFont = commaIdx === -1 ? trimmed : trimmed.slice(0, commaIdx);
        if (CUSTOM_FONT_SET.has(normalizeSingleFontName(firstFont)) || SKIP_FONT_RE.test(trimmed)) {
            fontFamilyCache.set(fontFamily, null);
            return null;
        }

        const parts = trimmed.split(',');
        const fallbackFonts = [];
        for (let i = 0, len = parts.length; i < len; i++) {
            const f = parts[i].trim();
            if (f && !CUSTOM_FONT_SET.has(normalizeSingleFontName(f))) {
                fallbackFonts.push(f);
            }
        }

        const result = fallbackFonts.length > 0
            ? `${PREPEND_FONTS}, ${fallbackFonts.join(', ')}`
            : PREPEND_FONTS;

        if (fontFamilyCache.size >= MAX_CACHE_SIZE) {
            fontFamilyCache.clear();
        }
        fontFamilyCache.set(fontFamily, result);
        return result;
    }

    function rewriteCssContent(cssText, baseUrl) {
        if (!cssText || typeof cssText !== 'string') return cssText;

        let result = cssText;
        if (baseUrl && result.includes('url(')) {
            result = result.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, rawUrl) => {
                const trimmed = rawUrl.trim();
                if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#') || /^(?:https?:)?\/\//i.test(trimmed)) {
                    return match;
                }
                try {
                    const absUrl = new URL(trimmed, baseUrl).href;
                    return `url(${quote || '"'}${absUrl}${quote || '"'})`;
                } catch (e) {
                    return match;
                }
            });
        }

        result = result.replace(/@font-face\s*\{[^}]*\}|font-family\s*:\s*([^;!}]+)(!important)?/gi, (match, fonts, important) => {
            if (!fonts) return match;
            const prepended = getPrependedFontFamily(fonts);
            if (!prepended) return match;
            return `font-family: ${prepended}${important ? ' !important' : ''}`;
        });

        return result;
    }

    const internalSheets = new WeakSet();
    let constructableGlobalSheet = null;
    let constructableShadowSheet = null;

    if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
        try {
            constructableGlobalSheet = new CSSStyleSheet();
            internalSheets.add(constructableGlobalSheet);
            constructableGlobalSheet.replaceSync(GLOBAL_RULES);

            constructableShadowSheet = new CSSStyleSheet();
            internalSheets.add(constructableShadowSheet);
            constructableShadowSheet.replaceSync(SHADOW_RULES);
        } catch (e) {
            constructableGlobalSheet = null;
            constructableShadowSheet = null;
        }
    }

    const processedShadowRoots = new WeakSet();

    function injectIntoShadowRoot(shadowRoot) {
        if (!shadowRoot || processedShadowRoots.has(shadowRoot)) return;
        processedShadowRoots.add(shadowRoot);
        if (ENABLE_PERF_METRICS) perfData.shadowRootsInjected++;

        if (constructableShadowSheet && Array.isArray(shadowRoot.adoptedStyleSheets)) {
            try {
                if (!shadowRoot.adoptedStyleSheets.includes(constructableShadowSheet)) {
                    shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, constructableShadowSheet];
                }
            } catch (e) {
                injectShadowStyleTag(shadowRoot);
            }
        } else {
            injectShadowStyleTag(shadowRoot);
        }

        const sheets = shadowRoot.styleSheets;
        if (sheets) {
            for (let i = 0, len = sheets.length; i < len; i++) {
                processStyleSheet(sheets[i]);
            }
        }
    }

    function injectShadowStyleTag(shadowRoot) {
        try {
            if (shadowRoot.querySelector && shadowRoot.querySelector(`style#${STYLE_ID}`)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = SHADOW_RULES;
            shadowRoot.appendChild(style);
        } catch (e) {}
    }

    // =========================================================================
    // 原型鏈攔截層
    // =========================================================================

    try {
        const origAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function () {
            const shadowRoot = origAttachShadow.apply(this, arguments);
            if (shadowRoot) {
                try {
                    injectIntoShadowRoot(shadowRoot);
                } catch (e) {}
            }
            return shadowRoot;
        };
    } catch (e) {}

    try {
        if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replaceSync) {
            const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
            CSSStyleSheet.prototype.replaceSync = function (text) {
                if (!internalSheets.has(this) && typeof text === 'string' && text.includes('font-family')) {
                    const start = ENABLE_PERF_METRICS ? performance.now() : 0;
                    try {
                        text = rewriteCssContent(text);
                    } catch (e) {}
                    if (ENABLE_PERF_METRICS) {
                        perfData.replaceSyncTimeMs += (performance.now() - start);
                        perfData.replaceSyncCount++;
                    }
                }
                return origReplaceSync.call(this, text);
            };
        }
    } catch (e) {}

    try {
        if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replace) {
            const origReplace = CSSStyleSheet.prototype.replace;
            CSSStyleSheet.prototype.replace = function (text) {
                if (!internalSheets.has(this) && typeof text === 'string' && text.includes('font-family')) {
                    const start = ENABLE_PERF_METRICS ? performance.now() : 0;
                    try {
                        text = rewriteCssContent(text);
                    } catch (e) {}
                    if (ENABLE_PERF_METRICS) {
                        perfData.replaceSyncTimeMs += (performance.now() - start);
                        perfData.replaceSyncCount++;
                    }
                }
                return origReplace.call(this, text);
            };
        }
    } catch (e) {}

    try {
        const origInsertRule = CSSStyleSheet.prototype.insertRule;
        CSSStyleSheet.prototype.insertRule = function (ruleText, index) {
            if (typeof ruleText === 'string' && ruleText.includes('font-family')) {
                const start = ENABLE_PERF_METRICS ? performance.now() : 0;
                try {
                    ruleText = rewriteCssContent(ruleText);
                } catch (e) {}
                if (ENABLE_PERF_METRICS) {
                    perfData.insertRuleTimeMs += (performance.now() - start);
                    perfData.insertRuleCount++;
                }
            }
            return origInsertRule.call(this, ruleText, index);
        };
    } catch (e) {}

    try {
        if (CSSStyleSheet.prototype.addRule) {
            const origAddRule = CSSStyleSheet.prototype.addRule;
            CSSStyleSheet.prototype.addRule = function (selector, styleBlock, index) {
                if (typeof styleBlock === 'string' && styleBlock.includes('font-family')) {
                    const start = ENABLE_PERF_METRICS ? performance.now() : 0;
                    try {
                        styleBlock = rewriteCssContent(styleBlock);
                    } catch (e) {}
                    if (ENABLE_PERF_METRICS) {
                        perfData.insertRuleTimeMs += (performance.now() - start);
                        perfData.insertRuleCount++;
                    }
                }
                return origAddRule.call(this, selector, styleBlock, index);
            };
        }
    } catch (e) {}

    try {
        const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (prop, val, priority) {
            if (prop === 'font-family' && typeof val === 'string' && val) {
                const prepended = getPrependedFontFamily(val);
                if (prepended) val = prepended;
            }
            return origSetProperty.call(this, prop, val, priority);
        };
    } catch (e) {}

    try {
        const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'fontFamily');
        if (desc && desc.set) {
            const origSet = desc.set;
            Object.defineProperty(CSSStyleDeclaration.prototype, 'fontFamily', {
                get: desc.get,
                set: function (val) {
                    if (typeof val === 'string' && val) {
                        const prepended = getPrependedFontFamily(val);
                        if (prepended) val = prepended;
                    }
                    return origSet.call(this, val);
                },
                configurable: true,
                enumerable: true
            });
        }
    } catch (e) {}

    // =========================================================================
    // 靜態 CSSOM 規則處理層 (移除多餘 WeakSet 雜湊，大幅降低 V8 GC 壓力)
    // =========================================================================

    const processedSheets = new WeakSet();
    const fetchedStyleSheetUrls = new Set();

    function processStyleRule(rule) {
        if (ENABLE_PERF_METRICS) perfData.rulesChecked++;

        const style = rule.style;
        if (!style) return;

        const fontFamily = style.fontFamily;
        if (!fontFamily) return;

        const prepended = getPrependedFontFamily(fontFamily);
        if (!prepended) return;

        const selector = rule.selectorText;
        if (selector && SKIP_SELECTOR_RE.test(selector)) return;

        const priority = style.getPropertyPriority('font-family');
        style.setProperty('font-family', prepended, priority);

        if (ENABLE_PERF_METRICS) perfData.rulesRewritten++;
    }

    function processGroupingRule(groupRule) {
        let rules;
        try {
            rules = groupRule.cssRules;
        } catch (e) {
            return;
        }
        if (!rules) return;
        for (let i = 0, len = rules.length; i < len; i++) {
            const rule = rules[i];
            if (rule.type === 1) {
                processStyleRule(rule);
            } else if (rule.cssRules) {
                processGroupingRule(rule);
            }
        }
    }

    function processStyleSheet(sheet) {
        if (!sheet || processedSheets.has(sheet) || internalSheets.has(sheet)) return 0;

        const start = ENABLE_PERF_METRICS ? performance.now() : 0;

        // 精準預篩：若內聯 <style> 不含 font-family:、font: 或 @import，直接跳過整張表
        const owner = sheet.ownerNode;
        if (owner && owner.localName === 'style') {
            const rawText = owner.textContent;
            if (rawText && !HAS_FONT_DECL_RE.test(rawText)) {
                processedSheets.add(sheet);
                if (ENABLE_PERF_METRICS) {
                    perfData.sheetsSkippedFastPath++;
                    const elapsed = performance.now() - start;
                    perfData.rulesProcessTimeMs += elapsed;
                    return elapsed;
                }
                return 0;
            }
        }

        let rules;
        try {
            rules = sheet.cssRules || sheet.rules;
        } catch (e) {
            processedSheets.add(sheet);
            const href = sheet.href;
            if (href && !fetchedStyleSheetUrls.has(href)) {
                fetchedStyleSheetUrls.add(href);
                fetch(href)
                    .then((res) => (res.ok ? res.text() : null))
                    .then((cssText) => {
                        if (!cssText || !HAS_FONT_DECL_RE.test(cssText)) return;
                        const rewritten = rewriteCssContent(cssText, href);
                        if (rewritten === cssText) return;

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
                            processedSheets.add(style.sheet);
                        }
                    })
                    .catch(() => {});
            }
            const elapsed = ENABLE_PERF_METRICS ? (performance.now() - start) : 0;
            if (ENABLE_PERF_METRICS) perfData.rulesProcessTimeMs += elapsed;
            return elapsed;
        }

        if (!rules) return 0;
        processedSheets.add(sheet);

        for (let i = 0, len = rules.length; i < len; i++) {
            const rule = rules[i];
            if (rule.type === 1) {
                processStyleRule(rule);
            } else if (rule.type === 3 && rule.styleSheet) {
                processStyleSheet(rule.styleSheet);
            } else if (rule.cssRules) {
                processGroupingRule(rule);
            }
        }

        const elapsed = ENABLE_PERF_METRICS ? (performance.now() - start) : 0;
        if (ENABLE_PERF_METRICS) {
            perfData.rulesProcessTimeMs += elapsed;
        }
        return elapsed;
    }

    function processAllStyleSheets() {
        const sheets = document.styleSheets;
        if (!sheets) return;
        for (let i = 0, len = sheets.length; i < len; i++) {
            processStyleSheet(sheets[i]);
        }
    }

    function processInlineStyle(element) {
        if (element.nodeType !== 1) return;
        const styleAttr = element.getAttribute('style');
        if (!styleAttr || !styleAttr.includes('font')) return;

        const style = element.style;
        if (!style) return;
        const inlineFont = style.fontFamily;
        if (!inlineFont) return;

        const prepended = getPrependedFontFamily(inlineFont);
        if (!prepended) return;

        const priority = style.getPropertyPriority('font-family');
        style.setProperty('font-family', prepended, priority);
    }

    // =========================================================================
    // 兩階段 DOM 變更監聽層 (消除 HTML 串流解析期的 147 次 Mutation 風暴)
    // =========================================================================

    function handleAddedNode(node) {
        if (node.nodeType !== 1) return 0;

        const tag = node.localName;
        if (tag === 'style' || (tag === 'link' && node.relList && node.relList.contains('stylesheet'))) {
            if (node.sheet) {
                return processStyleSheet(node.sheet);
            }
            node.addEventListener('load', () => {
                if (node.sheet) processStyleSheet(node.sheet);
            }, { once: true });
            return 0;
        }

        if (node.shadowRoot) {
            injectIntoShadowRoot(node.shadowRoot);
        }

        if (node.hasAttribute('style')) {
            processInlineStyle(node);
        }
        return 0;
    }

    const observer = new MutationObserver((mutations) => {
        const start = ENABLE_PERF_METRICS ? performance.now() : 0;
        let sheetTimeInMutation = 0;

        for (let i = 0, len = mutations.length; i < len; i++) {
            const mutation = mutations[i];
            if (mutation.type === 'childList') {
                const added = mutation.addedNodes;
                for (let j = 0, aLen = added.length; j < aLen; j++) {
                    sheetTimeInMutation += handleAddedNode(added[j]);
                }
            } else if (mutation.type === 'attributes') {
                processInlineStyle(mutation.target);
            }
        }

        if (ENABLE_PERF_METRICS) {
            const totalElapsed = performance.now() - start;
            perfData.mutationTimeMs += Math.max(0, totalElapsed - sheetTimeInMutation);
            perfData.mutationBatches++;
        }
    });

    /**
     * 階段二監聽：於 DOM 解析完成後啟動全樹監聽，處理 SPA 動態操作。
     */
    function startFullDocumentObserver() {
        if (!document.documentElement) return;
        observer.disconnect();
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style']
        });
    }

    /**
     * 階段一監聽：於 HTML 載入解析期間僅監聽 <head> 內的樣式表新增，完全避免 <body> 解析期的數千節點觸發風暴。
     */
    function startEarlyHeadObserver() {
        if (document.head) {
            observer.observe(document.head, { childList: true });
            return;
        }
        const headWaiter = new MutationObserver(() => {
            if (document.head) {
                headWaiter.disconnect();
                injectCustomFonts();
                if (!initialized) {
                    observer.observe(document.head, { childList: true });
                }
            }
        });
        headWaiter.observe(document.documentElement || document, { childList: true, subtree: true });
    }

    function injectCustomFonts() {
        if (document.getElementById(STYLE_ID)) return;
        const parent = document.head || document.documentElement;
        if (!parent) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = GLOBAL_RULES;
        parent.appendChild(style);
        if (style.sheet) {
            internalSheets.add(style.sheet);
        }
    }

    let initialized = false;

    function init() {
        if (initialized) return;
        initialized = true;

        const initStart = ENABLE_PERF_METRICS ? performance.now() : 0;

        injectCustomFonts();
        processAllStyleSheets();

        if (document.documentElement) {
            const styledNodes = document.querySelectorAll('[style*="font"]');
            for (let i = 0, len = styledNodes.length; i < len; i++) {
                processInlineStyle(styledNodes[i]);
            }
        }

        startFullDocumentObserver();

        if (ENABLE_PERF_METRICS) {
            const now = performance.now();
            perfData.initCpuTimeMs += (now - initStart);
            perfData.domReadyWallClockMs = now - perfData.scriptStartTime;
        }
    }

    const earlyStart = ENABLE_PERF_METRICS ? performance.now() : 0;
    injectCustomFonts();

    if (document.readyState === 'loading') {
        startEarlyHeadObserver();
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    if (ENABLE_PERF_METRICS) {
        perfData.initCpuTimeMs += (performance.now() - earlyStart);
    }

    document.addEventListener('load', (event) => {
        const target = event.target;
        if (target && target.nodeType === 1) {
            const tag = target.localName;
            if ((tag === 'style' || (tag === 'link' && target.relList && target.relList.contains('stylesheet'))) && target.sheet) {
                processStyleSheet(target.sheet);
            }
        }
    }, true);
})();
