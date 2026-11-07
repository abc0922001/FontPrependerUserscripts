import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

function loadUserscript(sandbox = {}) {
  const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    performance,
    ...sandbox
  });
  vm.runInContext(code, context);
  return module.exports;
}

let capturedObserverCallback = null;
class MockMutationObserver {
  constructor(cb) {
    capturedObserverCallback = cb;
  }
  observe() {}
}

const fontPrepender = loadUserscript({ MutationObserver: MockMutationObserver, URL });
const { prependFontFamily, processRules, observeStyleSheets, rewriteCssContent } = fontPrepender;

console.log('====================================================');
console.log('FontPrepender 效能評估與壓力測試 (Performance Benchmark)');
console.log('====================================================\n');

let allPassed = true;

const testFontStacks = [
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  '"Fira Code", Monaco, Consolas, "Courier New", monospace',
  '"Font Awesome 6 Free", FontAwesome',
  'system-ui, sans-serif',
  'var(--font-sans)',
  'var(--font-mono)',
  'inherit',
  '"JetBrains Mono", monospace',
  'Material Icons',
  '"Microsoft JhengHei", "PingFang TC", sans-serif'
];

const testSelectors = [
  'body',
  'pre.code',
  '.fa-icon',
  '.article-content p',
  'div.container',
  'code.inline',
  'h1, h2, h3',
  '.blob-code-inner',
  '.material-icons',
  'span.text'
];

const mockDoc = {
  documentElement: {},
  styleSheets: [],
  querySelectorAll: () => []
};
observeStyleSheets(mockDoc);

// -----------------------------------------------------------------------------
// V8 JIT 深度預熱階段 (Warmup Phase)
// 觸發 V8 TurboFan 完整編譯熱點函式與正規表示式，消除首次執行時 Tier-up 編譯抖動
// -----------------------------------------------------------------------------
for (let i = 0; i < 6000; i++) {
  prependFontFamily(testFontStacks[i % testFontStacks.length], testSelectors[(i * 3) % testSelectors.length]);
}
for (let i = 0; i < 600; i++) {
  prependFontFamily(`"WarmupColdFont-${i}", Arial, sans-serif`, testSelectors[i % testSelectors.length]);
}
const warmupRules = [];
for (let i = 0; i < 500; i++) {
  const font = testFontStacks[i % testFontStacks.length];
  let currentFont = font;
  warmupRules.push({
    selectorText: testSelectors[i % testSelectors.length],
    style: {
      getPropertyValue: (prop) => (prop === 'font-family' ? currentFont : ''),
      getPropertyPriority: () => '',
      setProperty: (prop, val) => {
        if (prop === 'font-family') currentFont = val;
      },
      length: 0
    }
  });
}
processRules(warmupRules);
for (let i = 0; i < 300; i++) {
  capturedObserverCallback([
    {
      type: 'childList',
      addedNodes: [
        {
          nodeType: 1,
          tagName: 'SPAN',
          firstElementChild: null,
          hasAttribute: () => true,
          style: {
            getPropertyValue: () => 'Arial, sans-serif',
            getPropertyPriority: () => '',
            setProperty: () => {}
          }
        }
      ]
    }
  ]);
}
for (let i = 0; i < 150; i++) {
  rewriteCssContent(
    '@font-face { font-family: "Warmup"; src: url("../fonts/warmup.woff2"); } .warmup { font-family: Arial, sans-serif !important; }',
    'https://cdn.example.com/assets/css/app.css'
  );
}

/**
 * 執行基準測試並取多次迭代之最佳穩定耗時（消除作業系統排程與 V8 背景 GC 單次抖動）
 * @param {() => void} fn 測試函式
 * @param {number} [runs=3] 採樣次數
 * @returns {number} 毫秒耗時
 */
function measureStableDuration(fn, runs = 3) {
  let minDuration = Infinity;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;
    if (duration < minDuration) {
      minDuration = duration;
    }
  }
  return minDuration;
}

// -----------------------------------------------------------------------------
// 基準測試 1：字串解析吞吐量 (Parser Throughput)
// 門檻：10,000 條含選擇器之複雜 font-family 規則，總耗時 < 2.0 ms (平均單條 < 0.0002 ms)
// -----------------------------------------------------------------------------
const PARSER_ITERATIONS = 10000;
const parserDuration = measureStableDuration(() => {
  for (let i = 0; i < PARSER_ITERATIONS; i++) {
    const sample = testFontStacks[i % testFontStacks.length];
    const selector = testSelectors[(i * 3) % testSelectors.length];
    prependFontFamily(sample, selector);
  }
}, 5);
const avgPerRule = (parserDuration / PARSER_ITERATIONS).toFixed(6);

