import { describe, it, expect } from 'vitest';
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
  rewriteCssContent,
  isIconFont,
  isMonospace,
  isAlreadyPrepended,
  fontCache,
  neutralFontCache,
  MAX_CACHE_SIZE,
  SANS_PREPEND_STR,
  MONO_PREPEND_STR
} = loadUserscript();

describe('字型堆疊解析與前置引擎 (Font Stack Parser & Prepender)', () => {
  describe('1. 一般字型前置測試', () => {
    it('應正確前置一般無襯線首選字型至標準無襯線字型鏈', () => {
      const input = '"Arial", sans-serif';
      const expected = `${SANS_PREPEND_STR}"Arial", sans-serif`;
      expect(prependFontFamily(input)).toBe(expected);
    });

    it('應支援未加引號與單引號之字型名稱', () => {
      const input = "Helvetica, 'Microsoft JhengHei', sans-serif";
      const expected = `${SANS_PREPEND_STR}Helvetica, 'Microsoft JhengHei', sans-serif`;
      expect(prependFontFamily(input)).toBe(expected);
    });

    it('系統通用字型如 system-ui 應前置一般字型', () => {
      const input = 'system-ui, -apple-system, BlinkMacSystemFont';
      const expected = `${SANS_PREPEND_STR}system-ui, -apple-system, BlinkMacSystemFont`;
      expect(prependFontFamily(input)).toBe(expected);
    });
  });

  describe('2. 等寬與程式碼字型識別與前置測試', () => {
    it('若 font-family 包含 Fira Code, monospace 應前置等寬首選字型', () => {
      const input = '"Fira Code", monospace';
      const expected = `${MONO_PREPEND_STR}"Fira Code", monospace`;
      expect(prependFontFamily(input)).toBe(expected);
    });

    it('若 selector 符合 code 或 pre，即使字型未明示 monospace 也應前置等寬字型', () => {
      const input = 'sans-serif';
      const expected = `${MONO_PREPEND_STR}sans-serif`;
      expect(prependFontFamily(input, 'pre, code')).toBe(expected);
      expect(prependFontFamily(input, 'code')).toBe(expected);
      expect(prependFontFamily(input, '.blob-code')).toBe(expected);
      expect(prependFontFamily(input, '.highlight pre')).toBe(expected);
    });

    it('常見等寬字型（如 Consolas, JetBrains Mono, Cascadia Code）皆能被智慧識別', () => {
      const fonts = [
        'Consolas, "Courier New", monospace',
        '"JetBrains Mono", monospace',
        '"Source Code Pro", monospace',
        'Menlo, Monaco, "Courier New"',
        'ui-monospace, SFMono-Regular, Cascadia',
        '"Ubuntu Mono", monospace',
        '"Roboto Mono", monospace'
      ];

      for (const font of fonts) {
        const result = prependFontFamily(font);
        expect(result.startsWith(MONO_PREPEND_STR)).toBe(true);
      }
    });
  });

  describe('3. 冪等性測試 (Idempotency)', () => {
    it('對相同字型規則執行 2 次以上處理，結果必須完全相同，不得重複前置', () => {
      const input = '"Arial", sans-serif';
      const firstPass = prependFontFamily(input);
      const secondPass = prependFontFamily(firstPass);
      const thirdPass = prependFontFamily(secondPass);

      expect(firstPass).toBe(`${SANS_PREPEND_STR}"Arial", sans-serif`);
      expect(secondPass).toBe(firstPass);
      expect(thirdPass).toBe(firstPass);
    });

    it('等寬字型在重複前置時維持冪等性', () => {
      const input = 'Consolas, monospace';
      const firstPass = prependFontFamily(input);
      const secondPass = prependFontFamily(firstPass);

      expect(firstPass).toBe(`${MONO_PREPEND_STR}Consolas, monospace`);
      expect(secondPass).toBe(firstPass);
    });

    it('直接傳入已包含目標字型的字串應被 isAlreadyPrepended 正確識別', () => {
      expect(isAlreadyPrepended(`${SANS_PREPEND_STR}sans-serif`, false)).toBe(true);
      expect(isAlreadyPrepended(`${MONO_PREPEND_STR}monospace`, true)).toBe(true);
    });
  });

  describe('4. 圖示字型排除保護測試 (Icon Fonts Protection)', () => {
    it('命中 Font Awesome 特徵之規則應原封不動保留', () => {
      const input = '"Font Awesome 6 Free", "FontAwesome"';
      expect(prependFontFamily(input)).toBe(input);
      expect(prependFontFamily('sans-serif', '.fa-icon')).toBe('sans-serif');
      expect(prependFontFamily('sans-serif', 'i.fa')).toBe('sans-serif');
      expect(prependFontFamily('sans-serif', '.fas')).toBe('sans-serif');
      expect(prependFontFamily('sans-serif', '.far')).toBe('sans-serif');
      expect(prependFontFamily('sans-serif', '.fab')).toBe('sans-serif');
      expect(prependFontFamily('sans-serif', '.fal')).toBe('sans-serif');
    });

    it('不應誤將含有 fa 開頭之常規英文單字判定為圖示', () => {
      expect(prependFontFamily('sans-serif', '.fade')).toContain('Google Sans');
      expect(prependFontFamily('sans-serif', '.family-text')).toContain('Google Sans');
      expect(prependFontFamily('sans-serif', '.fast-loading')).toContain('Google Sans');
    });

    it('命中 Material Icons、Codicon、IcoMoon 等圖示庫字型應原樣保留', () => {
      const iconStacks = [
        'Material Icons',
        'Material Symbols Outlined',
        'mat-icon',
        'gem-icon',
        'lucide',
        'remixicon',
        'tabler',
        'devicon',
        'lumi',
        'codicon',
        'feather',
        'icomoon',
        'dashicons',
        'Octicons',
        'fontello'
      ];

      for (const iconFont of iconStacks) {
        expect(prependFontFamily(iconFont)).toBe(iconFont);
      }
    });

    it('isIconFont 能正確辨識圖示特徵選擇器與字型名稱', () => {
      expect(isIconFont('.btn-icon', 'sans-serif')).toBe(true);
      expect(isIconFont('', 'Material-Icons')).toBe(true);
      expect(isIconFont('.ri-search-line', 'sans-serif')).toBe(true);
      expect(isIconFont('.ti-arrow-right', 'sans-serif')).toBe(true);
      expect(isIconFont('.normal-text', 'Arial, sans-serif')).toBe(false);
    });
  });

  describe('5. 特殊語法與邊界條件容錯測試', () => {
    it('處理空字串或非字串輸入應安全退避', () => {
      expect(prependFontFamily('')).toBe('');
      expect(prependFontFamily('   ')).toBe('   ');
      expect(prependFontFamily(null)).toBe(null);
      expect(prependFontFamily(undefined)).toBe(undefined);
    });

    it('CSS 保留系統關鍵字 (inherit, initial, unset, revert) 不應被修改', () => {
      const keywords = ['inherit', 'initial', 'unset', 'revert', 'revert-layer'];
      for (const kw of keywords) {
        expect(prependFontFamily(kw)).toBe(kw);
        expect(prependFontFamily(kw.toUpperCase())).toBe(kw.toUpperCase());
      }
    });

    it('包含 var(--custom-font) 之 CSS 自訂變數應合法前置', () => {
      const sansVar = 'var(--font-sans)';
      expect(prependFontFamily(sansVar)).toBe(`${SANS_PREPEND_STR}${sansVar}`);

      const monoVar = 'var(--font-mono)';
      expect(prependFontFamily(monoVar)).toBe(`${MONO_PREPEND_STR}${monoVar}`);
    });

    it('rewriteCssContent 應逆向提取選擇器上下文，保護圖示選擇器並將 pre/code 識別為等寬', () => {
      const css = `
        .fa-icon { font-family: sans-serif; }
        pre.code-block { font-family: sans-serif !important; }
        @media (min-width: 768px) { .article-body { font-family: Arial, sans-serif; } }
      `;
      const rewritten = rewriteCssContent(css);
      expect(rewritten).toContain('.fa-icon { font-family: sans-serif; }');
      expect(rewritten).toContain(`pre.code-block { font-family: ${MONO_PREPEND_STR}sans-serif !important; }`);
      expect(rewritten).toContain(`.article-body { font-family: ${SANS_PREPEND_STR}Arial, sans-serif; }`);
    });

    it('rewriteCssContent 遇到 @font-face 規則應保持字型名稱定義不被改寫', () => {
      const fontFaceCss = `
        @font-face {
          font-family: 'CustomFont';
          src: url('custom.woff2') format('woff2');
        }
        @font-face {
          font-family: "My Icon Font";
          src: url('icons.woff') format('woff');
        }
        body { font-family: 'CustomFont', sans-serif; }
      `;
      const rewritten = rewriteCssContent(fontFaceCss);
      expect(rewritten).toContain("font-family: 'CustomFont';");
      expect(rewritten).toContain('font-family: "My Icon Font";');
      expect(rewritten).toContain(`font-family: ${SANS_PREPEND_STR}'CustomFont', sans-serif;`);
    });
  });

  // Issue #1 & #3: 快取 FIFO 淘汰機制
  describe('6. 快取 FIFO 淘汰與有界限記憶體防護 (Issue #1 & #3)', () => {
    it('快取達到上限時應採用 FIFO 淘汰最舊項目，而非全量清空 (Preserve Warm Cache)', () => {
      neutralFontCache.clear();
      expect(neutralFontCache.size).toBe(0);

      // 填入 1,000 筆獨立字型
      for (let i = 0; i < MAX_CACHE_SIZE; i++) {
        prependFontFamily(`"FontUnique-${i}", sans-serif`);
      }
      expect(neutralFontCache.size).toBe(MAX_CACHE_SIZE);
      expect(neutralFontCache.has('"FontUnique-0", sans-serif')).toBe(true);
      expect(neutralFontCache.has('"FontUnique-999", sans-serif')).toBe(true);

      // 再新增第 1,001 筆，應淘汰第 0 筆，而第 1~999 筆熱點快取依然保留
      prependFontFamily('"FontUnique-1000", sans-serif');
      expect(neutralFontCache.size).toBe(MAX_CACHE_SIZE);
      expect(neutralFontCache.has('"FontUnique-0", sans-serif')).toBe(false); // 第 0 筆被淘汰
      expect(neutralFontCache.has('"FontUnique-1", sans-serif')).toBe(true);  // 第 1 筆依然存在
      expect(neutralFontCache.has('"FontUnique-1000", sans-serif')).toBe(true);
    });
  });
});
