import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import vm from 'node:vm';

function createEnvironment(html = '<!DOCTYPE html><html><head></head><body></body></html>') {
  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'dangerously'
  });

  const { window } = dom;
  const { document, Element, MutationObserver, CSSStyleSheet, CSSStyleDeclaration } = window;

  const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
  const module = { exports: {} };

  const context = vm.createContext({
    window,
    document,
    Element,
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

  it('4. 跨域樣式表 (CORS) 存取拋出 SecurityError 時應安全捕捉並不崩潰', () => {
    const { exports } = createEnvironment();

    const mockCorsSheet = {
      get cssRules() {
        throw new Error('SecurityError: Failed to read the cssRules property from CSSStyleSheet');
      }
    };

    expect(() => {
      exports.processStyleSheet(mockCorsSheet);
    }).not.toThrow();
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
});
