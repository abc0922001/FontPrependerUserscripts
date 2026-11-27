import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SITES = [
  { key: 'xda', name: 'XDA Archive', url: 'https://www.xda-developers.com/archive/' },
  { key: 'uniko', name: "UNIKO's Hardware", url: 'https://unikoshardware.com/' },
  { key: '9to5google', name: '9to5Google', url: 'https://9to5google.com/' }
];

const HOTSPOT_KEYS = [
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

function parseArgs(argv) {
  const opts = {
    headless: false,
    rounds: 3,
    sites: SITES.map((s) => s.key),
    out: null,
    gitRef: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headless') opts.headless = true;
    else if (arg.startsWith('--rounds=')) opts.rounds = Math.max(1, parseInt(arg.slice(9), 10) || 3);
    else if (arg.startsWith('--sites=')) opts.sites = arg.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6);
    else if (arg === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (arg.startsWith('--git-ref=')) opts.gitRef = arg.slice(10);
    else if (arg === '--git-ref' && argv[i + 1]) opts.gitRef = argv[++i];
  }
  return opts;
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome executable not found. Set CHROME_PATH environment variable.');
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (err) => reject(err), { once: true });
      this.ws.addEventListener('message', (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.id) {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
            else entry.resolve(msg.result);
          }
        } else if (msg.method) {
          const key = `${msg.sessionId || ''}:${msg.method}`;
          const cbs = this.listeners.get(key);
          if (cbs) {
            for (const cb of [...cbs]) cb(msg.params);
          }
        }
      });
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, cb, sessionId = '') {
    const key = `${sessionId}:${method}`;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  waitFor(method, sessionId = '', timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      const off = this.on(
        method,
        (params) => {
          clearTimeout(timer);
          off();
          resolve(params);
        },
        sessionId
      );
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function launchChrome(headless) {
  const chromePath = findChromeBinary();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-cdp-'));
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1440,900'
  ];
  if (headless) {
    args.push('--headless=new');
  }

  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Chrome DevTools WS URL')), 15000);
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited prematurely (${code}): ${stderrBuf}`));
    });
  });

  return { proc, wsUrl, userDataDir };
}

function buildLoafObserverScript() {
  return `(() => {
    if (window.self !== window.top) return;
    window.__fpLoAF = [];
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const scripts = Array.isArray(entry.scripts)
            ? entry.scripts.map((s) => ({
                invoker: s.invoker ?? '',
                invokerType: s.invokerType ?? '',
                sourceURL: s.sourceURL ?? '',
                sourceFunctionName: s.sourceFunctionName ?? '',
                duration: s.duration ?? 0,
                forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration ?? 0
              }))
            : [];
          window.__fpLoAF.push({
            startTime: entry.startTime ?? 0,
            duration: entry.duration ?? 0,
            blockingDuration: entry.blockingDuration ?? 0,
            renderStart: entry.renderStart ?? 0,
            styleAndLayoutStart: entry.styleAndLayoutStart ?? 0,
            scripts
          });
        }
      });
      po.observe({ type: 'long-animation-frame', buffered: true });
      window.__fpFlushLoAF = () => {
        const rest = typeof po.takeRecords === 'function' ? po.takeRecords() : [];
        for (const entry of rest) {
          const scripts = Array.isArray(entry.scripts)
            ? entry.scripts.map((s) => ({
                invoker: s.invoker ?? '',
                invokerType: s.invokerType ?? '',
                sourceURL: s.sourceURL ?? '',
                sourceFunctionName: s.sourceFunctionName ?? '',
                duration: s.duration ?? 0,
                forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration ?? 0
              }))
            : [];
          window.__fpLoAF.push({
            startTime: entry.startTime ?? 0,
            duration: entry.duration ?? 0,
            blockingDuration: entry.blockingDuration ?? 0,
            renderStart: entry.renderStart ?? 0,
            styleAndLayoutStart: entry.styleAndLayoutStart ?? 0,
            scripts
          });
        }
        return window.__fpLoAF;
      };
    } catch {
      // ignore if LoAF unsupported
    }
  })();`;
}

function analyzeTrace(events) {
  let targetPid = null;
  let targetTid = null;
  let commitMainPid = null;
  let commitMainTid = null;
  let parseHtmlPid = null;
  let parseHtmlTid = null;
  const rendererThreads = new Map();

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') {
      rendererThreads.set(e.pid, e.tid);
    }
    if (
      e.name === 'CommitLoad' &&
      e.args?.data?.isOutermostMainFrame === true &&
      typeof e.args?.data?.url === 'string' &&
      e.args.data.url.startsWith('http')
    ) {
      commitMainPid = e.pid;
      commitMainTid = e.tid;
    }
    if (
      e.name === 'ParseHTML' &&
      typeof e.args?.beginData?.url === 'string' &&
      e.args.beginData.url.startsWith('http')
    ) {
      if (parseHtmlPid === null) {
        parseHtmlPid = e.pid;
        parseHtmlTid = e.tid;
      }
    }
    if (e.name === 'TracingStartedInBrowser' && e.args?.data?.frames) {
      const mainFrame = e.args.data.frames.find((f) => !f.parent) || e.args.data.frames[0];
      if (mainFrame?.processId) targetPid = mainFrame.processId;
    }
  }

  if (commitMainPid !== null) {
    targetPid = commitMainPid;
    targetTid = rendererThreads.get(commitMainPid) ?? commitMainTid;
  } else if (parseHtmlPid !== null) {
    targetPid = parseHtmlPid;
    targetTid = rendererThreads.get(parseHtmlPid) ?? parseHtmlTid;
  } else if (targetPid && rendererThreads.has(targetPid)) {
    targetTid = rendererThreads.get(targetPid);
  } else {
    // fallback: pick the CrRendererMain with most UpdateLayoutTree / Layout events
    const counts = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (rendererThreads.get(e.pid) === e.tid && (e.name === 'UpdateLayoutTree' || e.name === 'Layout')) {
        const k = `${e.pid}:${e.tid}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    let bestCount = -1;
    for (const [k, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        const [p, t] = k.split(':').map(Number);
        targetPid = p;
        targetTid = t;
      }
    }
  }

  const JS_EXEC_TASKS = new Set([
    'FunctionCall',
    'EvaluateScript',
    'v8.run',
    'RunMicrotasks',
    'EventDispatch',
    'TimerFire',
    'FireIdleCallback',
    'FireAnimationFrame'
  ]);

  const jsWindows = [];
  const styleEvents = [];
  const layoutEvents = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.pid !== targetPid || e.tid !== targetTid) continue;
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (JS_EXEC_TASKS.has(e.name)) {
      jsWindows.push([e.ts, e.ts + e.dur]);
    } else if (e.name === 'UpdateLayoutTree' || e.name === 'RecalcStyle') {
      styleEvents.push(e);
    } else if (e.name === 'Layout') {
      layoutEvents.push(e);
    }
  }

  jsWindows.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const mergedJsWindows = [];
  for (let i = 0; i < jsWindows.length; i++) {
    const [s, e] = jsWindows[i];
    if (mergedJsWindows.length === 0) {
      mergedJsWindows.push([s, e]);
    } else {
      const last = mergedJsWindows[mergedJsWindows.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else {
        mergedJsWindows.push([s, e]);
      }
    }
  }

  function isInsideJs(ts) {
    let lo = 0;
    let hi = mergedJsWindows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = mergedJsWindows[mid];
      if (ts < s) hi = mid - 1;
      else if (ts > e) lo = mid + 1;
      else return true;
    }
    return false;
  }

  function hasStack(e) {
    const st = e.args?.beginData?.stackTrace || e.args?.data?.stackTrace;
    return Array.isArray(st) && st.length > 0 ? st : null;
  }

  function isFontPrependerStack(st) {
    if (!st) return false;
    return st.some((frame) => typeof frame.url === 'string' && frame.url.includes('FontPrepender.user.js'));
  }

  let styleDurationMs = 0;
  let forcedStyleDurationMs = 0;
  let fpForcedStyleDurationMs = 0;
  let forcedStyleCount = 0;

  for (const e of styleEvents) {
    const durMs = e.dur / 1000;
    styleDurationMs += durMs;
    const st = hasStack(e);
    if (st || isInsideJs(e.ts)) {
      forcedStyleDurationMs += durMs;
      forcedStyleCount++;
      if (isFontPrependerStack(st)) fpForcedStyleDurationMs += durMs;
    }
  }

  let layoutDurationMs = 0;
  let forcedLayoutDurationMs = 0;
  let fpForcedLayoutDurationMs = 0;
  let forcedLayoutCount = 0;

  for (const e of layoutEvents) {
    const durMs = e.dur / 1000;
    layoutDurationMs += durMs;
    const st = hasStack(e);
    if (st || isInsideJs(e.ts)) {
      forcedLayoutDurationMs += durMs;
      forcedLayoutCount++;
      if (isFontPrependerStack(st)) fpForcedLayoutDurationMs += durMs;
    }
  }

  return {
    styleDurationMs,
    forcedStyleDurationMs,
    fpForcedStyleDurationMs,
    forcedStyleCount,
    layoutDurationMs,
    forcedLayoutDurationMs,
    fpForcedLayoutDurationMs,
    forcedLayoutCount
  };
}

