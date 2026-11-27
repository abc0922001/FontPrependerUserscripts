import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';

function loadUserscript(sandbox = {}) {
  const code = fs.readFileSync(new URL('../src/FontPrepender.user.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    performance,
    setTimeout,
    clearTimeout,
    URL,
    ...sandbox
  });
  vm.runInContext(code, context);
  return module.exports;
}

function measureMedian(fn, { runs = 5, beforeEach } = {}) {
  const samples = [];
  for (let r = 0; r < runs; r++) {
    if (beforeEach) beforeEach(r);
    const start = performance.now();
    fn(r);
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples
  };
}

async function measureMedianAsync(fn, { runs = 5, beforeEach } = {}) {
  const samples = [];
  for (let r = 0; r < runs; r++) {
    if (beforeEach) await beforeEach(r);
    const start = performance.now();
    await fn(r);
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples
  };
}

function fmtStat(stat) {
  return `${stat.median.toFixed(3)} ms (min: ${stat.min.toFixed(3)}, max: ${stat.max.toFixed(3)})`;
}

const results = {};

console.log('====================================================');
console.log('FontPrepender 真實場景效能基準測試 (5 次中位數)');
console.log('====================================================\n');

// =============================================================================
// R1：真實 CSSOM <link> 規則壓測 (2,000 條 x 12 屬性、85% 無字型)
// =============================================================================
{
  const fp = loadUserscript();

  const fontStacks = [
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    '"Fira Code", Monaco, Consolas, monospace',
    '"Font Awesome 6 Free", FontAwesome',
    'var(--font-sans)',
    '"Titillium Web", sans-serif'
  ];
  const nonFontProps = [
    'display',
    'position',
    'margin-top',
    'padding-left',
    'color',
    'background-color',
    'line-height',
    'border-radius',
    '--tw-bg-opacity',
    '--tw-ring-offset-shadow',
    '--color-surface',
    '--spacing-md'
  ];

  const counters = {
    fontFamilyGetterReads: 0,
    getPropertyValueCalls: 0,
    indexedPropReads: 0,
    setPropertyCalls: 0
  };

  function createRealisticStyle(initialFont, isRoot = false, countReads = false) {
    let currentFont = initialFont;
    let currentPriority = initialFont && Math.random() < 0.2 ? 'important' : '';
    const customVars = {
      '--font-sans': 'system-ui, sans-serif',
      '--font-mono': 'Consolas, monospace'
    };

    const propsList = isRoot
      ? ['--font-sans', '--font-mono', ...nonFontProps.slice(2)]
      : [...nonFontProps];
    if (initialFont) {
      propsList[0] = 'font-family';
    }

    const styleObj = {
      length: propsList.length,
      get fontFamily() {
        if (countReads) counters.fontFamilyGetterReads++;
        return currentFont;
      },
      getPropertyValue(prop) {
        if (countReads) counters.getPropertyValueCalls++;
        if (prop === 'font-family') return currentFont;
        if (prop in customVars) return customVars[prop];
        return '';
      },
      getPropertyPriority(prop) {
        if (prop === 'font-family') return currentPriority;
        return '';
      },
      setProperty(prop, val, prio = '') {
        if (countReads) counters.setPropertyCalls++;
        if (prop === 'font-family') {
          currentFont = val;
          currentPriority = prio;
        } else if (prop in customVars) {
          customVars[prop] = val;
        }
      },
      _reset() {
        currentFont = initialFont;
        customVars['--font-sans'] = 'system-ui, sans-serif';
        customVars['--font-mono'] = 'Consolas, monospace';
      }
    };

    for (let p = 0; p < propsList.length; p++) {
      const propName = propsList[p];
      Object.defineProperty(styleObj, p, {
        enumerable: true,
        get() {
          if (countReads) counters.indexedPropReads++;
          return propName;
        }
      });
    }
    return styleObj;
  }

  function buildRealisticRules(totalCount, countReads = false) {
    const topRules = [];
    const resetters = [];
    let i = 0;
    while (i < totalCount) {
      if (i > 0 && i % 20 === 0 && i + 4 <= totalCount) {
        const inner = [];
        for (let m = 0; m < 4; m++) {
          const idx = i + m;
          const hasFont = idx % 20 < 3; // 15%
          const st = createRealisticStyle(hasFont ? fontStacks[idx % fontStacks.length] : '', false, countReads);
          resetters.push(st._reset);
          inner.push({
            selectorText: `.mq-card-${idx} > .title`,
            style: st
          });
        }
        topRules.push({ cssRules: inner });
        i += 4;
      } else {
        const isRoot = i === 0;
        const hasFont = !isRoot && i % 20 < 3; // 15%
        const st = createRealisticStyle(
          hasFont ? fontStacks[i % fontStacks.length] : '',
          isRoot,
          countReads
        );
        resetters.push(st._reset);
        topRules.push({
          selectorText: isRoot ? ':root' : `.el-${i} .text`,
          style: st
        });
        i++;
      }
    }
    return { topRules, resetters };
  }

  // 未計時之呼叫次數統計
  const counted = buildRealisticRules(2000, true);
  fp.processStyleSheet({
    ownerNode: { tagName: 'LINK', rel: 'stylesheet' },
    cssRules: counted.topRules
  });

  // 預熱 JIT
  const warm = buildRealisticRules(400, false);
  for (let w = 0; w < 3; w++) {
    warm.resetters.forEach((fn) => fn());
    fp.processStyleSheet({ ownerNode: { tagName: 'LINK', rel: 'stylesheet' }, cssRules: warm.topRules });
  }

  const bench = buildRealisticRules(2000, false);
  const r1Link = measureMedian(
    () => {
      fp.processStyleSheet({
        ownerNode: { tagName: 'LINK', rel: 'stylesheet' },
        cssRules: bench.topRules
      });
    },
    {
      runs: 5,
      beforeEach: () => bench.resetters.forEach((fn) => fn())
    }
  );

  const r1StyleNoVars = measureMedian(
    () => {
      fp.processStyleSheet({
        ownerNode: { tagName: 'STYLE', textContent: '.a{font-family:Arial}' },
        cssRules: bench.topRules
      });
    },
    {
      runs: 5,
      beforeEach: () => bench.resetters.forEach((fn) => fn())
    }
  );

  // R1-C：JSDOM 真實 CSSStyleSheet 2,000 條規則
  const cssLines = [':root { --font-sans: system-ui, sans-serif; --tw-bg-opacity: 1; }'];
  for (let i = 1; i < 2000; i++) {
    const hasFont = i % 20 < 3;
    const baseDecls =
      'display:block;position:relative;margin-top:4px;padding-left:8px;color:#222;background-color:#fff;line-height:1.5;border-radius:4px;--tw-bg-opacity:1;--tw-ring-offset-shadow:0 0 #000;--color-surface:#fafafa;--spacing-md:16px';
    if (hasFont) {
      cssLines.push(`.r-${i}{font-family:${fontStacks[i % fontStacks.length]};${baseDecls}}`);
    } else {
      cssLines.push(`.r-${i}{${baseDecls}}`);
    }
  }
  const bigCssText = cssLines.join('\n');
  const jsdomSheets = [];
  for (let r = 0; r < 5; r++) {
    const dom = new JSDOM(`<!DOCTYPE html><html><head><style>${bigCssText}</style></head><body></body></html>`);
    jsdomSheets.push(dom.window.document.querySelector('style').sheet);
  }
  const r1Jsdom = measureMedian((r) => {
    fp.processStyleSheet(jsdomSheets[r]);
  }, { runs: 5 });

  results.R1 = {
    linkMedianMs: r1Link.median,
    styleNoVarsMedianMs: r1StyleNoVars.median,
    customPropLoopDeltaMs: r1Link.median - r1StyleNoVars.median,
    jsdomMedianMs: r1Jsdom.median,
    counters
  };

  console.log('[R1] 真實 CSSOM 規則壓測 (2,000 條 × 12 屬性，85% 無字型)：');
  console.log(`  - <link> (hasFontVars=true) ：${fmtStat(r1Link)}`);
  console.log(`  - <style> 無變數 (對照)     ：${fmtStat(r1StyleNoVars)}`);
  console.log(`  - 屬性迴圈空轉淨開銷 (Δ)    ：${(r1Link.median - r1StyleNoVars.median).toFixed(3)} ms`);
  console.log(`  - JSDOM 真實 CSSStyleSheet  ：${fmtStat(r1Jsdom)}`);
  console.log(
    `  - 單趟跨界計數：fontFamily getter=${counters.fontFamilyGetterReads}, getPropertyValue=${counters.getPropertyValueCalls}, style[p]=${counters.indexedPropReads}, setProperty=${counters.setPropertyCalls}\n`
  );
}

