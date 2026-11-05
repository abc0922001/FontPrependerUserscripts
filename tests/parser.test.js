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
  isIconFont,
  isMonospace,
  isAlreadyPrepended,
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
    });

    it('命中 Material Icons、Codicon、IcoMoon 等圖示庫字型應原樣保留', () => {
      const iconStacks = [
        'Material Icons',
        'Material Symbols Outlined',
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
  });
});