function summarizeLoaf(entries) {
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let totalBlockingMs = 0;
  let renderStyleLayoutMs = 0;
  let fpScriptDurationMs = 0;
  let fpForcedStyleAndLayoutMs = 0;

  for (const e of entries || []) {
    const dur = e.duration ?? 0;
    const blk = e.blockingDuration ?? 0;
    const start = e.startTime ?? 0;
    const sStart = e.styleAndLayoutStart ?? 0;
    totalDurationMs += dur;
    if (dur > maxDurationMs) maxDurationMs = dur;
    totalBlockingMs += blk;
    if (sStart > 0 && start + dur > sStart) {
      renderStyleLayoutMs += start + dur - sStart;
    }
    for (const s of e.scripts || []) {
      if (typeof s.sourceURL === 'string' && s.sourceURL.includes('FontPrepender.user.js')) {
        fpScriptDurationMs += s.duration ?? 0;
        fpForcedStyleAndLayoutMs += s.forcedStyleAndLayoutDuration ?? 0;
      }
    }
  }

  return {
    count: (entries || []).length,
    totalDurationMs,
    maxDurationMs,
    totalBlockingMs,
    renderStyleLayoutMs,
    fpScriptDurationMs,
    fpForcedStyleAndLayoutMs
  };
}

async function runBlinkStyleGetterMicrobench(cdp, userscriptCode) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const expr = (hookCode) => `(() => {
      const runMedian = (fn, runs = 5) => {
        const s = [];
        for (let r = 0; r < runs; r++) {
          const t0 = performance.now();
          fn();
          s.push(performance.now() - t0);
        }
        s.sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      const warmEls = Array.from({ length: 1000 }, () => document.createElement('div'));
      let sink = null;
      for (let i = 0; i < 1000; i++) sink = warmEls[i].style;
      const coldBefore = runMedian(() => {
        for (let i = 0; i < 1000; i++) sink = document.createElement('div').style;
      });
      const warmBefore = runMedian(() => {
        for (let i = 0; i < 100000; i++) sink = warmEls[i % 1000].style;
      });
      ${hookCode}
      const warmElsAfter = Array.from({ length: 1000 }, () => document.createElement('div'));
      for (let i = 0; i < 1000; i++) sink = warmElsAfter[i].style;
      const coldAfter = runMedian(() => {
        for (let i = 0; i < 1000; i++) sink = document.createElement('div').style;
      });
      const warmAfter = runMedian(() => {
        for (let i = 0; i < 100000; i++) sink = warmElsAfter[i % 1000].style;
      });
      return { coldBefore, coldAfter, warmBefore, warmAfter, sinkOk: Boolean(sink) };
    })()`;

    const res = await cdp.send(
      'Runtime.evaluate',
      {
        expression: expr(userscriptCode),
        returnByValue: true
      },
      sessionId
    );
    return res.result.value;
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

