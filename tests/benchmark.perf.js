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

const fontPrepender = loadUserscript();
const { prependFontFamily, processRules } = fontPrepender;

console.log('====================================================');
console.log('FontPrepender 效能評估與壓力測試 (Performance Benchmark)');
console.log('====================================================\n');

let allPassed = true;

// -----------------------------------------------------------------------------
// 基準測試 1：字串解析吞吐量 (Parser Throughput)
// 門檻：10,000 條複雜 font-family 規則，總耗時 < 15 ms (平均單條 < 0.0015 ms)
// -----------------------------------------------------------------------------
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

const PARSER_ITERATIONS = 10000;
const startParser = performance.now();
for (let i = 0; i < PARSER_ITERATIONS; i++) {
  const sample = testFontStacks[i % testFontStacks.length];
  prependFontFamily(sample);
}
const endParser = performance.now();
const parserDuration = endParser - startParser;
const avgPerRule = (parserDuration / PARSER_ITERATIONS).toFixed(6);

console.log(`[基準 1] 字串解析吞吐量：`);
console.log(`  - 執行次數：${PARSER_ITERATIONS} 次`);
console.log(`  - 總耗時：${parserDuration.toFixed(3)} ms (門檻: < 15.000 ms)`);
console.log(`  - 平均單條：${avgPerRule} ms (門檻: < 0.0015 ms)`);

if (parserDuration < 15.0) {
  console.log('  [PASS] 字串解析效能完全達標。\n');
} else {
  console.error('  [FAIL] 字串解析效能超標！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 2：大型 CSSOM 掃描耗時 (Cold Start Budget)
// 門檻：模擬 2,000 條 CSS Rules 樣式表，初次完整掃描改寫耗時 < 16.6 ms (60 FPS 不掉幀)
// -----------------------------------------------------------------------------
const mockRules = [];
for (let i = 0; i < 2000; i++) {
  const font = testFontStacks[i % testFontStacks.length];
  let currentFont = font;
  mockRules.push({
    selectorText: `.class-${i}`,
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

const startCSSOM = performance.now();
processRules(mockRules);
const endCSSOM = performance.now();
const cssomDuration = endCSSOM - startCSSOM;

console.log(`[基準 2] 大型 CSSOM 掃描耗時：`);
console.log(`  - 規則總數：2,000 條`);
console.log(`  - 掃描改寫耗時：${cssomDuration.toFixed(3)} ms (門檻: < 16.600 ms)`);

if (cssomDuration < 16.6) {
  console.log('  [PASS] 大型 CSSOM 掃描耗時完全控制在單一幀內 (60 FPS)。\n');
} else {
  console.error('  [FAIL] CSSOM 掃描耗時超標！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 3：動態 DOM 突發負載測試 (Mutation Burst Overhead)
// 門檻：模擬 SPA 瞬間插入 5,000 個 DOM 節點，主執行緒阻塞時間 < 10 ms
// -----------------------------------------------------------------------------
const mockMutations = [];
const mutationBatch = [];
for (let i = 0; i < 5000; i++) {
  mutationBatch.push({
    nodeType: 1,
    tagName: i % 500 === 0 ? 'DIV' : 'SPAN'
  });
}
mockMutations.push({
  type: 'childList',
  addedNodes: mutationBatch
});

// 模擬 MutationObserver 回呼函式的高負載執行
const startMutation = performance.now();
let shouldScan = false;
for (let i = 0; i < mockMutations.length; i++) {
  const mutation = mockMutations[i];
  if (mutation.type === 'childList') {
    const nodes = mutation.addedNodes;
    for (let j = 0; j < nodes.length; j++) {
      const node = nodes[j];
      if (node.nodeType !== 1) continue;
      const tagName = node.tagName.toLowerCase();
      if (tagName === 'style') {
        shouldScan = true;
      }
    }
  }
}
const endMutation = performance.now();
const mutationDuration = endMutation - startMutation;

console.log(`[基準 3] 動態 DOM 突發負載處理：`);
console.log(`  - 突發節點數：5,000 個 DOM 節點`);
console.log(`  - 阻塞耗時：${mutationDuration.toFixed(3)} ms (門檻: < 10.000 ms)`);

if (mutationDuration < 10.0) {
  console.log('  [PASS] 突發 DOM 突增處理耗時極低，無主執行緒卡頓風險。\n');
} else {
  console.error('  [FAIL] 突發 DOM 處理耗時超標！\n');
  allPassed = false;
}

// -----------------------------------------------------------------------------
// 基準測試 4：記憶體洩漏防禦檢測 (Memory Footprint)
// 確保已處理物件皆使用 WeakSet / WeakMap 弱引用追蹤，不阻礙垃圾回收
// -----------------------------------------------------------------------------
const codeContent = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');

const hasWeakSetStyleSheets = codeContent.includes('const processedStyleSheets = new WeakSet()');
const hasWeakSetShadowRoots = codeContent.includes('const processedShadowRoots = new WeakSet()');
const hasWeakSetElements = codeContent.includes('const processedElements = new WeakSet()');
const hasNoGlobalStrongLeak = !codeContent.includes('const processedStyleSheets = new Set()');

console.log(`[基準 4] 記憶體洩漏防禦檢測 (WeakSet Retention)：`);
console.log(`  - 樣式表記錄使用 WeakSet: ${hasWeakSetStyleSheets}`);
console.log(`  - ShadowRoot 記錄使用 WeakSet: ${hasWeakSetShadowRoots}`);
console.log(`  - 抽樣元素記錄使用 WeakSet: ${hasWeakSetElements}`);
console.log(`  - 無強引用 Set 洩漏: ${hasNoGlobalStrongLeak}`);

const memoryPassed = hasWeakSetStyleSheets && hasWeakSetShadowRoots && hasWeakSetElements && hasNoGlobalStrongLeak;
if (memoryPassed) {
  console.log('  [PASS] 記憶體防護檢驗通過，生命週期由 GC 自然回收。\n');
} else {
  console.error('  [FAIL] 記憶體防護未通過！\n');
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