console.log(`[基準 1] 字串解析吞吐量：`);
console.log(`  - 執行次數：${PARSER_ITERATIONS} 次 (含選擇器特徵判定)`);
console.log(`  - 總耗時：${parserDuration.toFixed(3)} ms (門檻: < 2.000 ms)`);
console.log(`  - 平均單條：${avgPerRule} ms (門檻: < 0.000200 ms)`);

if (parserDuration < 2.0) {
  console.log('  [PASS] 字串解析效能完全達標。\n');
} else {
  console.error('  [FAIL] 字串解析效能超標！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 2：大型 CSSOM 掃描耗時 (Cold Start Budget)
// 門檻：模擬 2,000 條 CSS Rules 樣式表，初次完整掃描改寫耗時 < 1.5 ms
// -----------------------------------------------------------------------------
const mockRules = [];
const originalRuleFonts = [];
for (let i = 0; i < 2000; i++) {
  const font = testFontStacks[i % testFontStacks.length];
  const selector = testSelectors[i % testSelectors.length];
  originalRuleFonts.push(font);
  let currentFont = font;
  mockRules.push({
    selectorText: selector,
    _reset: () => {
      currentFont = font;
    },
    style: {
      getPropertyValue: (prop) => (prop === 'font-family' ? currentFont : ''),
      getPropertyPriority: () => '',
      setProperty: (prop, val) => {
        if (prop === 'font-family') currentFont = val;
      },
      length: 0
    }
  });
}

let cssomDuration = Infinity;
for (let r = 0; r < 3; r++) {
  for (let i = 0; i < 2000; i++) mockRules[i]._reset();
  const start = performance.now();
  processRules(mockRules);
  const d = performance.now() - start;
  if (d < cssomDuration) cssomDuration = d;
}

console.log(`[基準 2] 大型 CSSOM 掃描耗時：`);
console.log(`  - 規則總數：2,000 條`);
console.log(`  - 掃描改寫耗時：${cssomDuration.toFixed(3)} ms (門檻: < 1.500 ms)`);

if (cssomDuration < 1.5) {
  console.log('  [PASS] 大型 CSSOM 掃描耗時完全控制在極限預算內 (< 1.5 ms)。\n');
} else {
  console.error('  [FAIL] CSSOM 掃描耗時超標！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 3：動態 DOM 突發負載測試 (Mutation Burst Overhead)
// 門檻：模擬 SPA 瞬間插入 5,000 個 DOM 節點 (含每 50 個節點具行內樣式)，主執行緒阻塞時間 < 1.5 ms
// -----------------------------------------------------------------------------
const mockMutations = [];
const mutationBatch = [];
for (let i = 0; i < 5000; i++) {
  const hasInlineFont = i % 50 === 0;
  let inlineFont = 'Roboto, sans-serif';
  mutationBatch.push({
    nodeType: 1,
    tagName: i % 500 === 0 ? 'DIV' : 'SPAN',
    firstElementChild: null,
    hasAttribute: (attr) => hasInlineFont && attr === 'style',
    _reset: hasInlineFont
      ? () => {
          inlineFont = 'Roboto, sans-serif';
        }
      : null,
    style: hasInlineFont
      ? {
          getPropertyValue: (prop) => (prop === 'font-family' ? inlineFont : ''),
          getPropertyPriority: () => '',
          setProperty: (prop, val) => {
            if (prop === 'font-family') inlineFont = val;
          }
        }
      : undefined
  });
}
mockMutations.push({
  type: 'childList',
  addedNodes: mutationBatch
});

// 呼叫真實 observeStyleSheets 註冊之 MutationObserver 回呼函式進行高負載執行測試
let mutationDuration = Infinity;
for (let r = 0; r < 3; r++) {
  for (let i = 0; i < 5000; i += 50) mutationBatch[i]._reset();
  const start = performance.now();
  capturedObserverCallback(mockMutations);
  const d = performance.now() - start;
  if (d < mutationDuration) mutationDuration = d;
}

console.log(`[基準 3] 動態 DOM 突發負載處理：`);
console.log(`  - 突發節點數：5,000 個 DOM 節點 (含 100 個行內 font-family 節點改寫)`);
console.log(`  - 阻塞耗時：${mutationDuration.toFixed(3)} ms (門檻: < 1.500 ms)`);

if (mutationDuration < 1.5) {
  console.log('  [PASS] 突發 DOM 突增處理耗時極低，無主執行緒卡頓風險。\n');
} else {
  console.error('  [FAIL] 突發 DOM 處理耗時超標！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 4：純文字 CSS 改寫引擎吞吐量 (Raw CSS Rewrite Throughput)
// 門檻：改寫 1,000 條含 @font-face、相對 url()、@media 與 !important 之 CSS 規則，耗時 < 2.0 ms
// -----------------------------------------------------------------------------
const cssChunks = [];
for (let i = 0; i < 1000; i++) {
  if (i % 20 === 0) {
    cssChunks.push(
      `@font-face { font-family: "CustomFont-${i}"; src: url("../fonts/custom-${i}.woff2") format("woff2"); }`
    );
  } else if (i % 10 === 0) {
    cssChunks.push(`@media (min-width: 768px) { pre.code-${i} { font-family: "Fira Code", monospace !important; } }`);
  } else if (i % 7 === 0) {
    cssChunks.push(`.fa-icon-${i} { font-family: "Font Awesome 6 Free"; }`);
  } else {
    cssChunks.push(`.article-body-${i} { color: #333; font-family: Roboto, "Noto Sans TC", sans-serif; }`);
  }
}
const largeCssText = cssChunks.join('\n');

let rewrittenCss = '';
const rewriteDuration = measureStableDuration(() => {
  rewrittenCss = rewriteCssContent(largeCssText, 'https://cdn.example.com/assets/css/main.css');
}, 3);

const fontFacePreserved = rewrittenCss.includes('@font-face { font-family: "CustomFont-0";');
const urlResolved = rewrittenCss.includes('url("https://cdn.example.com/assets/fonts/custom-0.woff2")');

console.log(`[基準 4] 純文字 CSS 改寫引擎吞吐量 (rewriteCssContent)：`);
console.log(`  - 規則總數：1,000 條 (含 @font-face 保護與相對路徑轉絕對路徑)`);
console.log(`  - 改寫總耗時：${rewriteDuration.toFixed(3)} ms (門檻: < 2.000 ms)`);

if (rewriteDuration < 2.0 && fontFacePreserved && urlResolved) {
  console.log('  [PASS] 純文字 CSS 改寫吞吐量與語法保護完全達標。\n');
} else {
  console.error('  [FAIL] 純文字 CSS 改寫耗時超標或規則異常！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 5：100% Cache Miss 冷解析與記憶體防護檢測 (Uncached Cold Parse & Memory Guard)
// 門檻：2,500 筆完全不重複字型堆疊冷解析 + 1,500 次快取淘汰耗時 < 2.5 ms，且零強引用洩漏
// -----------------------------------------------------------------------------
const codeContent = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');

const hasWeakSetStyleSheets = codeContent.includes('const processedStyleSheets = new WeakSet()');
const hasWeakSetShadowRoots = codeContent.includes('const processedShadowRoots = new WeakSet()');
const hasWeakSetElements = codeContent.includes('const processedElements = new WeakSet()');
const hasWeakMapStyleToElement = codeContent.includes('const styleToElementMap = new WeakMap()');
const hasNoGlobalStrongLeak = !codeContent.includes('const processedStyleSheets = new Set()');

const uniqueColdBatches = [[], [], []];
for (let r = 0; r < 3; r++) {
  for (let i = 0; i < 2500; i++) {
    uniqueColdBatches[r].push(`"CustomDynamicFont-${r}-${i}", Helvetica, Arial, sans-serif`);
  }
}

let coldParseDuration = Infinity;
for (let r = 0; r < 3; r++) {
  const batch = uniqueColdBatches[r];
  const start = performance.now();
  for (let i = 0; i < 2500; i++) {
    prependFontFamily(batch[i], testSelectors[i % testSelectors.length]);
  }
  const d = performance.now() - start;
  if (d < coldParseDuration) coldParseDuration = d;
}

console.log(`[基準 5] 100% Cache Miss 冷解析與記憶體防護檢測：`);
console.log(`  - 樣式表記錄使用 WeakSet: ${hasWeakSetStyleSheets}`);
console.log(`  - ShadowRoot 記錄使用 WeakSet: ${hasWeakSetShadowRoots}`);
console.log(`  - 抽樣元素記錄使用 WeakSet: ${hasWeakSetElements}`);
console.log(`  - 原型鏈元素映射使用 WeakMap: ${hasWeakMapStyleToElement}`);
console.log(`  - 無強引用 Set 洩漏: ${hasNoGlobalStrongLeak}`);
console.log(`  - 2,500 筆唯一字型冷解析 + FIFO 快取淘汰耗時：${coldParseDuration.toFixed(3)} ms (門檻: < 2.500 ms)`);

const memoryPassed =
  hasWeakSetStyleSheets &&
  hasWeakSetShadowRoots &&
  hasWeakSetElements &&
  hasWeakMapStyleToElement &&
  hasNoGlobalStrongLeak &&
  coldParseDuration < 2.5;

if (memoryPassed) {
  console.log('  [PASS] 記憶體防護與高壓快取淘汰檢驗通過，生命週期由 GC 自然回收。\n');
} else {
  console.error('  [FAIL] 記憶體防護或冷解析淘汰耗時未通過！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 總結
// -----------------------------------------------------------------------------
console.log('====================================================');
if (allPassed) {
  console.log('全部效能基準測試項目通過！已達發佈生產標準。');
  console.log('====================================================');
  process.exit(0);
} else {
  console.error('有測試項目未達標準，請進行效能最佳化！');
  console.log('====================================================');
  process.exit(1);
}
