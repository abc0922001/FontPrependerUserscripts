import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import vm from 'node:vm';

function createEnvironment(html = '<!DOCTYPE html><html><head></head><body></body></html>', beforeInit) {
  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'dangerously'
  });

  const { window } = dom;
  const { document, Element, HTMLElement, MutationObserver, CSSStyleSheet, CSSStyleDeclaration } = window;

  if (typeof beforeInit === 'function') {
    beforeInit(window, document);
  }

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
    setTimeout,
    clearTimeout,
    console,
    module,
    exports: module.exports
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
    expect(shadowBaseStyle.textContent).toContain('Google Sans');
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
});
