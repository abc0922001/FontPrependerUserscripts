// ==UserScript==
// @name         Font Prepender - 自訂網頁與程式碼首選字型
// @name:zh-TW   Font Prepender - 自訂網頁與程式碼首選字型
// @namespace    https://greasyfork.org/zh-TW/users/1237813-abc0922001
// @version      1.0.0
// @description  將 Google Sans、Noto Sans CJK TC 與 Intel One Mono、Noto Sans Mono CJK TC 前置於網頁字型清單最前方，不破壞原始排版與圖示字型
// @description:zh-TW 將 Google Sans、Noto Sans CJK TC 與 Intel One Mono、Noto Sans Mono CJK TC 前置於網頁字型清單最前方，不破壞原始排版與圖示字型
// @author       abc0922001
// @match        *://*/*
// @exclude      *://term.ptt.cc/*
// @exclude      *://docs.google.com/*
// @exclude      *://fonts.google.com/*
// @exclude      *://91pu.com.tw/song/*
// @exclude      *://yuantabank.com/*
// @exclude      *://github.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/**
 * FontPrepender
 * 
 * 核心功能：
 * 1. 一般字型：前置 "Google Sans", "Noto Sans CJK TC"
 * 2. 等寬字型：前置 "Intel One Mono", "Noto Sans Mono CJK TC"
 * 3. 嚴格保護圖示字型 (Icon Fonts) 與專用區字型，避免符號破圖
 * 4. 支援同源 CSSOM 動態掃描、Shadow DOM、CSS 變數與網頁編輯器
 */
(() => {
  'use strict';

  // --- 字型配置常數 ---
  const SANS_FONTS = ['"Google Sans"', '"Noto Sans CJK TC"'];
  const MONO_FONTS = ['"Intel One Mono"', '"Noto Sans Mono CJK TC"'];

  const SANS_PREPEND_STR = `${SANS_FONTS.join(', ')}, `;
  const MONO_PREPEND_STR = `${MONO_FONTS.join(', ')}, `;

  // 基礎樣式注入字型鏈
  const BASE_SANS_STACK = `${SANS_FONTS.join(', ')}, sans-serif`;
  const BASE_MONO_STACK = `${MONO_FONTS.join(', ')}, monospace`;

  // --- 骨架初始化 ---
  function init() {
    // 預計於後續里程碑實作核心功能
  }

  if (typeof document !== 'undefined') {
    init();
  }

  // --- 供單元測試獨立引用（不污染 Userscript 瀏覽器環境）---
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SANS_FONTS,
      MONO_FONTS,
      SANS_PREPEND_STR,
      MONO_PREPEND_STR,
      BASE_SANS_STACK,
      BASE_MONO_STACK,
      init
    };
  }
})();
