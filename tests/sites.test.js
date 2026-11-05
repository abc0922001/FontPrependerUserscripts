import { describe, it, expect } from 'vitest';
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
  });
});