async function runSingleSitePass(cdp, site, mode, userscriptCode) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const traceEvents = [];
  const offData = cdp.on('Tracing.dataCollected', (params) => {
    const chunk = params.value;
    if (Array.isArray(chunk)) {
      for (let i = 0; i < chunk.length; i++) traceEvents.push(chunk[i]);
    }
  });

  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Performance.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);

    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: buildLoafObserverScript() },
      sessionId
    );

    if (mode === 'treatment') {
      const treatmentBootstrap = `try { if (typeof localStorage !== 'undefined') localStorage.setItem('fp-profile', '1'); } catch {}\n${userscriptCode}\n//# sourceURL=https://userscript.local/FontPrepender.user.js`;
      await cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: treatmentBootstrap },
        sessionId
      );
    }

    await cdp.send('Tracing.start', {
      categories:
        'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute,blink.user_timing',
      transferMode: 'ReportEvents'
    });

    let dclFired = false;
    const offDcl = cdp.on('Page.domContentEventFired', () => {
      dclFired = true;
    }, sessionId);

    const loadPromise = cdp.waitFor('Page.loadEventFired', sessionId, 25000).catch((err) => {
      if (dclFired) return { timedOutAfterDcl: true };
      throw err;
    });

    await cdp.send('Page.navigate', { url: site.url }, sessionId);
    await loadPromise;
    offDcl();

    const pageCheck = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `({ title: document.title, href: location.href })`,
        returnByValue: true
      },
      sessionId
    );
    const title = pageCheck.result?.value?.title || '';
    const href = pageCheck.result?.value?.href || '';
    const isChallenge =
      /just a moment|attention required|verify you are human/i.test(title) ||
      href.includes('challenges.cloudflare.com');

    if (isChallenge) {
      const donePromise = cdp.waitFor('Tracing.tracingComplete');
      await cdp.send('Tracing.end');
      await donePromise;
      return { blockedByChallenge: true, title, href };
    }

    await sleep(2000);

    // 6 downward scrolls + 2 upward scrolls
    for (let s = 0; s < 6; s++) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 720, y: 450, deltaX: 0, deltaY: 650 },
        sessionId
      ).catch(() => {});
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0, 650)' }, sessionId).catch(() => {});
      await sleep(250);
    }
    for (let s = 0; s < 2; s++) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 720, y: 450, deltaX: 0, deltaY: -650 },
        sessionId
      ).catch(() => {});
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0, -650)' }, sessionId).catch(() => {});
      await sleep(250);
    }

    await sleep(1500);

    const evalRes = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const loaf = typeof window.__fpFlushLoAF === 'function' ? window.__fpFlushLoAF() : (window.__fpLoAF || []);
          const prof = window.__fpProf ? { t: window.__fpProf.t, n: window.__fpProf.n } : null;
          const domStats = {
            hasBaseStyle: Boolean(document.getElementById('font-prepender-base-style')),
            prependedLinkStyles: document.querySelectorAll('style[data-prepended-source]').length,
            totalNodes: document.getElementsByTagName('*').length
          };
          return { loaf, prof, domStats };
        })()`,
        returnByValue: true
      },
      sessionId
    );

    const perfMetrics = await cdp.send('Performance.getMetrics', {}, sessionId);
    const metricMap = Object.fromEntries((perfMetrics.metrics || []).map((m) => [m.name, m.value]));

    const donePromise = cdp.waitFor('Tracing.tracingComplete', '', 30000);
    await cdp.send('Tracing.end');
    await donePromise;

    const { loaf, prof, domStats } = evalRes.result.value;
    return {
      blockedByChallenge: false,
      trace: analyzeTrace(traceEvents),
      loaf: summarizeLoaf(loaf),
      prof,
      domStats,
      cdpMetrics: {
        recalcStyleDurationMs: (metricMap.RecalcStyleDuration ?? 0) * 1000,
        layoutDurationMs: (metricMap.LayoutDuration ?? 0) * 1000,
        scriptDurationMs: (metricMap.ScriptDuration ?? 0) * 1000
      }
    };
  } finally {
    offData();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

function aggregateRuns(runs) {
  const valid = runs.filter((r) => !r.blockedByChallenge && !r.error);
  if (valid.length === 0) return { blockedByChallenge: runs.some((r) => r.blockedByChallenge), validCount: 0 };

  const pick = (fn) => median(valid.map(fn));
  const agg = {
    validCount: valid.length,
    trace: {
      styleDurationMs: pick((r) => r.trace.styleDurationMs),
      forcedStyleDurationMs: pick((r) => r.trace.forcedStyleDurationMs),
      fpForcedStyleDurationMs: pick((r) => r.trace.fpForcedStyleDurationMs),
      forcedStyleCount: pick((r) => r.trace.forcedStyleCount),
      layoutDurationMs: pick((r) => r.trace.layoutDurationMs),
      forcedLayoutDurationMs: pick((r) => r.trace.forcedLayoutDurationMs),
      fpForcedLayoutDurationMs: pick((r) => r.trace.fpForcedLayoutDurationMs),
      forcedLayoutCount: pick((r) => r.trace.forcedLayoutCount)
    },
    loaf: {
      count: pick((r) => r.loaf.count),
      totalDurationMs: pick((r) => r.loaf.totalDurationMs),
      maxDurationMs: pick((r) => r.loaf.maxDurationMs),
      totalBlockingMs: pick((r) => r.loaf.totalBlockingMs),
      renderStyleLayoutMs: pick((r) => r.loaf.renderStyleLayoutMs),
      fpScriptDurationMs: pick((r) => r.loaf.fpScriptDurationMs),
      fpForcedStyleAndLayoutMs: pick((r) => r.loaf.fpForcedStyleAndLayoutMs)
    },
    cdpMetrics: {
      recalcStyleDurationMs: pick((r) => r.cdpMetrics.recalcStyleDurationMs),
      layoutDurationMs: pick((r) => r.cdpMetrics.layoutDurationMs),
      scriptDurationMs: pick((r) => r.cdpMetrics.scriptDurationMs)
    },
    domStats: {
      totalNodes: pick((r) => r.domStats.totalNodes),
      prependedLinkStyles: pick((r) => r.domStats.prependedLinkStyles),
      hasBaseStyle: valid.every((r) => r.domStats.hasBaseStyle)
    }
  };

  if (valid.some((r) => r.prof)) {
    agg.prof = {};
    for (const key of HOTSPOT_KEYS) {
      const nMed = pick((r) => r.prof?.n?.[key] ?? 0);
      const tMed = pick((r) => r.prof?.t?.[key] ?? 0);
      agg.prof[key] = { n: nMed, t: tMed, avg: nMed > 0 ? tMed / nMed : 0 };
    }
  }
  return agg;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const userscriptPath = new URL('../src/FontPrepender.user.js', import.meta.url);
  const userscriptCode = opts.gitRef
    ? execFileSync('git', ['show', `${opts.gitRef}:src/FontPrepender.user.js`], { encoding: 'utf8' })
    : fs.readFileSync(userscriptPath, 'utf8');
  const selectedSites = SITES.filter((s) => opts.sites.includes(s.key));

  const { proc, wsUrl, userDataDir } = await launchChrome(opts.headless);
  const cdp = new CDPClient(wsUrl);
  await cdp.connect();

  const report = {
    timestamp: new Date().toISOString(),
    rounds: opts.rounds,
    headless: opts.headless,
    blinkStyleMicrobench: null,
    sites: {}
  };

  try {
    console.log('====================================================');
    console.log(`FontPrepender 真實瀏覽器 CDP 基線採集 (${opts.rounds} 輪中位數)`);
    console.log('====================================================\n');

    report.blinkStyleMicrobench = await runBlinkStyleGetterMicrobench(cdp, userscriptCode);
    const bm = report.blinkStyleMicrobench;
    console.log('[Blink/V8 DOM Microbench] HTMLElement.prototype.style getter:');
    console.log(`  - Cold (1,000 新元素) : Unhooked=${bm.coldBefore.toFixed(3)} ms -> Hooked=${bm.coldAfter.toFixed(3)} ms (${(bm.coldAfter / Math.max(bm.coldBefore, 0.001)).toFixed(2)}x)`);
    console.log(`  - Warm (100,000 次讀取): Unhooked=${bm.warmBefore.toFixed(3)} ms -> Hooked=${bm.warmAfter.toFixed(3)} ms (${(bm.warmAfter / Math.max(bm.warmBefore, 0.001)).toFixed(2)}x)\n`);

    for (const site of selectedSites) {
      console.log(`--- 採集網站：${site.name} (${site.url}) ---`);
      const controlRuns = [];
      const treatmentRuns = [];

      for (let round = 1; round <= opts.rounds; round++) {
        process.stdout.write(`  Round ${round}/${opts.rounds}: control... `);
        const ctrl = await runSingleSitePass(cdp, site, 'control', userscriptCode).catch((err) => ({ error: err.message }));
        controlRuns.push(ctrl);
        if (ctrl.blockedByChallenge) {
          console.log(`BLOCKED (${ctrl.title})`);
        } else if (ctrl.error) {
          console.log(`ERROR (${ctrl.error})`);
        } else {
          console.log(`OK (style=${ctrl.trace.styleDurationMs.toFixed(1)}ms, loaf=${ctrl.loaf.count})`);
        }

        process.stdout.write(`  Round ${round}/${opts.rounds}: treatment... `);
        const trt = await runSingleSitePass(cdp, site, 'treatment', userscriptCode).catch((err) => ({ error: err.message }));
        treatmentRuns.push(trt);
        if (trt.blockedByChallenge) {
          console.log(`BLOCKED (${trt.title})`);
        } else if (trt.error) {
          console.log(`ERROR (${trt.error})`);
        } else {
          console.log(`OK (style=${trt.trace.styleDurationMs.toFixed(1)}ms, loaf=${trt.loaf.count}, nodes=${trt.domStats.totalNodes})`);
        }
      }

      const ctrlMed = aggregateRuns(controlRuns);
      const trtMed = aggregateRuns(treatmentRuns);
      report.sites[site.key] = {
        name: site.name,
        url: site.url,
        controlRuns,
        treatmentRuns,
        controlMedian: ctrlMed,
        treatmentMedian: trtMed
      };

      if (ctrlMed.validCount > 0 && trtMed.validCount > 0) {
        console.log(`\n[${site.key} 3-Run Median Summary]`);
        console.log(
          `  Trace styleDuration       : Control=${ctrlMed.trace.styleDurationMs.toFixed(2)} ms | Treatment=${trtMed.trace.styleDurationMs.toFixed(2)} ms | Δ=${(trtMed.trace.styleDurationMs - ctrlMed.trace.styleDurationMs).toFixed(2)} ms`
        );
        console.log(
          `  Trace forcedStyleDuration : Control=${ctrlMed.trace.forcedStyleDurationMs.toFixed(2)} ms | Treatment=${trtMed.trace.forcedStyleDurationMs.toFixed(2)} ms | fpForced=${trtMed.trace.fpForcedStyleDurationMs.toFixed(2)} ms`
        );
        console.log(
          `  Trace forcedLayoutDuration: Control=${ctrlMed.trace.forcedLayoutDurationMs.toFixed(2)} ms | Treatment=${trtMed.trace.forcedLayoutDurationMs.toFixed(2)} ms | fpForced=${trtMed.trace.fpForcedLayoutDurationMs.toFixed(2)} ms`
        );
        console.log(
          `  LoAF (count / dur / blk)  : Control=${ctrlMed.loaf.count} / ${ctrlMed.loaf.totalDurationMs.toFixed(1)}ms / ${ctrlMed.loaf.totalBlockingMs.toFixed(1)}ms | Treatment=${trtMed.loaf.count} / ${trtMed.loaf.totalDurationMs.toFixed(1)}ms / ${trtMed.loaf.totalBlockingMs.toFixed(1)}ms (fpScript=${trtMed.loaf.fpScriptDurationMs.toFixed(2)}ms)`
        );
        if (trtMed.prof) {
          console.log('  window.__fpProf 9 Hotspots (median n / t ms / avg ms):');
          for (const key of HOTSPOT_KEYS) {
            const p = trtMed.prof[key];
            console.log(`    - ${key.padEnd(26)}: n=${String(p.n).padStart(6)} | t=${p.t.toFixed(3).padStart(8)} ms | avg=${p.avg.toFixed(4)} ms`);
          }
        }
        console.log('');
      }
    }

    if (opts.out) {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify(report, null, 2), 'utf8');
      console.log(`Saved full JSON baseline report to: ${opts.out}`);
    }
  } finally {
    cdp.close();
    try {
      proc.kill();
    } catch {
      // ignore
    }
    await sleep(300);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('[bench-browser] Fatal error:', err);
  process.exit(1);
});
