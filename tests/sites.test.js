import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import vm from 'node:vm';

function loadUserscript(sandbox = {}) {
  const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    ...sandbox
  });
  vm.runInContext(code, context);
  return module.exports;
}

const {
  prependFontFamily,
  isIconFont,
  isMonospace,
  processStyleSheet,
  patchElementInlineStyle,
  scanAndPatchInlineStyles,
  patchComputedStyles,
  observeStyleSheets,
  SANS_PREPEND_STR,
  MONO_PREPEND_STR
} = loadUserscript();

describe('真實網站排版與邊界條件覆蓋測試 (Real-World Sites Coverage)', () => {
  // ---------------------------------------------------------------------------
  // 1. Cool3c (https://www.cool3c.com/)
  // ---------------------------------------------------------------------------
  describe('1. Cool3c (https://www.cool3c.com/)', () => {
    it('應正確前置系統 UI 字型鏈並保留 !important', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div class="cf-error">系統訊息</div></body></html>');
      const { document } = dom.window;
      const styleEl = document.createElement('style');
      styleEl.textContent = `
        .cf-error {
          font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen,Ubuntu,Helvetica Neue,Arial,sans-serif !important;
        }
      `;
      document.head.appendChild(styleEl);

      processStyleSheet(styleEl.sheet);

      const rule = styleEl.sheet.cssRules[0];
      const fontVal = rule.style.getPropertyValue('font-family');
      const priority = rule.style.getPropertyPriority('font-family');

      expect(fontVal.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(fontVal).toContain('Roboto');
      expect(priority).toBe('important');
    });

    it('應正確識別科技新聞中的終端機與等寬字型堆疊', () => {
      const monoStack = 'monaco,courier,monospace';
      const result = prependFontFamily(monoStack);
      expect(result).toBe(`${MONO_PREPEND_STR}${monoStack}`);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. XDA Developers (https://www.xda-developers.com/archive/)
  // ---------------------------------------------------------------------------
  describe('2. XDA Developers (https://www.xda-developers.com/archive/)', () => {
    it('應處理 Quill 編輯器與科技文章常見字型鏈（含 Titillium Web, Georgia, Roboto）', () => {
      const editorialStacks = [
        'Titillium Web,sans-serif',
        'Roboto,Arial,sans-serif',
        'Georgia,Times New Roman,serif',
        'Helvetica Neue,Helvetica,Arial,sans-serif'
      ];

      for (const stack of editorialStacks) {
        const prepended = prependFontFamily(stack);
        expect(prepended.startsWith(SANS_PREPEND_STR)).toBe(true);
        expect(prepended).toContain(stack);
      }
    });

    it('應安全支援引號變化格式（如 ‘Roboto’,sans-serif）', () => {
      const curlyQuotesStack = "‘Roboto’,sans-serif";
      const prepended = prependFontFamily(curlyQuotesStack);
      expect(prepended.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(prepended).toContain(curlyQuotesStack);
    });

    it('應嚴格保護 XDA 文章介面圖示字型（icomoon）不被前置', () => {
      const iconStack = 'icomoon';
      expect(isIconFont('', iconStack)).toBe(true);
      expect(prependFontFamily(iconStack, '.icon-search')).toBe(iconStack);
      expect(prependFontFamily(iconStack)).toBe(iconStack);
    });

    it('應正確將 Monaco, Courier New 程式碼區塊識別為等寬字型', () => {
      const codeStack = 'Monaco,Courier New,monospace';
      const result = prependFontFamily(codeStack);
      expect(result.startsWith(MONO_PREPEND_STR)).toBe(true);
      expect(result).toBe(`${MONO_PREPEND_STR}${codeStack}`);
    });

    it('應覆蓋 XDA 跨域樣式表下的 h5 文章標題與內部 a 連結（對應 issue/xda-developers.png）', () => {
      // 模擬 XDA 頁面：CORS 樣式表無法直接讀取 cssRules，透過 patchComputedStyles 修補
      const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
        <div class="display-card-content">
          <h5 class="display-card-title">
            <a href="/ditch-samsung-one-ui-launcher/">I ditched Samsung's One UI launcher for an open-source alternative</a>
          </h5>
          <p class="display-card-excerpt">An open-source makeover that unlocks custom icon packs...</p>
        </div>
      </body></html>`);

      const { window } = dom;
      const { document } = window;

      // 載入具備此 DOM 上下文的 Userscript
      const scopedScript = loadUserscript({ window, document });

      // 模擬 window.getComputedStyle 在 XDA 頁面上的傳回值
      const origGetComputed = window.getComputedStyle;
      window.getComputedStyle = (el) => {
        if (el.matches && (el.matches('h5, .display-card-title, a') || el.closest('.display-card-title'))) {
          return { fontFamily: '"Titillium Web", sans-serif' };
        }
        return origGetComputed ? origGetComputed(el) : { fontFamily: 'sans-serif' };
      };

      scopedScript.patchComputedStyles();

      const h5 = document.querySelector('h5.display-card-title');
      const a = h5.querySelector('a');

      expect(h5.style.getPropertyValue('font-family')).toContain('Google Sans');
      expect(h5.style.getPropertyValue('font-family')).toContain('Titillium Web');
      expect(h5.style.getPropertyPriority('font-family')).toBe('important');

      expect(a.style.getPropertyValue('font-family')).toContain('Google Sans');
      expect(a.style.getPropertyValue('font-family')).toContain('Titillium Web');
    });

    it('patchComputedStyles 修補標題時應跳過內嵌圖示 span（避免 .fa / .icon-* 被強制覆寫）', () => {
      const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
        <h3 class="display-card-title">
          <span class="fa fa-fire"></span>
          <a href="/hot-news/">Hot Tech News</a>
        </h3>
      </body></html>`);

      const { window } = dom;
      const { document } = window;
      const scopedScript = loadUserscript({ window, document });

      window.getComputedStyle = () => ({ fontFamily: '"Titillium Web", sans-serif' });
      scopedScript.patchComputedStyles();

      const h3 = document.querySelector('h3.display-card-title');
      const iconSpan = h3.querySelector('span.fa-fire');
      const link = h3.querySelector('a');

      expect(h3.style.getPropertyValue('font-family')).toContain('Google Sans');
      expect(link.style.getPropertyValue('font-family')).toContain('Google Sans');
      expect(iconSpan.style.getPropertyValue('font-family')).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. 9to5Google (https://9to5google.com/)
  // ---------------------------------------------------------------------------
  describe('3. 9to5Google (https://9to5google.com/)', () => {
    it('應正確前置 Typekit 載入之 Proxima Nova 現代幾何無襯線字型', () => {
      const typekitStack1 = '"proxima-nova"';
      const typekitStack2 = '"proxima-nova",sans-serif';

      expect(prependFontFamily(typekitStack1)).toBe(`${SANS_PREPEND_STR}${typekitStack1}`);
      expect(prependFontFamily(typekitStack2)).toBe(`${SANS_PREPEND_STR}${typekitStack2}`);
    });

    it('應保護 9to5 專有圖示字型（[class*=" icon-"], [class^=icon-]）不被污染', () => {
      const iconSelector = '[class*=" icon-"],[class^=icon-]';
      const font = '"9to5"';
      expect(isIconFont(iconSelector, font)).toBe(true);
      expect(prependFontFamily(font, iconSelector)).toBe(font);
    });

    it('遇到全域容器的 font-family: inherit 應保持原樣不變', () => {
      expect(prependFontFamily('inherit')).toBe('inherit');
      expect(prependFontFamily('INHERIT')).toBe('INHERIT');
    });

    it('應正確處理 CSS 自訂屬性變數定義（--font-primary）', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
      const { document } = dom.window;
      const styleEl = document.createElement('style');
      styleEl.textContent = `
        :root {
          --font-primary: "proxima-nova", sans-serif;
          --font-mono: Consolas, monospace;
        }
      `;
      document.head.appendChild(styleEl);

      processStyleSheet(styleEl.sheet);

      const rootRule = styleEl.sheet.cssRules[0];
      const primaryVar = rootRule.style.getPropertyValue('--font-primary');
      const monoVar = rootRule.style.getPropertyValue('--font-mono');

      expect(primaryVar).toContain('Google Sans');
      expect(monoVar).toContain('Intel One Mono');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. 電腦王阿達 (https://www.kocpc.com.tw/)
  // ---------------------------------------------------------------------------
  describe('4. 電腦王阿達 (https://www.kocpc.com.tw/)', () => {
    it('應處理 WordPress / JNews / Jetpack 複雜系統字型清單', () => {
      const wpStack = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif';
      const result = prependFontFamily(wpStack);
      expect(result.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(result).toContain('Cantarell');
    });

    it('應處理臺灣正體中文與微軟正黑體複合字型鏈', () => {
      const tcStack = "'PingFang TC', 'Microsoft JhengHei', sans-serif";
      const result = prependFontFamily(tcStack);
      expect(result.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(result).toContain("'Microsoft JhengHei'");
    });

    it('教學文章中的 pre 與 code 標籤應強制套用等寬字型前置', () => {
      const codeStack = 'Consolas, monospace';
      expect(prependFontFamily(codeStack, 'pre.wp-block-code')).toBe(`${MONO_PREPEND_STR}${codeStack}`);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. 四季線上 4gTV (https://www.4gtv.tv/article/2026110509000001)
  // ---------------------------------------------------------------------------
  describe('5. 四季線上 4gTV (https://www.4gtv.tv/article/2026110509000001)', () => {
    it('應嚴格保護影音播放器控制項專屬圖示字型（flowplayer）', () => {
      const flowplayerSelectors = [
        '#fp-ad-mute:before',
        '.flowplayer.fp-default-playlist .fp-prev:before',
        '.fp-icon:before'
      ];

      for (const sel of flowplayerSelectors) {
        expect(isIconFont(sel, 'flowplayer')).toBe(true);
        expect(prependFontFamily('flowplayer', sel)).toBe('flowplayer');
      }
      expect(isIconFont('', 'flowplayer')).toBe(true);
      expect(prependFontFamily('flowplayer')).toBe('flowplayer');
    });

    it('應正確前置新聞內文之複合中英文字型鏈並保留 Emoji 符號字型', () => {
      const complexNewsStack = '-apple-system,system-ui,"Segoe UI","Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol",Helvetica,Arial,LiHei Pro,Heiti TC,Microsoft Jhenghei,PingFang TC';
      const result = prependFontFamily(complexNewsStack);
      expect(result.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(result).toContain('"Apple Color Emoji"');
      expect(result).toContain('Microsoft Jhenghei');
    });

    it('應正確處理思源黑體與 Avenir 字型鏈', () => {
      const stacks = [
        'NotoSansCJKtc-Bold',
        'avenir, sans-serif',
        '"微軟正黑體"'
      ];

      for (const s of stacks) {
        const prepended = prependFontFamily(s);
        expect(prepended.startsWith(SANS_PREPEND_STR)).toBe(true);
        expect(prepended).toContain(s);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. UNIKO\'s Hardware (https://unikoshardware.com/)
  // ---------------------------------------------------------------------------
  describe("6. UNIKO's Hardware (https://unikoshardware.com/)", () => {
    it('應容錯處理帶有尾端逗號或緊縮語法的 system-ui 宣告', () => {
      const trailingCommaStack = 'system-ui,-apple-system,BlinkMacSystemFont,';
      const result = prependFontFamily(trailingCommaStack);
      expect(result.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(result).toContain('BlinkMacSystemFont');
    });

    it('應正確改寫文章標題與內文直接宣告之行內樣式（對應 issue/unikoshardware.png 與 issue/unikoshardware2.png）', () => {
      const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
        <div class="article-card">
          <a href="/nvidia-app-gpu-app-prioritization" style="font-family: &quot;Apple Lihei Pro&quot;, &quot;Microsoft JhengHei&quot;, &quot;Noto Sands TC&quot;, Arial !important;">
            NVIDIA App 暗藏 GPU App Prioritization 新功能，前後景資源能自己分配
          </a>
        </div>
        <p dir="ltr">
          NVIDIA App 更新到 11.0.9.585 版之後，
          <a href="https://reddit.com" target="_blank" style="font-family: &quot;Apple Lihei Pro&quot;, &quot;Microsoft JhengHei&quot;, &quot;Noto Sands TC&quot;, Arial !important;">，Reddit 網友</a>
          Warkratos 在「System」...
        </p>
      </body></html>`);

      const { document } = dom.window;

      // 執行行內樣式全域掃描與改寫
      scanAndPatchInlineStyles(document);

      const titleLink = document.querySelector('.article-card a');
      const contentLink = document.querySelector('p a');

      // 驗證首頁卡片標題連結的行內樣式
      const titleFont = titleLink.style.getPropertyValue('font-family');
      const titlePriority = titleLink.style.getPropertyPriority('font-family');
      expect(titleFont.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(titleFont).toContain('Apple Lihei Pro');
      expect(titleFont).toContain('Microsoft JhengHei');
      expect(titlePriority).toBe('important');

      // 驗證內文中的 Reddit 網友超連結行內樣式
      const contentFont = contentLink.style.getPropertyValue('font-family');
      const contentPriority = contentLink.style.getPropertyPriority('font-family');
      expect(contentFont.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(contentFont).toContain('Noto Sands TC');
      expect(contentPriority).toBe('important');
    });

    it('硬體評測規格表與代碼塊應維持等寬判定', () => {
      expect(isMonospace('code.spec-code', 'monospace')).toBe(true);
      expect(isMonospace('td.cpu-spec-bench', 'Consolas, monospace')).toBe(true);

      const tableStack = 'Consolas, "Courier New", monospace';
      const result = prependFontFamily(tableStack, 'td.benchmark-data');
      expect(result.startsWith(MONO_PREPEND_STR)).toBe(true);
    });

    it('應在響應式 @media 查詢規則中正常遞迴改寫硬體評測排版', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><table class="benchmark-table"></table></body></html>');
      const { document } = dom.window;
      const styleEl = document.createElement('style');
      styleEl.textContent = `
        @media screen and (max-width: 768px) {
          .benchmark-table {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          }
        }
      `;
      document.head.appendChild(styleEl);

      processStyleSheet(styleEl.sheet);

      const mediaRule = styleEl.sheet.cssRules[0];
      const tableRule = mediaRule.cssRules[0];
      const font = tableRule.style.getPropertyValue('font-family');

      expect(font.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(font).toContain('-apple-system');
    });

    it('應正確改寫群組選擇器下之文章日期規則（避免 .jeg_meta_date 因包含圖示類別而被誤判為純圖示）', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
      const { document } = dom.window;
      const styleEl = document.createElement('style');
      styleEl.textContent = `
        .jeg_meta_date i.fa, .jeg_meta_date {
          font-family: "Apple Lihei Pro", "Microsoft JhengHei", "Noto Sands TC", Arial;
        }
      `;
      document.head.appendChild(styleEl);

      processStyleSheet(styleEl.sheet);

      const rule = styleEl.sheet.cssRules[0];
      const fontVal = rule.style.getPropertyValue('font-family');

      expect(fontVal.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(fontVal).toContain('Apple Lihei Pro');
      expect(fontVal).toContain('Google Sans');
      expect(fontVal).toContain('Noto Sans CJK TC');
    });

    it('應透過計算樣式修補 (patchComputedStyles) 正確覆蓋文章卡片發布日期與作者 (.jeg_meta_date 與 .jeg_post_meta)', () => {
      const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
        <article class="jeg_post">
          <h2 class="jeg_post_title"><a href="#">NVIDIA App 暗藏 GPU App Prioritization 新功能</a></h2>
          <div class="jeg_post_meta">
            <span class="jeg_meta_author"><a href="#">JC</a></span>
            <span class="jeg_meta_date">2026-11-05</span>
          </div>
        </article>
      </body></html>`);

      const { window } = dom;
      const { document } = window;
      const scopedScript = loadUserscript({ window, document });

      const origGetComputed = window.getComputedStyle;
      window.getComputedStyle = (el) => {
        if (el.matches && (el.matches('.jeg_post_meta, .jeg_meta_date, .jeg_meta_author, .jeg_meta_author a, h2 a') || el.closest('.jeg_post_meta'))) {
          return { fontFamily: '"Apple Lihei Pro", "Microsoft JhengHei", "Noto Sands TC", Arial' };
        }
        return origGetComputed ? origGetComputed(el) : { fontFamily: 'sans-serif' };
      };

      scopedScript.patchComputedStyles();

      const metaDate = document.querySelector('.jeg_meta_date');
      const metaAuthor = document.querySelector('.jeg_meta_author a');

      const dateFont = metaDate.style.getPropertyValue('font-family');
      const authorFont = metaAuthor.style.getPropertyValue('font-family');

      expect(dateFont.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(dateFont).toContain('Apple Lihei Pro');
      expect(dateFont).toContain('Google Sans');
      expect(metaDate.style.getPropertyPriority('font-family')).toBe('important');

      expect(authorFont.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(authorFont).toContain('Apple Lihei Pro');
      expect(authorFont).toContain('Google Sans');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. X / Twitter (https://x.com/home)
  // ---------------------------------------------------------------------------
  describe('7. X / Twitter (https://x.com/home)', () => {
    it('應正確前置 X (Twitter) 專有核心字型鏈（TwitterChirp 與 TwitterChirpExtendedHeavy）', () => {
      const chirpStacks = [
        'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        'TwitterChirpExtendedHeavy, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        'Chirp, "Helvetica Neue", sans-serif',
        '"Chirp-Bold", sans-serif'
      ];

      for (const stack of chirpStacks) {
        const prepended = prependFontFamily(stack);
        expect(prepended.startsWith(SANS_PREPEND_STR)).toBe(true);
        expect(prepended).toContain(stack);
        expect(prepended).toContain('Google Sans');
        expect(prepended).toContain('Noto Sans CJK TC');
      }
    });

    it('應正確處理 React Native for Web 靜態樣式表與動態 insertRule 規則注入', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><head><style id="react-native-stylesheet"></style></head><body></body></html>', {
        runScripts: 'dangerously'
      });
      const { window } = dom;
      const { document, CSSStyleSheet } = window;

      // 載入具備此 DOM 上下文的 Userscript
      const scoped = loadUserscript({ window, document, CSSStyleSheet });
      scoped.hookCSSPrototypes();

      const styleEl = document.getElementById('react-native-stylesheet');
      const sheet = styleEl.sheet;

      // 1. 靜態規則改寫
      sheet.insertRule('.css-1jxf684 { font-family: TwitterChirp, sans-serif; }', 0);
      scoped.processStyleSheet(sheet);
      expect(sheet.cssRules[0].style.getPropertyValue('font-family')).toContain('Google Sans');
      expect(sheet.cssRules[0].style.getPropertyValue('font-family')).toContain('TwitterChirp');

      // 2. 原型鏈動態 insertRule 攔截改寫（模擬虛擬滾動推文動態注入新 class 樣式）
      sheet.insertRule('.r-18u37iz { font-family: TwitterChirpExtendedHeavy, sans-serif; }', 1);
      const insertedRule = sheet.cssRules[1];
      expect(insertedRule.style.getPropertyValue('font-family')).toContain('Google Sans');
      expect(insertedRule.style.getPropertyValue('font-family')).toContain('TwitterChirpExtendedHeavy');
    });

    it('應覆蓋首頁虛擬滾動 Timeline 動態載入之推文行內樣式 (data-testid="tweetText")', () => {
      const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
        <div aria-label="Timeline: Your Home Timeline">
          <div data-testid="cellInnerDiv">
            <article data-testid="tweet">
              <div data-testid="tweetText" style="font-family: TwitterChirp, sans-serif;">
                <span>Hello X.com World from FontPrepender!</span>
              </div>
            </article>
          </div>
        </div>
      </body></html>`);

      const { document } = dom.window;

      // 執行行內樣式掃描與改寫
      scanAndPatchInlineStyles(document);

      const tweetText = document.querySelector('[data-testid="tweetText"]');
      const fontVal = tweetText.style.getPropertyValue('font-family');

      expect(fontVal.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(fontVal).toContain('TwitterChirp');
      expect(fontVal).toContain('Google Sans');
    });

    it('應正確將推文內之程式碼區塊與 monospace 等寬寫法判定為等寬字型', () => {
      const xMonoStacks = [
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        'monospace, monospace',
        '"Courier New", Courier, monospace',
        'Consolas, "Liberation Mono", Menlo, Courier, monospace'
      ];

      for (const stack of xMonoStacks) {
        const result = prependFontFamily(stack);
        expect(result.startsWith(MONO_PREPEND_STR)).toBe(true);
        expect(result).toContain('Intel One Mono');
        expect(result).toContain('Noto Sans Mono CJK TC');
      }
    });

    it('基礎降級樣式應涵蓋發文撰寫框 ([contenteditable="true"]) 與搜尋框 (input)', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
      const { document } = dom.window;
      const scoped = loadUserscript({ document, window: dom.window });

      scoped.injectBaseStyles(document);

      const baseStyle = document.querySelector('#font-prepender-base-style');
      expect(baseStyle).not.toBeNull();
      expect(baseStyle.textContent).toContain('contenteditable');
      expect(baseStyle.textContent).toContain('input');
      expect(baseStyle.textContent).toContain('textarea');
    });

    it('推文複合字型鏈中之 Emoji 回退字型應完整保留不被沖刷', () => {
      const tweetEmojiStack = 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      const result = prependFontFamily(tweetEmojiStack);

      expect(result.startsWith(SANS_PREPEND_STR)).toBe(true);
      expect(result).toContain('"Apple Color Emoji"');
      expect(result).toContain('"Segoe UI Emoji"');
      expect(result).toContain('TwitterChirp');
    });
  });
});