// =============================================================================
// R2：真實 MutationObserver 壓測 (巢狀容器 + 高頻 attributes:style + takeRecords)
// =============================================================================
{
  let totalTakeRecordsCalls = 0;
  let totalDrainedEchoes = 0;
  let zeroWriteTakeRecordsCalls = 0;

  // R2-A：多層巢狀容器批次插入 (60 張 4 層卡片 = ~1,200 節點，含混合父/子 addedNodes 與 SVG 剪枝)
  const r2aBatches = [];
  for (let r = 0; r < 5; r++) {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><main id="feed"></main></body></html>');
    const { window } = dom;
    const { document, Element, HTMLElement, MutationObserver, CSSStyleSheet, CSSStyleDeclaration } = window;
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' });

    const OrigMO = MutationObserver;
    let activeObs = null;
    let callbackCount = 0;
    class TrackedMO extends OrigMO {
      constructor(cb) {
        super((muts, obs) => {
          callbackCount++;
          return cb(muts, obs);
        });
        activeObs = this;
      }
      takeRecords() {
        const recs = super.takeRecords();
        totalTakeRecordsCalls++;
        totalDrainedEchoes += recs.length;
        return recs;
      }
    }
    window.MutationObserver = TrackedMO;

    loadUserscript({
      window,
      document,
      Element,
      HTMLElement,
      MutationObserver: TrackedMO,
      CSSStyleSheet,
      CSSStyleDeclaration
    });

    const feed = document.getElementById('feed');
    const cards = [];
    for (let c = 0; c < 60; c++) {
      const article = document.createElement('article');
      article.className = 'post-card';
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'card-body';
      const h3 = document.createElement('h3');
      const link = document.createElement('a');
      link.textContent = `Headline ${c}`;
      if (c % 6 === 0) {
        link.setAttribute('style', 'font-family: "Apple Lihei Pro", Arial !important;');
      }
      h3.appendChild(link);
      const p = document.createElement('p');
      const span = document.createElement('span');
      span.textContent = 'Excerpt text';
      if (c % 5 === 0) {
        span.setAttribute('style', 'font-family: Roboto, sans-serif;');
      }
      p.appendChild(span);
      const svg = document.createElement('svg');
      for (let g = 0; g < 6; g++) {
        svg.appendChild(document.createElement('path'));
      }
      const meta = document.createElement('div');
      for (let m = 0; m < 6; m++) {
        meta.appendChild(document.createElement('span'));
      }
      bodyDiv.appendChild(h3);
      bodyDiv.appendChild(p);
      bodyDiv.appendChild(svg);
      bodyDiv.appendChild(meta);
      article.appendChild(bodyDiv);
      cards.push({ article, bodyDiv });
    }

    r2aBatches.push({
      feed,
      cards,
      getCallbackCount: () => callbackCount,
      resetCallbackCount: () => {
        callbackCount = 0;
      },
      activeObs
    });
  }

  const r2a = await measureMedianAsync(
    async (r) => {
      const b = r2aBatches[r];
      b.resetCallbackCount();
      for (let i = 0; i < b.cards.length; i++) {
        b.feed.appendChild(b.cards[i].article);
        // 混合同一批次內之子節點附加，觸發 containerSet 祖先檢查路徑
        if (i % 4 === 0) {
          const extra = b.feed.ownerDocument.createElement('span');
          extra.setAttribute('style', 'font-family: Georgia, serif;');
          b.cards[i].bodyDiv.appendChild(extra);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    { runs: 5 }
  );

  // R2-B：高頻 attributes: style 變動 (500 次，90% 非字型屬性)
  const r2bEnvs = [];
  for (let r = 0; r < 5; r++) {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="stage"></div></body></html>');
    const { window } = dom;
    const { document, Element, HTMLElement, MutationObserver, CSSStyleSheet, CSSStyleDeclaration } = window;
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' });
    loadUserscript({
      window,
      document,
      Element,
      HTMLElement,
      MutationObserver,
      CSSStyleSheet,
      CSSStyleDeclaration
    });
    const stage = document.getElementById('stage');
    const els = [];
    for (let i = 0; i < 150; i++) {
      const el = document.createElement('div');
      if (i >= 135 && i < 143) {
        el.setAttribute('style', 'font-family: "Google Sans", "Google Sans Flex", "Noto Sans CJK TC", Arial;');
      }
      stage.appendChild(el);
      els.push(el);
    }
    r2bEnvs.push({ els });
  }
  // 先清空初始 childList 隊列
  await new Promise((resolve) => setTimeout(resolve, 10));

  const r2b = await measureMedianAsync(
    async (r) => {
      const { els } = r2bEnvs[r];
      for (let m = 0; m < 500; m++) {
        const idx = m % 150;
        if (idx < 135) {
          els[idx].setAttribute('style', `transform: translateY(${m}px); opacity: 0.9;`);
        } else if (idx < 143) {
          els[idx].setAttribute('style', 'font-family: "Google Sans", "Google Sans Flex", "Noto Sans CJK TC", Arial; color: red;');
        } else {
          els[idx].setAttribute('style', 'font-family: Verdana, sans-serif;');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    { runs: 5 }
  );

  // R2-C：takeRecords() 回音抑制與零寫入空呼叫驗證
  const echoDom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="echo-root"></div></body></html>');
  const ew = echoDom.window;
  Object.defineProperty(ew.document, 'readyState', { configurable: true, get: () => 'complete' });
  let echoCallbackCount = 0;
  let echoDrained = 0;
  let echoZeroWriteCalls = 0;
  let inZeroWritePhase = false;
  const OrigEchoMO = ew.MutationObserver;
  class EchoSpyMO extends OrigEchoMO {
    constructor(cb) {
      super((muts, obs) => {
        echoCallbackCount++;
        return cb(muts, obs);
      });
    }
    takeRecords() {
      const recs = super.takeRecords();
      echoDrained += recs.length;
      if (inZeroWritePhase) echoZeroWriteCalls++;
      return recs;
    }
  }
  ew.MutationObserver = EchoSpyMO;
  loadUserscript({
    window: ew,
    document: ew.document,
    Element: ew.Element,
    HTMLElement: ew.HTMLElement,
    MutationObserver: EchoSpyMO,
    CSSStyleSheet: ew.CSSStyleSheet,
    CSSStyleDeclaration: ew.CSSStyleDeclaration
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  echoCallbackCount = 0;
  echoDrained = 0;
  const echoEl = ew.document.createElement('div');
  echoEl.setAttribute('style', 'font-family: Arial, sans-serif;');
  ew.document.getElementById('echo-root').appendChild(echoEl);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const echoCallbacksAfterSelfWrite = echoCallbackCount; // 應為 1（無第二次回音喚醒）

  inZeroWritePhase = true;
  const nonFontEl = ew.document.createElement('div');
  ew.document.getElementById('echo-root').appendChild(nonFontEl);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let i = 0; i < 50; i++) {
    nonFontEl.setAttribute('style', `top: ${i}px;`);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  zeroWriteTakeRecordsCalls = echoZeroWriteCalls;

  results.R2 = {
    nestedContainerMedianMs: r2a.median,
    attrStyleBurstMedianMs: r2b.median,
    echoCallbacksOnSelfWrite: echoCallbacksAfterSelfWrite,
    drainedEchoRecords: echoDrained,
    zeroWriteTakeRecordsCalls
  };

  console.log('[R2] 真實 MutationObserver 壓測：');
  console.log(`  - R2-A 60 張 4 層巢狀容器 (~1,200 節點)：${fmtStat(r2a)}`);
  console.log(`  - R2-B 500 次 style 屬性變動 (90% 非字型)：${fmtStat(r2b)}`);
  console.log(
    `  - R2-C takeRecords() 回音驗證：自寫入喚醒次數=${echoCallbacksAfterSelfWrite} (預期=1), 已排空回音=${echoDrained}, 零寫入批次 takeRecords 呼叫=${zeroWriteTakeRecordsCalls}\n`
  );
}

// =============================================================================
// R3：500KB 混合外部 CDN CSS 改寫與高頻 insertRule (模擬 X.com)
// =============================================================================
{
  const fp = loadUserscript();

  // R3-A：合成 >= 500KB 混合壓縮 CDN CSS
  const chunks = [];
  const svgUri =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 22h20L12 2zm0 5l6 11H6l6-11z"/></svg>'.repeat(4));
  let ruleIdx = 0;
  let totalLen = 0;
  while (totalLen < 520 * 1024) {
    let chunk;
    if (ruleIdx % 250 === 0 && ruleIdx < 3750) {
      chunk = `@font-face{font-family:"CDNFont-${ruleIdx}";src:url("../fonts/cdn-${ruleIdx}.woff2") format("woff2");}`;
    } else if (ruleIdx % 35 === 0) {
      chunk = `.icon-bg-${ruleIdx}{background-image:url("${svgUri}");width:24px;height:24px;}`;
    } else if (ruleIdx % 30 === 0) {
      chunk = `.bg-rel-${ruleIdx}{background:url("./img/sprite-${ruleIdx}.webp") no-repeat;}`;
    } else if (ruleIdx % 13 === 0) {
      chunk = `@media (min-width:768px){.headline-${ruleIdx}{--font-family-token:sans-serif;font-family:"Titillium Web",Arial,sans-serif !important;}}`;
    } else {
      chunk = `.u-box-${ruleIdx}{display:flex;align-items:center;padding:8px 12px;margin:0 auto;color:#111;border:1px solid #e5e7eb;--tw-space-x:1rem;}`;
    }
    chunks.push(chunk);
    totalLen += chunk.length + 1;
    ruleIdx++;
  }
  const css500KB = chunks.join('');
  const cdnBaseUrl = 'https://static0.xdaimages.com/assets/build/main.css';

  // 預熱
  fp.rewriteCssContent(css500KB.slice(0, 60000), cdnBaseUrl);
  const r3a = measureMedian(() => {
    fp.rewriteCssContent(css500KB, cdnBaseUrl);
  }, { runs: 5 });

  // R3-B：5,000 次高頻 insertRule (模擬 X.com React Native for Web)
  const atomicRules = [];
  for (let i = 0; i < 5000; i++) {
    if (i % 10 === 0) {
      atomicRules.push(`.css-f-${i}{font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}`);
    } else {
      atomicRules.push(`.r-a-${i}{display:flex;flex-direction:column;align-items:stretch;min-width:0;}`);
    }
  }

  // 對照 1：原生輕量 stub CSSStyleSheet（隔離 JS 攔截器開銷）
  class StubSheet {
    insertRule(rule) {
      return rule.length;
    }
  }
  const unhookedStub = loadUserscript({ CSSStyleSheet: StubSheet });
  const stubUnhookedInst = new StubSheet();
  const r3bStubUnhooked = measureMedian(() => {
    for (let i = 0; i < 5000; i++) stubUnhookedInst.insertRule(atomicRules[i], i);
  }, { runs: 5 });

  const hookedStubEnv = loadUserscript({ CSSStyleSheet: StubSheet });
  hookedStubEnv.hookCSSPrototypes();
  const stubHookedInst = new StubSheet();
  const r3bStubHooked = measureMedian(() => {
    for (let i = 0; i < 5000; i++) stubHookedInst.insertRule(atomicRules[i], i);
  }, { runs: 5 });

  // 對照 2：JSDOM 真實 CSSStyleSheet
  const domUn = new JSDOM('<!DOCTYPE html><html><head><style></style></head><body></body></html>');
  const r3bJsdomUnhooked = measureMedian(
    () => {
      const sheet = domUn.window.document.querySelector('style').sheet;
      for (let i = 0; i < 5000; i++) sheet.insertRule(atomicRules[i], sheet.cssRules.length);
    },
    {
      runs: 5,
      beforeEach: () => {
        const s = domUn.window.document.querySelector('style');
        s.textContent = '';
      }
    }
  );

  const domHk = new JSDOM('<!DOCTYPE html><html><head><style></style></head><body></body></html>');
  const hkEnv = loadUserscript({
    window: domHk.window,
    document: domHk.window.document,
    CSSStyleSheet: domHk.window.CSSStyleSheet,
    CSSStyleDeclaration: domHk.window.CSSStyleDeclaration
  });
  hkEnv.hookCSSPrototypes();
  const r3bJsdomHooked = measureMedian(
    () => {
      const sheet = domHk.window.document.querySelector('style').sheet;
      for (let i = 0; i < 5000; i++) sheet.insertRule(atomicRules[i], sheet.cssRules.length);
    },
    {
      runs: 5,
      beforeEach: () => {
        const s = domHk.window.document.querySelector('style');
        s.textContent = '';
      }
    }
  );

  results.R3 = {
    css500KBBytes: Buffer.byteLength(css500KB, 'utf8'),
    rewrite500KBMedianMs: r3a.median,
    insertRuleStubUnhookedMs: r3bStubUnhooked.median,
    insertRuleStubHookedMs: r3bStubHooked.median,
    insertRuleJsdomUnhookedMs: r3bJsdomUnhooked.median,
    insertRuleJsdomHookedMs: r3bJsdomHooked.median
  };

  console.log('[R3] 500KB 外部 CDN CSS 改寫與高頻 insertRule 壓測：');
  console.log(`  - R3-A 500KB (${(Buffer.byteLength(css500KB, 'utf8') / 1024).toFixed(1)} KB) rewriteCssContent：${fmtStat(r3a)}`);
  console.log(`  - R3-B1 5,000 次 insertRule (Stub Unhooked vs Hooked)：${r3bStubUnhooked.median.toFixed(3)} ms vs ${r3bStubHooked.median.toFixed(3)} ms (Δ=${(r3bStubHooked.median - r3bStubUnhooked.median).toFixed(3)} ms)`);
  console.log(`  - R3-B2 5,000 次 insertRule (JSDOM Unhooked vs Hooked)：${r3bJsdomUnhooked.median.toFixed(3)} ms vs ${r3bJsdomHooked.median.toFixed(3)} ms (Δ=${(r3bJsdomHooked.median - r3bJsdomUnhooked.median).toFixed(3)} ms)\n`);
}

// =============================================================================
// R4：HTMLElement.prototype.style 高頻讀取開銷對照測試
// =============================================================================
{
  let styleSink = null;

  const domUn = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
  const docUn = domUn.window.document;
  const warmElsUn = Array.from({ length: 1000 }, () => docUn.createElement('div'));
  for (let i = 0; i < 1000; i++) styleSink = warmElsUn[i].style;

  const r4ColdUn = measureMedian(
    () => {
      for (let i = 0; i < 1000; i++) styleSink = docUn.createElement('div').style;
    },
    { runs: 5 }
  );
  const r4WarmUn = measureMedian(
    () => {
      for (let i = 0; i < 100000; i++) styleSink = warmElsUn[i % 1000].style;
    },
    { runs: 5 }
  );

  const domHk = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
  const winHk = domHk.window;
  const docHk = winHk.document;
  const fpHk = loadUserscript({
    window: winHk,
    document: docHk,
    Element: winHk.Element,
    HTMLElement: winHk.HTMLElement,
    CSSStyleSheet: winHk.CSSStyleSheet,
    CSSStyleDeclaration: winHk.CSSStyleDeclaration
  });
  fpHk.hookCSSPrototypes();

  const warmElsHk = Array.from({ length: 1000 }, () => docHk.createElement('div'));
  for (let i = 0; i < 1000; i++) styleSink = warmElsHk[i].style;

  const r4ColdHk = measureMedian(
    () => {
      for (let i = 0; i < 1000; i++) styleSink = docHk.createElement('div').style;
    },
    { runs: 5 }
  );
  const r4WarmHk = measureMedian(
    () => {
      for (let i = 0; i < 100000; i++) styleSink = warmElsHk[i % 1000].style;
    },
    { runs: 5 }
  );

  results.R4 = {
    coldUnhookedMs: r4ColdUn.median,
    coldHookedMs: r4ColdHk.median,
    coldRatio: r4ColdHk.median / Math.max(r4ColdUn.median, 0.0001),
    warmUnhookedMs: r4WarmUn.median,
    warmHookedMs: r4WarmHk.median,
    warmRatio: r4WarmHk.median / Math.max(r4WarmUn.median, 0.0001),
    sinkActive: Boolean(styleSink)
  };

  console.log('[R4] HTMLElement.prototype.style 高頻讀取開銷對照 (JSDOM)：');
  console.log(`  - R4-A Cold (1,000 新元素首次讀取)  ：Unhooked=${r4ColdUn.median.toFixed(3)} ms vs Hooked=${r4ColdHk.median.toFixed(3)} ms (${results.R4.coldRatio.toFixed(2)}x)`);
  console.log(`  - R4-B Warm (100,000 次熱讀取)      ：Unhooked=${r4WarmUn.median.toFixed(3)} ms vs Hooked=${r4WarmHk.median.toFixed(3)} ms (${results.R4.warmRatio.toFixed(2)}x)\n`);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
}

console.log('====================================================');
console.log('真實場景基線採集完成。');
console.log('====================================================');
process.exit(0);
