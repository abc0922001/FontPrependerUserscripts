import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

function createEnvironment(html = '<!DOCTYPE html><html><head></head><body></body></html>', beforeInit, options = {}) {
  const dom = new JSDOM(html, {
    url: options.url || 'https://example.com/',
    runScripts: 'dangerously'
  });

  const { window } = dom;

  if (typeof beforeInit === 'function') {
    beforeInit(window, window.document);
  }

  const { document, Element, HTMLElement, MutationObserver, CSSStyleSheet, CSSStyleDeclaration } = window;

  const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
  const module = { exports: {} };

  const context = vm.createContext({
    window,
    document,
    Element,
    HTMLElement,
    MutationObserver,
    CSSStyleSheet,
    CSSStyleDeclaration,
    URL: window.URL,
    setTimeout,
    clearTimeout,
    console,
    module,
    exports: module.exports,
    ...(options.sandbox || {})
  });

  vm.runInContext(code, context);

  return {
    dom,
    window,
    document,
    exports: module.exports
  };
}

describe('DOM / CSSOM 與特例整合測試', () => {
  it('1. 應於 <head> 注入基礎層降級樣式與編輯器樣式', () => {
    const { document, exports } = createEnvironment();
    exports.injectBaseStyles(document);

    const baseStyle = document.querySelector('#font-prepender-base-style');
    expect(baseStyle).not.toBeNull();
    expect(baseStyle.textContent).toContain(':where(html, body, :host)');
    expect(baseStyle.textContent).toContain(exports.BASE_SANS_STACK);
    expect(baseStyle.textContent).toContain(exports.BASE_MONO_STACK);

    const editorStyle = document.querySelector('#font-prepender-editor-style');
    expect(editorStyle).not.toBeNull();
    expect(editorStyle.textContent).toContain('.monaco-editor');

    // 測試重複注入冪等性
    exports.injectBaseStyles(document);
    expect(document.querySelectorAll('#font-prepender-base-style').length).toBe(1);

    // 驗證已將自身樣式表加入 processedStyleSheets 避免重複掃描
    if (baseStyle.sheet) {
      expect(exports.processedStyleSheets.has(baseStyle.sheet)).toBe(true);
    }
  });

  it('2. 應正確掃描並就地改寫 CSSOM 規則中的 font-family', () => {
    const { document, exports } = createEnvironment();
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .title { font-family: Arial, sans-serif; }
      pre.code { font-family: monospace; }
      .icon-box { font-family: "FontAwesome"; }
    `;
    document.head.appendChild(styleEl);

    const sheet = styleEl.sheet;
    expect(sheet).toBeDefined();

    exports.processStyleSheet(sheet);

    const titleRule = Array.from(sheet.cssRules).find(r => r.selectorText === '.title');
    expect(titleRule.style.getPropertyValue('font-family')).toContain('Google Sans');

    const codeRule = Array.from(sheet.cssRules).find(r => r.selectorText === 'pre.code');
    expect(codeRule.style.getPropertyValue('font-family')).toContain('Intel One Mono');

    const iconRule = Array.from(sheet.cssRules).find(r => r.selectorText === '.icon-box');
    expect(iconRule.style.getPropertyValue('font-family')).toBe('"FontAwesome"');
  });

  it('3. 應正確處理 CSS 巢狀群組規則 (@media)', () => {
    const { document, exports } = createEnvironment();
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @media screen and (min-width: 600px) {
        .content { font-family: sans-serif; }
      }
    `;
    document.head.appendChild(styleEl);

    exports.processStyleSheet(styleEl.sheet);

    const mediaRule = styleEl.sheet.cssRules[0];
    expect(mediaRule).toBeDefined();
    const innerRule = mediaRule.cssRules[0];
    expect(innerRule.style.getPropertyValue('font-family')).toContain('Google Sans');
  });

  it('3.1 應遞迴處理 @import 匯入之子樣式表 (CSSImportRule)', () => {
    const { exports } = createEnvironment();

    let childFont = 'sans-serif';
    const mockChildSheet = {
      cssRules: [
        {
          selectorText: '.imported-title',
          style: {
            getPropertyValue: (prop) => (prop === 'font-family' ? childFont : ''),
            getPropertyPriority: () => '',
            setProperty: (prop, val) => {
              if (prop === 'font-family') childFont = val;
            },
            length: 0
          }
        }
      ]
    };

    const mockParentRules = [
      {
        styleSheet: mockChildSheet
      }
    ];

    exports.processRules(mockParentRules);
    expect(childFont).toContain('Google Sans');
  });

  it('4. 跨域樣式表 (CORS) 存取拋出 SecurityError 時應安全捕捉並不崩潰，且以 hasCorsSheets 閘門控制排程', () => {
    const { exports, window } = createEnvironment();

    expect(exports.getHasCorsSheets()).toBe(false);

    // 在無跨域樣式表下呼叫 scheduleIdleComputedStylePatch 應被閘門短路攔截
    window.requestIdleCallback = vi.fn();
    exports.scheduleIdleComputedStylePatch();
    expect(window.requestIdleCallback).not.toHaveBeenCalled();

    const mockCorsSheet = {
      get cssRules() {
        throw new Error('SecurityError: Failed to read the cssRules property from CSSStyleSheet');
      }
    };

    expect(() => {
      exports.processStyleSheet(mockCorsSheet);
    }).not.toThrow();

    expect(exports.getHasCorsSheets()).toBe(true);
  });

  it('5. 應攔截 Element.prototype.attachShadow 並為 open 模式 ShadowRoot 掛載基礎樣式', () => {
    const { document, exports } = createEnvironment();
    exports.hookShadowDOM();

    const host = document.createElement('div');
    document.body.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    expect(shadowRoot).toBeDefined();

    const shadowBaseStyle = shadowRoot.querySelector('#font-prepender-base-style');
    expect(shadowBaseStyle).not.toBeNull();
    expect(shadowBaseStyle.textContent).toContain(':where(html, body, :host)');
    expect(shadowBaseStyle.textContent).toContain('Google Sans');
  });

  it('5.0 支援 adoptedStyleSheets 時，sharedBaseSheet 應包含 :host 選擇器並共用掛載至 ShadowRoot', () => {
    let capturedSheetText = '';
    const { document, exports } = createEnvironment('<!DOCTYPE html><html><head></head><body></body></html>', (win) => {
      win.CSSStyleSheet.prototype.replaceSync = function(text) {
        this._text = text;
        if (text.includes(':host')) {
          capturedSheetText = text;
        }
      };
    });

    exports.initSharedConstructableStyles();
    const sharedBase = exports.getSharedBaseSheet();
    const sharedEditor = exports.getSharedEditorSheet();
    expect(sharedBase).not.toBeNull();
    expect(sharedEditor).not.toBeNull();
    expect(capturedSheetText).toContain(':where(html, body, :host)');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.adoptedStyleSheets = [];

    exports.injectBaseStyles(shadowRoot);
    expect(shadowRoot.adoptedStyleSheets).toContain(sharedBase);
    expect(shadowRoot.adoptedStyleSheets).toContain(sharedEditor);
  });

  it('5.1 應穿透掃描既有與 Declarative Shadow DOM (scanAndPatchShadowRoots)', () => {
    let capturedShadowRoot = null;
    const { document, exports } = createEnvironment('<!DOCTYPE html><html><head></head><body></body></html>', (win, doc) => {
      const customHost = doc.createElement('custom-card');
      doc.body.appendChild(customHost);
      capturedShadowRoot = customHost.attachShadow({ mode: 'open' });
      const p = doc.createElement('p');
      p.className = 'shadow-desc';
      p.style.fontFamily = 'Arial, sans-serif';
      p.textContent = 'Shadow Content';
      capturedShadowRoot.appendChild(p);
    });

    // 呼叫穿透掃描
    exports.scanAndPatchShadowRoots(document);

    const baseStyle = capturedShadowRoot.querySelector('#font-prepender-base-style');
    expect(baseStyle).not.toBeNull();
    expect(baseStyle.textContent).toContain('Google Sans');

    const p = capturedShadowRoot.querySelector('.shadow-desc');
    expect(p.style.getPropertyValue('font-family')).toContain('Google Sans');
  });

  it('6. 應支援 adoptedStyleSheets 樣式表改寫', () => {
    const { document, exports, window } = createEnvironment();

    // 模擬 Constructable Stylesheets
    const mockAdoptedSheet = {
      cssRules: [
        {
          selectorText: '.component-text',
          style: {
            getPropertyValue: (prop) => (prop === 'font-family' ? 'Helvetica, sans-serif' : ''),
            getPropertyPriority: () => '',
            setProperty: vi.fn(),
            length: 0
          }
        }
      ]
    };

    document.adoptedStyleSheets = [mockAdoptedSheet];
    exports.scanAndPatchStyleSheets(document);

    expect(mockAdoptedSheet.cssRules[0].style.setProperty).toHaveBeenCalledWith(
      'font-family',
      expect.stringContaining('Google Sans'),
      ''
    );
  });

  it('7. 應攔截 CSSStyleSheet.prototype.replace 非同步方法並改寫字型宣告', async () => {
    const { window, exports } = createEnvironment();
    let capturedText = '';
    window.CSSStyleSheet.prototype.replace = function(text) {
      capturedText = text;
      return Promise.resolve(this);
    };

    exports.hookCSSPrototypes();

    const sheet = Object.create(window.CSSStyleSheet.prototype);
    await sheet.replace('.async-card { font-family: Arial, sans-serif; } pre.code { font-family: sans-serif; }');

    expect(capturedText).toContain(`font-family: ${exports.SANS_PREPEND_STR}Arial, sans-serif`);
    expect(capturedText).toContain(`font-family: ${exports.MONO_PREPEND_STR}sans-serif`);
  });

  it('8. 原型鏈 setProperty 與 fontFamily setter 應能感知關聯元素之標籤與圖示上下文', () => {
    const { document, exports } = createEnvironment();
    exports.hookCSSPrototypes();

    const codeEl = document.createElement('code');
    document.body.appendChild(codeEl);
    codeEl.style.fontFamily = 'var(--user-custom)';
    expect(codeEl.style.getPropertyValue('font-family')).toContain('Intel One Mono');

    const iconEl = document.createElement('i');
    iconEl.className = 'fas';
    document.body.appendChild(iconEl);
    iconEl.style.setProperty('font-family', 'sans-serif');
    expect(iconEl.style.getPropertyValue('font-family')).toBe('sans-serif');
  });

  // Issue #4: Chrome 內建整頁翻譯相容性防護
  it('9. isTranslationNode 應精確識別 Chrome 整頁翻譯產生的純翻譯節點', () => {
    const { document, exports } = createEnvironment();
    const { isTranslationNode } = exports;

    const fontEl = document.createElement('font');
    fontEl.setAttribute('style', 'vertical-align: inherit;');
    expect(isTranslationNode(fontEl)).toBe(true);

    const normalDiv = document.createElement('div');
    expect(isTranslationNode(normalDiv)).toBe(false);

    // 若使用者或網站顯式指定了 font-family 於 <font> 上，不應視為純翻譯節點
    const styledFont = document.createElement('font');
    styledFont.style.fontFamily = 'Arial, sans-serif';
    expect(isTranslationNode(styledFont)).toBe(false);
  });

  it('10. Chrome 整頁翻譯注入動態 <font> 節點時，不應誘發子樹重排、樣式覆寫或跨域計算修補排程 (Issue #4)', async () => {
    const { document, exports, window } = createEnvironment('<!DOCTYPE html><html><head></head><body><p id="article-p"></p></body></html>');
    window.requestIdleCallback = vi.fn();

    // 模擬已存在跨域樣式表 (hasCorsSheets)
    const mockCorsSheet = {
      get cssRules() {
        throw new Error('SecurityError');
      }
    };
    exports.processStyleSheet(mockCorsSheet);
    expect(exports.getHasCorsSheets()).toBe(true);

    // 等待 JSDOM 首屏生命週期 (DOMContentLoaded / Load) 事件消化完畢
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.requestIdleCallback.mockClear();

    const paragraph = document.getElementById('article-p');

    // 模擬 Chrome 整頁翻譯：將段落內的英文 Text 替換為雙層 <font> 標籤
    const outerFont = document.createElement('font');
    outerFont.setAttribute('style', 'vertical-align: inherit;');
    const innerFont = document.createElement('font');
    innerFont.setAttribute('style', 'vertical-align: inherit;');
    innerFont.textContent = '繁體中文翻譯文字';
    outerFont.appendChild(innerFont);

    // 監聽器應在 childList 與 attributes 監聽中忽略 translation nodes
    paragraph.appendChild(outerFont);

    // 等待 MutationObserver 非同步事件派發
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 驗證未對 <font> 標籤寫入任何 font-family 內聯樣式
    expect(outerFont.style.getPropertyValue('font-family')).toBe('');
    expect(innerFont.style.getPropertyValue('font-family')).toBe('');

    // 驗證未觸發跨域樣式空閒期修補排程 (requestIdleCallback)
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
  });

  // Issue #1 & #3: DOM 單次掃描、剪枝與祖先去重
  it('11. 新增 DOM 節點時應執行剪枝與祖先去重，消除重複子樹遍歷 (Issue #1, #3)', async () => {
    const { document, exports } = createEnvironment();
    exports.observeStyleSheets(document);

    const container = document.createElement('div');
    container.className = 'top-container';

    // 剪枝節點：SVG 與 SCRIPT
    const svgNode = document.createElement('svg');
    const pathNode = document.createElement('path');
    svgNode.appendChild(pathNode);
    container.appendChild(svgNode);

    // 含有行內樣式之一般子節點
    const subText = document.createElement('span');
    subText.setAttribute('style', 'font-family: Arial, sans-serif;');
    container.appendChild(subText);

    // 同時將父容器與子節點放入同一個 append 動作中
    document.body.appendChild(container);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(subText.style.getPropertyValue('font-family')).toContain('Google Sans');
  });

  // Issue #3 目標五: 合併 MutationObserver 的重複屬性變更
  it('12. 同一 MutationObserver callback 中多筆相同元素的 style 變動應被合併 (Issue #3)', async () => {
    const { document, exports } = createEnvironment();
    exports.observeStyleSheets(document);

    const testEl = document.createElement('div');
    document.body.appendChild(testEl);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 連續變更 3 次 style 屬性
    testEl.setAttribute('style', 'color: red;');
    testEl.setAttribute('style', 'color: blue;');
    testEl.setAttribute('style', 'font-family: Arial, sans-serif;');

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(testEl.style.getPropertyValue('font-family')).toContain('Google Sans');
  });

  // Issue #1 & #3 目標二: Computed Style 時間切片與大於 500 筆元素的自動續排
  it('13. patchComputedStyles 應支援時間切片與超過 500 筆元素的自動續排推進 (Issue #1, #3)', () => {
    const { document, exports, window } = createEnvironment();

    let idleRunner = null;
    window.requestIdleCallback = vi.fn((cb) => {
      idleRunner = cb;
    });

    // 模擬頁面存在跨域樣式表 (hasCorsSheets = true)
    exports.processStyleSheet({
      get cssRules() {
        throw new Error('SecurityError');
      }
    });
    expect(exports.getHasCorsSheets()).toBe(true);

    // 消化初次排程回呼，將 isIdlePatchScheduled 重設為 false
    if (idleRunner) {
      idleRunner();
      idleRunner = null;
    }
    window.requestIdleCallback.mockClear();

    // 建立 600 個 h2 標題元素
    for (let i = 0; i < 600; i++) {
      const h2 = document.createElement('h2');
      h2.textContent = `Title ${i}`;
      document.body.appendChild(h2);
    }

    window.getComputedStyle = () => ({ fontFamily: 'Arial, sans-serif' });

    // 傳入一個 timeRemaining 耗盡的 mock deadline 模擬時間片用完
    const mockDeadline = {
      timeRemaining: () => 0.5
    };

    // 執行帶有 deadline 的計算樣式修補
    exports.patchComputedStyles(mockDeadline);

    // 驗證因時間片用完且佇列未消化完畢，自動排程了下一批
    expect(window.requestIdleCallback).toHaveBeenCalled();
  });

  // Issue #2 Task 4 & Issue #6: 跨域 CSS fetch 防護（字型 CDN / gstatic 跳過與 1MB 限制）
  it('14. 跨域樣式表為 Google Fonts、gstatic 或檔案超過 1MB 時應跳過改寫並保留計算樣式修補備援 (Issue #2, #6)', async () => {
    const { exports, window } = createEnvironment();
    window.requestIdleCallback = vi.fn();

    const fetchSpy = vi.fn();
    window.fetch = fetchSpy;

    // 模擬 Google Fonts 與 gstatic 跨域樣式表
    const googleFontSheet = {
      href: 'https://fonts.googleapis.com/css2?family=Roboto&display=swap',
      get cssRules() {
        throw new Error('SecurityError');
      }
    };
    const gstaticSheet = {
      href: 'https://www.gstatic.com/recaptcha/releases/4i3aN5wAweL7i3ADI7BSX4B-/styles__ltr.css',
      get cssRules() {
        throw new Error('SecurityError');
      }
    };

    exports.processStyleSheet(googleFontSheet);
    exports.processStyleSheet(gstaticSheet);

    // 應命中 SKIP_FETCH_HOST_REGEX 直接跳過 fetch，但保留 hasCorsSheets 降級備援
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exports.getHasCorsSheets()).toBe(true);
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);

    // 獨立環境驗證 Content-Length > 1MB 檔案大小防護
    const largeEnv = createEnvironment();
    largeEnv.window.requestIdleCallback = vi.fn();
    const largeFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? '2000000' : null) },
      text: async () => '.huge { font-family: Arial, sans-serif; }'
    });
    largeEnv.window.fetch = largeFetchSpy;

    largeEnv.exports.processStyleSheet({
      href: 'https://cdn.example.com/huge.css',
      get cssRules() {
        throw new Error('SecurityError');
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(largeFetchSpy).toHaveBeenCalledTimes(1);
    expect(largeEnv.document.querySelector('style[data-prepended-source]')).toBeNull();
    expect(largeEnv.exports.getHasCorsSheets()).toBe(true);
    expect(largeEnv.window.requestIdleCallback).toHaveBeenCalledTimes(1);
  });

  // Issue #3 目標七: 初始化與 Hook 冪等性
  it('15. 重複呼叫 init() 與 hookCSSPrototypes() 應具備嚴格冪等性 (Issue #3)', () => {
    const { exports, document } = createEnvironment();

    // 重複呼叫多次 init
    expect(() => {
      exports.init();
      exports.init();
      exports.hookCSSPrototypes();
      exports.hookShadowDOM();
      exports.observeStyleSheets(document);
    }).not.toThrow();
  });

  // Issue #5: 兩階段 MutationObserver 消除 HTML Streaming 解析期 CPU 負載風暴
  it('16. 載入期 (loading) 應僅監聽 <head> 樣式表而隔離 <body> 節點風暴，並於 DOMContentLoaded 後無縫升級為全域監聽 (Issue #5)', async () => {
    let observerCallbackCount = 0;
    let disconnectCount = 0;
    let controlledState = 'loading';
    let triggerDCL = null;

    const { document } = createEnvironment('<!DOCTYPE html><html><head></head><body></body></html>', (win, doc) => {
      // 鎖定可控的串流解析階段，攔截 JSDOM 預設於 nextTick 自動觸發之 DOMContentLoaded
      Object.defineProperty(doc, 'readyState', {
        configurable: true,
        get: () => controlledState
      });
      const origAddEventListener = doc.addEventListener.bind(doc);
      doc.addEventListener = (type, listener, options) => {
        if (type === 'DOMContentLoaded') {
          triggerDCL = listener;
          return;
        }
        return origAddEventListener(type, listener, options);
      };

      const OrigMO = win.MutationObserver;
      win.MutationObserver = class SpyMutationObserver extends OrigMO {
        constructor(cb) {
          super((mutations, obs) => {
            observerCallbackCount++;
            return cb(mutations, obs);
          });
        }
        disconnect() {
          disconnectCount++;
          return super.disconnect();
        }
      };
    });

    // 確認目前處於受控 HTML 串流解析階段 (readyState === 'loading')
    expect(document.readyState).toBe('loading');
    expect(typeof triggerDCL).toBe('function');
    observerCallbackCount = 0;

    // 1. 於 <head> 動態插入 <style>，Phase 1 應在微任務內即時攔截並改寫
    const headStyle = document.createElement('style');
    headStyle.textContent = '.streaming-hero { font-family: Arial, sans-serif; }';
    document.head.appendChild(headStyle);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(headStyle.sheet.cssRules[0].style.getPropertyValue('font-family')).toContain('Google Sans');
    expect(observerCallbackCount).toBe(1);

    // 2. 模擬瀏覽器串流解析大量 <body> 節點與屬性變更：Phase 1 完全不應觸發任何 MutationObserver 回呼
    observerCallbackCount = 0;
    const bodyFragment = document.createDocumentFragment();
    let streamingInlineSpan = null;
    for (let i = 0; i < 200; i++) {
      const div = document.createElement('div');
      if (i === 100) {
        streamingInlineSpan = document.createElement('span');
        streamingInlineSpan.setAttribute('style', 'font-family: Arial, sans-serif;');
        div.appendChild(streamingInlineSpan);
      }
      bodyFragment.appendChild(div);
    }
    document.body.appendChild(bodyFragment);
    streamingInlineSpan.setAttribute('style', 'color: #333; font-family: Georgia, serif;');

    await new Promise((resolve) => setTimeout(resolve, 15));
    // 驗證 <body> 串流期間零 MutationObserver 微任務喚醒，且靜態行內樣式留待 DOMContentLoaded 批次處理
    expect(observerCallbackCount).toBe(0);
    expect(streamingInlineSpan.style.getPropertyValue('font-family')).toBe('Georgia, serif');

    // 3. 觸發 DOMContentLoaded：應先 disconnect Phase 1、一次性補齊 <body> 行內樣式，再掛載 Phase 2
    observerCallbackCount = 0;
    controlledState = 'interactive';
    triggerDCL();

    expect(disconnectCount).toBe(1);
    expect(streamingInlineSpan.style.getPropertyValue('font-family')).toContain('Google Sans');

    // 驗證補齊掃描期間的內部寫入未觸發多餘的 Phase 2 MutationRecord（因為先完成掃描才 observe Phase 2）
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(observerCallbackCount).toBe(0);

    // 4. 進入互動期 (Phase 2) 後，動態插入 <body> 的節點與 style 屬性變動應即時被攔截改寫
    const spaNode = document.createElement('div');
    spaNode.setAttribute('style', 'font-family: Verdana, sans-serif;');
    document.body.appendChild(spaNode);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(observerCallbackCount).toBe(1);
    expect(spaNode.style.getPropertyValue('font-family')).toContain('Google Sans');
  });

  it('17. 極早期 document-start 尚無 <head> 節點時，Phase 1 應在 <head> 掛載瞬間自動銜接樣式表監聽 (Issue #5)', async () => {
    const { document } = createEnvironment('<!DOCTYPE html><html><head></head><body></body></html>', (win, doc) => {
      Object.defineProperty(doc, 'readyState', {
        configurable: true,
        get: () => 'loading'
      });
      doc.addEventListener = (type) => {
        if (type === 'DOMContentLoaded') return;
      };
      // 模擬極早期 document-start：僅有 <html> 而 <head> 與 <body> 尚未被解析器建立
      if (doc.head) doc.head.remove();
      if (doc.body) doc.body.remove();
    });

    expect(document.readyState).toBe('loading');
    expect(document.head).toBeNull();

    // 1. 模擬 HTML 解析器建立 <head> 並同時帶有首個內嵌 <style>
    const newHead = document.createElement('head');
    const firstStyle = document.createElement('style');
    firstStyle.textContent = '.early-first { font-family: Helvetica, sans-serif; }';
    newHead.appendChild(firstStyle);
    document.documentElement.appendChild(newHead);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(firstStyle.sheet.cssRules[0].style.getPropertyValue('font-family')).toContain('Google Sans');

    // 2. 後續繼續串流插入 <head> 的第二個 <style> 也應被自動銜接的 <head> 監聽器即時改寫
    const secondStyle = document.createElement('style');
    secondStyle.textContent = '.early-second { font-family: Tahoma, sans-serif; }';
    newHead.appendChild(secondStyle);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(secondStyle.sheet.cssRules[0].style.getPropertyValue('font-family')).toContain('Google Sans');
  });

  // Issue #6: 跨網域外部樣式表 fetch 防護與第三方功能型 iframe 隔離
  it('18. 純第三方功能元件 CSS、非 HTTP(S) 與列印樣式表應直接短路返回且不誤觸發全頁計算樣式掃描 (Issue #6)', () => {
    const { exports, window } = createEnvironment();
    window.requestIdleCallback = vi.fn();

    const fetchSpy = vi.fn();
    window.fetch = fetchSpy;

    const skipCases = [
      { href: 'https://accounts.google.com/gsi/style' },
      { href: 'https://www.google.com/recaptcha/api2/styles.css' },
      { href: 'https://challenges.cloudflare.com/turnstile/v0/style.css' },
      { href: 'https://pagead2.googlesyndication.com/pagead/style.css' },
      { href: 'chrome-extension://abcdef123456/inject.css' },
      { href: 'https://cdn.example.com/print.css', media: { mediaText: 'print' } }
    ];

    for (const item of skipCases) {
      exports.processStyleSheet({
        ...item,
        get cssRules() {
          throw new Error('SecurityError');
        }
      });
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exports.getHasCorsSheets()).toBe(false);
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
  });

  it('19. 主站獨立 CDN 跨網域樣式表應正常 fetch 改寫並於原 <link> 後方注入 <style> (Issue #6)', async () => {
    const { document, exports, window } = createEnvironment();
    window.requestIdleCallback = vi.fn();

    const cdnUrl = 'https://static0.xdaimages.com/assets/main.css';
    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = cdnUrl;
    document.head.appendChild(linkEl);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => '128' },
      text: async () => '.article-title { font-family: "Titillium Web", sans-serif; }'
    });
    window.fetch = fetchSpy;

    exports.processStyleSheet({
      href: cdnUrl,
      ownerNode: linkEl,
      get cssRules() {
        throw new Error('SecurityError');
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(cdnUrl, { cache: 'force-cache' });

    const injectedStyle = linkEl.nextSibling;
    expect(injectedStyle).not.toBeNull();
    expect(injectedStyle.tagName).toBe('STYLE');
    expect(injectedStyle.getAttribute('data-prepended-source')).toBe(cdnUrl);
    expect(injectedStyle.textContent).toContain('Google Sans');
    expect(injectedStyle.textContent).toContain('Titillium Web');
    expect(exports.getHasCorsSheets()).toBe(false);
  });

  it('20. 未知第三方 origin 初次 fetch 失敗後應記錄熔斷，避免後續同主機樣式表重複發起請求 (Issue #6)', async () => {
    const { exports, window } = createEnvironment();
    window.requestIdleCallback = vi.fn();

    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    window.fetch = fetchSpy;

    exports.processStyleSheet({
      href: 'https://widget.unknown.example/a.css',
      get cssRules() {
        throw new Error('SecurityError');
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(exports.failedFetchOrigins.has('https://widget.unknown.example')).toBe(true);
    expect(exports.getHasCorsSheets()).toBe(true);
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);

    // 同 origin 的第二支樣式表應立即命中熔斷，不再呼叫 fetch
    exports.processStyleSheet({
      href: 'https://widget.unknown.example/b.css',
      get cssRules() {
        throw new Error('SecurityError');
      }
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('21. shouldSkipCurrentFrame 應精準區分頂層視窗、閱讀型子框架與第三方功能型 iframe，且支援無 window 防呆 (Issue #6)', () => {
    // 1. 無 window 環境下無參數呼叫不應拋錯
    const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
    const bareModule = { exports: {} };
    vm.runInContext(code, vm.createContext({ module: bareModule, exports: bareModule.exports, console }));
    expect(() => bareModule.exports.shouldSkipCurrentFrame()).not.toThrow();
    expect(bareModule.exports.shouldSkipCurrentFrame()).toBe(false);

    const { exports } = createEnvironment();
    const { shouldSkipCurrentFrame } = exports;

    const makeWin = (hrefStr, isSubFrame) => {
      const u = new URL(hrefStr);
      const topObj = {};
      const winObj = {
        top: isSubFrame ? topObj : null,
        location: { hostname: u.hostname, href: u.href }
      };
      winObj.self = winObj;
      if (!isSubFrame) winObj.top = winObj;
      return winObj;
    };

    // 2. 頂層視窗 (self === top)：即使造訪 Google 登入或 reCAPTCHA 頁亦不應跳過
    expect(shouldSkipCurrentFrame(makeWin('https://www.google.com/recaptcha/api2/anchor', false))).toBe(false);
    expect(shouldSkipCurrentFrame(makeWin('https://accounts.google.com/signin', false))).toBe(false);

    // 3. 第三方功能型子框架 (self !== top)：應提早返回
    const skippedFrames = [
      'https://www.google.com/recaptcha/api2/anchor?k=1',
      'https://accounts.google.com/gsi/iframe',
      'https://newassets.hcaptcha.com/captcha/v1/frame.html',
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g',
      'https://googleads.g.doubleclick.net/pagead/ads',
      'https://js.stripe.com/v3/elements-inner-card',
      'https://platform.twitter.com/widgets/follow_button.html',
      'https://www.facebook.com/plugins/like.php'
    ];
    for (const url of skippedFrames) {
      expect(shouldSkipCurrentFrame(makeWin(url, true))).toBe(true);
    }

    // 4. 閱讀型子框架與空白框架 (self !== top)：應保留字型覆寫
    const preservedFrames = [
      'https://example.com/embedded-article',
      'https://disqus.com/embed/comments/',
      'https://platform.twitter.com/embed/Tweet.html',
      'about:blank'
    ];
    for (const url of preservedFrames) {
      expect(shouldSkipCurrentFrame(makeWin(url, true))).toBe(false);
    }
  });

  it('22. Google reCAPTCHA iframe 載入時 init() 應提早返回且零注入與零 fetch，閱讀型 iframe 仍正常初始化 (Issue #6)', () => {
    const runInSubFrame = (frameUrl, html) => {
      const dom = new JSDOM(html, { url: frameUrl, runScripts: 'dangerously' });
      const { window } = dom;
      const { document, Element, HTMLElement, MutationObserver, CSSStyleSheet, CSSStyleDeclaration } = window;
      const fetchSpy = vi.fn();
      window.fetch = fetchSpy;

      const parentTop = {};
      const frameWindowProxy = new Proxy(window, {
        get(target, prop) {
          if (prop === 'top') return parentTop;
          if (prop === 'self' || prop === 'window') return frameWindowProxy;
          const val = Reflect.get(target, prop, target);
          return typeof val === 'function' ? val.bind(target) : val;
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        }
      });

      const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
      const module = { exports: {} };
      vm.runInContext(code, vm.createContext({
        window: frameWindowProxy,
        document,
        Element,
        HTMLElement,
        MutationObserver,
        CSSStyleSheet,
        CSSStyleDeclaration,
        URL: window.URL,
        setTimeout,
        clearTimeout,
        console,
        module,
        exports: module.exports
      }));

      return { document, exports: module.exports, fetchSpy };
    };

    // Google reCAPTCHA anchor iframe：完全跳過初始化
    const recaptchaEnv = runInSubFrame(
      'https://www.google.com/recaptcha/api2/anchor?k=test',
      '<!DOCTYPE html><html><head></head><body><div class="rc-anchor">reCAPTCHA</div></body></html>'
    );
    expect(recaptchaEnv.exports.getIsInitialized()).toBe(false);
    expect(recaptchaEnv.document.querySelector('#font-prepender-base-style')).toBeNull();
    expect(recaptchaEnv.fetchSpy).not.toHaveBeenCalled();

    // 跨源閱讀型子框架（Disqus）：正常初始化並注入基礎樣式
    const disqusEnv = runInSubFrame(
      'https://disqus.com/embed/comments/?base=default',
      '<!DOCTYPE html><html><head></head><body><div id="layout"><p>留言內容</p></div></body></html>'
    );
    expect(disqusEnv.exports.getIsInitialized()).toBe(true);
    expect(disqusEnv.document.querySelector('#font-prepender-base-style')).not.toBeNull();
  });

  it('23. 條件式剖析器於未啟用 fp-profile 時應保持零開銷且不建立 window.__fpProf', () => {
    const { window } = createEnvironment();
    expect(window.__fpProf).toBeUndefined();
  });

  it('24. 啟用 fp-profile=1 時應準確記錄 9 個核心熱點之呼叫次數與耗時，且巢狀 @media 不重複計時', async () => {
    const { document, exports, window } = createEnvironment(
      '<!DOCTYPE html><html><head><style>@media screen { .nested { font-family: Arial, sans-serif; } }</style></head><body><div id="inline-box" style="font-family: Helvetica, sans-serif;">Hello</div></body></html>',
      (win, doc) => {
        Object.defineProperty(doc, 'readyState', { configurable: true, get: () => 'complete' });
      },
      {
        sandbox: {
          localStorage: {
            getItem: (key) => (key === 'fp-profile' ? '1' : null)
          },
          performance
        }
      }
    );

    expect(window.__fpProf).toBeDefined();

    // 觸發尚未於 init() 執行之熱點：rewriteCssContent、patchComputedStyles 與 phase2Observer
    exports.rewriteCssContent('.card { font-family: Arial, sans-serif; }');

    window.getComputedStyle = () => ({ fontFamily: 'Georgia, serif' });
    const h2 = document.createElement('h2');
    h2.textContent = 'Headline';
    document.body.appendChild(h2);
    exports.patchComputedStyles();

    // 等待 phase2Observer 微任務處理剛剛插入之 h2 與新增行內樣式節點
    const dynamicSpan = document.createElement('span');
    dynamicSpan.setAttribute('style', 'font-family: Verdana, sans-serif;');
    document.body.appendChild(dynamicSpan);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const expectedHotspots = [
      'prependFontFamily',
      'rewriteCssContent',
      'processStyleSheet',
      'processRules',
      'scanAndPatchInlineStyles',
      'patchElementInlineStyle',
      'patchComputedStyles',
      'scanAndPatchShadowRoots',
      'phase2Observer'
    ];

    for (const key of expectedHotspots) {
      expect(window.__fpProf.n[key]).toBeGreaterThanOrEqual(1);
      expect(typeof window.__fpProf.t[key]).toBe('number');
      expect(window.__fpProf.t[key]).toBeGreaterThanOrEqual(0);
    }

    // 巢狀 @media 應使 processRules 呼叫次數 >= 2，且重入深度歸零無重複計時
    expect(window.__fpProf.n.processRules).toBeGreaterThanOrEqual(2);
    expect(window.__fpProf.d.processRules).toBe(0);
  });

  it('25. CSSOM 掃描應前置 --font-* 字型家族變數，但不得污染 --font-size / --font-weight 等數值變數 (Round 5A)', () => {
    const { document, exports } = createEnvironment();
    const styleEl = document.createElement('style');
    styleEl.textContent = ':root { --font-sans: Inter, sans-serif; --font-size: 16px; --font-weight-bold: 700; --font-display: swap; }';
    document.head.appendChild(styleEl);

    exports.processStyleSheet(styleEl.sheet);

    const rootStyle = styleEl.sheet.cssRules[0].style;
    expect(rootStyle.getPropertyValue('--font-sans')).toContain('Google Sans');
    expect(rootStyle.getPropertyValue('--font-size').trim()).toBe('16px');
    expect(rootStyle.getPropertyValue('--font-weight-bold').trim()).toBe('700');
    expect(rootStyle.getPropertyValue('--font-display').trim()).toBe('swap');
  });
});
