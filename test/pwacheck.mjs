// PWA検証: ローカルHTTPで配信し、SW登録→オフライン化→再読込でアプリが復元するか確認
import { chromium } from 'playwright';
import http from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/sw-cache-probe.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>SW cache probe</title>');
      return;
    }
    if (p === '/referrer-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ referer: req.headers.referer || '' }));
      return;
    }
    if (p === '/request-no-store-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: 'request-no-store' }));
      return;
    }
    if (p === '/request-no-cache-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: 'request-no-cache' }));
      return;
    }
    if (p === '/authorized-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: 'authorized', authorization: req.headers.authorization || '' }));
      return;
    }
    if (p === '/dynamic-cache-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: 'dynamic', query: req.url.split('?')[1] || '' }));
      return;
    }
    if (p === '/response-no-store-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, kind: 'response-no-store' }));
      return;
    }
    if (p === '/response-no-cache-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, max-age=0' });
      res.end(JSON.stringify({ ok: true, kind: 'response-no-cache' }));
      return;
    }
    if (p === '/response-pragma-no-cache-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ ok: true, kind: 'response-pragma-no-cache' }));
      return;
    }
    if (p === '/response-expired-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT' });
      res.end(JSON.stringify({ ok: true, kind: 'response-expired' }));
      return;
    }
    if (p === '/response-vary-authorization-probe.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Vary': 'Authorization' });
      res.end(JSON.stringify({ ok: true, kind: 'response-vary-authorization' }));
      return;
    }
    if (p === '/' ) p = '/index.html';
    const buf = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}/`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? ' — ' + d : '')); } };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(base + 'sw-cache-probe.html');
const cacheCleanupProbe = await page.evaluate(async () => {
  await caches.open('simplecad-v-old-test');
  await caches.open('unrelated-cache-test');
  await navigator.serviceWorker.register('sw.js');
  const reg = await navigator.serviceWorker.ready;
  if (reg.waiting) reg.waiting.postMessage('skipWaiting');
  await new Promise(resolve => setTimeout(resolve, 300));
  const keys = await caches.keys();
  const result = {
    hasOldSimpleCad: keys.includes('simplecad-v-old-test'),
    hasUnrelated: keys.includes('unrelated-cache-test'),
    hasCurrent: keys.some(k => /^simplecad-v\d+$/.test(k)),
  };
  await caches.delete('unrelated-cache-test');
  return result;
});
check('Service WorkerはSimpleCAD旧キャッシュだけ削除し他キャッシュを残す',
  cacheCleanupProbe.hasOldSimpleCad === false && cacheCleanupProbe.hasUnrelated === true && cacheCleanupProbe.hasCurrent === true,
  JSON.stringify(cacheCleanupProbe));

await page.goto(base);
await page.waitForFunction(() => window.SimpleCAD, null, { timeout: 5000 });

// manifest が link されていて取得・パースできる
const manifestHref = await page.getAttribute('link[rel=manifest]', 'href');
check('manifestがリンクされている', manifestHref === 'manifest.webmanifest', 'href=' + manifestHref);
const man = await page.evaluate(async () => { const r = await fetch('manifest.webmanifest'); return r.ok ? await r.json() : null; });
check('manifestが有効JSONでname/icons/start_urlを持つ', !!man && !!man.name && Array.isArray(man.icons) && man.icons.length > 0 && !!man.start_url, JSON.stringify(man && man.name));
check('manifestは安定したアプリIDと言語を持つ',
  !!man && man.id === '/simple-cad/' && man.lang === 'ja' && new URL(man.id, base).origin === new URL(base).origin,
  JSON.stringify(man && { id: man.id, lang: man.lang }));
const manifestLaunchProbe = await page.evaluate(async manifest => {
  if (!manifest) return { missingManifest: true };
  let startUrl;
  let scopeUrl;
  try {
    startUrl = new URL(manifest.start_url || '', location.href);
    scopeUrl = new URL(manifest.scope || '', location.href);
  } catch (e) {
    return { urlError: e && e.message ? e.message : String(e) };
  }
  const result = {
    startUrl: startUrl.href,
    scopeUrl: scopeUrl.href,
    sameOrigin: startUrl.origin === location.origin && scopeUrl.origin === location.origin,
    inScope: startUrl.href.startsWith(scopeUrl.href),
    status: 0,
    contentType: '',
    title: '',
    hasAppApi: false,
  };
  try {
    const response = await fetch(startUrl.href, { cache: 'no-store' });
    result.status = response.status;
    result.contentType = response.headers.get('Content-Type') || '';
    const text = await response.text();
    result.title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    result.hasAppApi = /\bwindow\.SimpleCAD\b/.test(text);
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
  }
  return result;
}, man);
check('manifestのstart_urlはscope内の同一オリジンアプリHTMLを指す',
  !!man &&
  !!man.scope &&
  manifestLaunchProbe.sameOrigin === true &&
  manifestLaunchProbe.inScope === true &&
  manifestLaunchProbe.status === 200 &&
  /^text\/html\b/i.test(manifestLaunchProbe.contentType) &&
  /SimpleCAD/.test(manifestLaunchProbe.title) &&
  manifestLaunchProbe.hasAppApi === true,
  JSON.stringify(manifestLaunchProbe));
const iconAssets = await page.evaluate(async () => {
  const readPng = async src => {
    const r = await fetch(src, { cache: 'no-store' });
    const blob = await r.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sig = [...bytes.slice(0, 8)].map(v => v.toString(16).padStart(2, '0')).join('');
    const image = await new Promise(resolve => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const out = { width: img.naturalWidth, height: img.naturalHeight };
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ error: 'load-failed' });
      };
      img.src = url;
    });
    return { ok: r.ok, sig, ...image };
  };
  return {
    appleHref: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || '',
    icon192: await readPng('icon-192.png'),
    icon512: await readPng('icon-512.png'),
    apple: await readPng('apple-touch-icon.png'),
  };
});
const manifestIconKeys = new Set((man?.icons || []).map(icon => `${icon.src}|${icon.sizes}|${icon.type}`));
check('manifestとapple-touch-iconはPNGアイコンを提供する',
  manifestIconKeys.has('icon-192.png|192x192|image/png') &&
  manifestIconKeys.has('icon-512.png|512x512|image/png') &&
  iconAssets.appleHref === 'apple-touch-icon.png' &&
  iconAssets.icon192.ok && iconAssets.icon192.sig === '89504e470d0a1a0a' && iconAssets.icon192.width === 192 && iconAssets.icon192.height === 192 &&
  iconAssets.icon512.ok && iconAssets.icon512.sig === '89504e470d0a1a0a' && iconAssets.icon512.width === 512 && iconAssets.icon512.height === 512 &&
  iconAssets.apple.ok && iconAssets.apple.sig === '89504e470d0a1a0a' && iconAssets.apple.width === 180 && iconAssets.apple.height === 180,
  JSON.stringify(iconAssets));
const referrerProbe = await page.evaluate(async () => {
  const r = await fetch('referrer-probe.json?ts=' + Date.now(), { cache: 'no-store' });
  return r.ok ? await r.json() : { status: r.status };
});
check('Referrer-PolicyでHTTPリクエストのRefererを送らない',
  referrerProbe.referer === '',
  JSON.stringify(referrerProbe));

// SWが登録されactiveになる
const swReady = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(reg && (reg.active || reg.installing || reg.waiting));
});
check('Service Workerが登録・有効化される', swReady === true);
await page.waitForFunction(() => !('serviceWorker' in navigator) || !!navigator.serviceWorker.controller, null, { timeout: 5000 }).catch(() => {});

const registerAfterLoad = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator) || !window.SimpleCAD) return { patched: false, unsupported: true, calls: [] };
  const sw = navigator.serviceWorker;
  const originalRegister = sw.register;
  const calls = [];
  let resolveRegister = null;
  let registerPromise = null;
  const fakeReg = {
    addEventListener() {},
    update() {
      calls.push('update');
      return Promise.resolve();
    },
  };
  const resetRegisterPromise = () => {
    registerPromise = new Promise(resolve => {
      resolveRegister = () => resolve(fakeReg);
    });
  };
  resetRegisterPromise();
  const fakeRegister = function (scriptUrl) {
    calls.push(scriptUrl);
    return registerPromise;
  };
  let patched = false;
  try {
    sw.register = fakeRegister;
    patched = sw.register === fakeRegister;
  } catch {}
  if (!patched) {
    try {
      Object.defineProperty(sw, 'register', { configurable: true, value: fakeRegister });
      patched = sw.register === fakeRegister;
    } catch {}
  }
  if (!patched) return { patched, calls };
  let callsBeforeResolve = [];
  let callsAfterFirstResolve = [];
  try {
    window.SimpleCAD.pwaAPI.register();
    window.SimpleCAD.pwaAPI.register();
    window.SimpleCAD.pwaAPI.register();
    await new Promise(resolve => setTimeout(resolve, 50));
    callsBeforeResolve = calls.slice();
    resolveRegister();
    await new Promise(resolve => setTimeout(resolve, 50));
    callsAfterFirstResolve = calls.slice();
    resetRegisterPromise();
    window.SimpleCAD.pwaAPI.register();
    await new Promise(resolve => setTimeout(resolve, 50));
    resolveRegister();
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    try { sw.register = originalRegister; } catch {}
    if (sw.register !== originalRegister) {
      try { Object.defineProperty(sw, 'register', { configurable: true, value: originalRegister }); } catch {}
    }
  }
  return { patched, callsBeforeResolve, callsAfterFirstResolve, calls };
});
check('ロード後のPWA登録APIは多重再実行でも登録中に重複しない',
  registerAfterLoad.patched === true &&
  registerAfterLoad.callsBeforeResolve.filter(x => x === 'sw.js').length === 1 &&
  registerAfterLoad.callsBeforeResolve.includes('update') === false &&
  registerAfterLoad.callsAfterFirstResolve.filter(x => x === 'sw.js').length === 1 &&
  registerAfterLoad.callsAfterFirstResolve.filter(x => x === 'update').length === 1 &&
  registerAfterLoad.calls.filter(x => x === 'sw.js').length === 2 &&
  registerAfterLoad.calls.filter(x => x === 'update').length === 2,
  JSON.stringify(registerAfterLoad));

const registerTimeoutRetry = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator) || !window.SimpleCAD) return { patched: false, unsupported: true, calls: [] };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const sw = navigator.serviceWorker;
  const originalRegister = sw.register;
  const calls = [];
  const never = new Promise(() => {});
  const fakeRegister = function (scriptUrl) {
    calls.push(scriptUrl);
    return never;
  };
  let patched = false;
  try {
    sw.register = fakeRegister;
    patched = sw.register === fakeRegister;
  } catch {}
  if (!patched) {
    try {
      Object.defineProperty(sw, 'register', { configurable: true, value: fakeRegister });
      patched = sw.register === fakeRegister;
    } catch {}
  }
  if (!patched) return { patched, calls };
  let callsDuringHang = [];
  let callsAfterRetry = [];
  try {
    window.SimpleCAD.pwaAPI.register({ timeoutMs: 80 });
    window.SimpleCAD.pwaAPI.register({ timeoutMs: 80 });
    await nextFrame();
    await delay(10);
    callsDuringHang = calls.slice();
    await delay(120);
    window.SimpleCAD.pwaAPI.register({ timeoutMs: 80 });
    await nextFrame();
    await delay(10);
    callsAfterRetry = calls.slice();
    await delay(120);
  } finally {
    try { sw.register = originalRegister; } catch {}
    if (sw.register !== originalRegister) {
      try { Object.defineProperty(sw, 'register', { configurable: true, value: originalRegister }); } catch {}
    }
  }
  return { patched, callsDuringHang, callsAfterRetry, calls };
});
check('PWA登録APIは登録Promiseが固まってもタイムアウト後に再試行できる',
  registerTimeoutRetry.patched === true &&
  registerTimeoutRetry.callsDuringHang.filter(x => x === 'sw.js').length === 1 &&
  registerTimeoutRetry.callsAfterRetry.filter(x => x === 'sw.js').length === 2,
  JSON.stringify(registerTimeoutRetry));

const registerTimerScheduleFailure = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator) || !window.SimpleCAD) return { patched: false, unsupported: true, calls: [] };
  const sw = navigator.serviceWorker;
  const originalRegister = sw.register;
  const originalSetTimeout = window.setTimeout;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const calls = [];
  const timerCalls = [];
  const fakeRegister = function (scriptUrl) {
    calls.push(scriptUrl);
    return new Promise(() => {});
  };
  let patched = false;
  try {
    sw.register = fakeRegister;
    patched = sw.register === fakeRegister;
  } catch {}
  if (!patched) {
    try {
      Object.defineProperty(sw, 'register', { configurable: true, value: fakeRegister });
      patched = sw.register === fakeRegister;
    } catch {}
  }
  if (!patched) return { patched, calls, timerCalls };
  try {
    window.setTimeout = function (_fn, ms) {
      timerCalls.push(ms);
      throw new Error('timer unavailable');
    };
    window.SimpleCAD.pwaAPI.register({ timeoutMs: 80 });
    await new Promise(resolve => originalRequestAnimationFrame.call(window, () => {
      originalSetTimeout.call(window, resolve, 0);
    }));
    await new Promise(resolve => originalSetTimeout.call(window, resolve, 20));
  } finally {
    window.setTimeout = originalSetTimeout;
    try { sw.register = originalRegister; } catch {}
    if (sw.register !== originalRegister) {
      try { Object.defineProperty(sw, 'register', { configurable: true, value: originalRegister }); } catch {}
    }
  }
  return { patched, calls, timerCalls };
});
check('PWA登録APIは監視タイマーを予約できない時に登録を開始しない',
  registerTimerScheduleFailure.patched === true &&
  registerTimerScheduleFailure.calls.length === 0 &&
  registerTimerScheduleFailure.timerCalls.includes(80),
  JSON.stringify(registerTimerScheduleFailure));

const registerFrameFallback = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator) || !window.SimpleCAD) return { patched: false, unsupported: true, calls: [] };
  const sw = navigator.serviceWorker;
  const originalRegister = sw.register;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalSetTimeout = window.setTimeout;
  const calls = [];
  const fakeReg = {
    addEventListener() {},
    update() {
      calls.push('update');
      return Promise.resolve();
    },
  };
  const fakeRegister = function (scriptUrl) {
    calls.push(scriptUrl);
    return Promise.resolve(fakeReg);
  };
  let patched = false;
  try {
    sw.register = fakeRegister;
    patched = sw.register === fakeRegister;
  } catch {}
  if (!patched) {
    try {
      Object.defineProperty(sw, 'register', { configurable: true, value: fakeRegister });
      patched = sw.register === fakeRegister;
    } catch {}
  }
  if (!patched) return { patched, calls };
  let frameCalls = 0;
  let callsBeforeFallback = [];
  try {
    window.requestAnimationFrame = function () {
      frameCalls++;
      return 123;
    };
    window.SimpleCAD.pwaAPI.register({ timeoutMs: 80, frameFallbackMs: 20 });
    await new Promise(resolve => originalSetTimeout.call(window, resolve, 5));
    callsBeforeFallback = calls.slice();
    await new Promise(resolve => originalSetTimeout.call(window, resolve, 60));
  } finally {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    try { sw.register = originalRegister; } catch {}
    if (sw.register !== originalRegister) {
      try { Object.defineProperty(sw, 'register', { configurable: true, value: originalRegister }); } catch {}
    }
  }
  return { patched, frameCalls, callsBeforeFallback, calls };
});
check('PWA登録APIはRAFが呼び返さなくてもフォールバックで登録する',
  registerFrameFallback.patched === true &&
  registerFrameFallback.frameCalls >= 1 &&
  registerFrameFallback.callsBeforeFallback.length === 0 &&
  registerFrameFallback.calls.filter(x => x === 'sw.js').length === 1 &&
  registerFrameFallback.calls.filter(x => x === 'update').length === 1,
  JSON.stringify(registerFrameFallback));

const registerLoadFallback = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator) || !window.SimpleCAD) return { patched: false, unsupported: true, calls: [] };
  const sw = navigator.serviceWorker;
  const originalRegister = sw.register;
  const originalAddEventListener = window.addEventListener;
  const originalWindowAddEventListener = Object.getOwnPropertyDescriptor(window, 'addEventListener');
  const originalSetTimeout = window.setTimeout;
  const originalOwnReady = Object.getOwnPropertyDescriptor(document, 'readyState');
  const documentProto = Object.getPrototypeOf(document);
  const originalProtoReady = Object.getOwnPropertyDescriptor(documentProto, 'readyState');
  const calls = [];
  const fakeReg = {
    addEventListener() {},
    update() {
      calls.push('update');
      return Promise.resolve();
    },
  };
  const fakeRegister = function (scriptUrl) {
    calls.push(scriptUrl);
    return Promise.resolve(fakeReg);
  };
  let registerPatched = false;
  try {
    sw.register = fakeRegister;
    registerPatched = sw.register === fakeRegister;
  } catch {}
  if (!registerPatched) {
    try {
      Object.defineProperty(sw, 'register', { configurable: true, value: fakeRegister });
      registerPatched = sw.register === fakeRegister;
    } catch {}
  }
  let readyPatched = false;
  let readyPatchTarget = null;
  try {
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
    readyPatched = document.readyState === 'loading';
    readyPatchTarget = 'document';
  } catch {}
  if (!readyPatched && originalProtoReady && originalProtoReady.configurable) {
    try {
      Object.defineProperty(documentProto, 'readyState', { configurable: true, get: () => 'loading' });
      readyPatched = document.readyState === 'loading';
      readyPatchTarget = 'prototype';
    } catch {}
  }
  let loadListenerCalls = 0;
  const fakeAddEventListener = function (type, listener, options) {
    if (type === 'load') {
      loadListenerCalls++;
      return undefined;
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
  let addPatched = false;
  try {
    window.addEventListener = fakeAddEventListener;
    addPatched = window.addEventListener === fakeAddEventListener;
  } catch {}
  if (!addPatched) {
    try {
      Object.defineProperty(window, 'addEventListener', { configurable: true, value: fakeAddEventListener });
      addPatched = window.addEventListener === fakeAddEventListener;
    } catch {}
  }
  const restore = () => {
    try { sw.register = originalRegister; } catch {}
    if (sw.register !== originalRegister) {
      try { Object.defineProperty(sw, 'register', { configurable: true, value: originalRegister }); } catch {}
    }
    try {
      if (originalWindowAddEventListener) Object.defineProperty(window, 'addEventListener', originalWindowAddEventListener);
      else delete window.addEventListener;
    } catch {
      try { window.addEventListener = originalAddEventListener; } catch {}
    }
    if (readyPatchTarget === 'document') {
      try {
        if (originalOwnReady) Object.defineProperty(document, 'readyState', originalOwnReady);
        else delete document.readyState;
      } catch {}
    } else if (readyPatchTarget === 'prototype' && originalProtoReady) {
      try { Object.defineProperty(documentProto, 'readyState', originalProtoReady); } catch {}
    }
  };
  if (!registerPatched || !readyPatched || !addPatched) {
    restore();
    return { patched: false, registerPatched, readyPatched, addPatched, calls };
  }
  let callsBeforeFallback = [];
  try {
    window.SimpleCAD.pwaAPI.register({ timeoutMs: 100, frameFallbackMs: 20, loadFallbackMs: 20 });
    await new Promise(resolve => originalSetTimeout.call(window, resolve, 5));
    callsBeforeFallback = calls.slice();
    await new Promise(resolve => originalSetTimeout.call(window, resolve, 80));
  } finally {
    restore();
  }
  return { patched: true, loadListenerCalls, callsBeforeFallback, calls };
});
check('PWA登録APIはloadリスナーが呼び返さなくてもフォールバックで登録する',
  registerLoadFallback.patched === true &&
  registerLoadFallback.loadListenerCalls === 1 &&
  registerLoadFallback.callsBeforeFallback.length === 0 &&
  registerLoadFallback.calls.filter(x => x === 'sw.js').length === 1 &&
  registerLoadFallback.calls.filter(x => x === 'update').length === 1,
  JSON.stringify(registerLoadFallback));

const preCachedAssets = await page.evaluate(async () => {
  const assets = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
  const result = {};
  for (const asset of assets) {
    const response = await caches.match(asset);
    result[asset] = !!(response && response.ok);
  }
  return result;
});
check('Service WorkerはアプリシェルとPWAアイコンをプリキャッシュする',
  Object.values(preCachedAssets).every(Boolean),
  JSON.stringify(preCachedAssets));

const missingResource = await page.evaluate(async () => {
  const path = 'missing-sw-test-' + Date.now() + '.txt';
  const r = await fetch(path);
  const cached = await caches.match(path);
  return { status: r.status, ok: r.ok, cached: !!cached };
});
check('Service Workerは404レスポンスをキャッシュしない',
  missingResource.status === 404 && missingResource.ok === false && missingResource.cached === false,
  JSON.stringify(missingResource));
const dynamicResource = await page.evaluate(async () => {
  const path = 'dynamic-cache-probe.json?ts=' + Date.now();
  const r = await fetch(path);
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service Workerはクエリ付き動的JSONをキャッシュしない',
  dynamicResource.ok === true && dynamicResource.cached === false && dynamicResource.data.kind === 'dynamic',
  JSON.stringify(dynamicResource));
const requestNoStore = await page.evaluate(async () => {
  const path = 'request-no-store-probe.json?ts=' + Date.now();
  const r = await fetch(path, { cache: 'no-store' });
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service Workerはcache:no-storeリクエストをキャッシュしない',
  requestNoStore.ok === true && requestNoStore.cached === false && requestNoStore.data.kind === 'request-no-store',
  JSON.stringify(requestNoStore));
const requestNoCache = await page.evaluate(async () => {
  const path = 'request-no-cache-probe.json?ts=' + Date.now();
  const r = await fetch(path, { cache: 'no-cache' });
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service Workerはcache:no-cacheリクエストをキャッシュしない',
  requestNoCache.ok === true && requestNoCache.cached === false && requestNoCache.data.kind === 'request-no-cache',
  JSON.stringify(requestNoCache));
const authorizedRequest = await page.evaluate(async () => {
  const path = 'authorized-probe.json?ts=' + Date.now();
  const r = await fetch(path, { headers: { Authorization: 'Bearer simplecad-test' } });
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service WorkerはAuthorization付きリクエストをキャッシュしない',
  authorizedRequest.ok === true &&
  authorizedRequest.cached === false &&
  authorizedRequest.data.kind === 'authorized' &&
  authorizedRequest.data.authorization === 'Bearer simplecad-test',
  JSON.stringify(authorizedRequest));
const responseNoStore = await page.evaluate(async () => {
  const path = 'response-no-store-probe.json?ts=' + Date.now();
  const r = await fetch(path);
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service WorkerはCache-Control:no-storeレスポンスをキャッシュしない',
  responseNoStore.ok === true && responseNoStore.cached === false && responseNoStore.data.kind === 'response-no-store',
  JSON.stringify(responseNoStore));
const responseNoCache = await page.evaluate(async () => {
  const path = 'response-no-cache-probe.json?ts=' + Date.now();
  const r = await fetch(path);
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service WorkerはCache-Control:no-cacheレスポンスをキャッシュしない',
  responseNoCache.ok === true && responseNoCache.cached === false && responseNoCache.data.kind === 'response-no-cache',
  JSON.stringify(responseNoCache));
const responsePragmaNoCache = await page.evaluate(async () => {
  const path = 'response-pragma-no-cache-probe.json?ts=' + Date.now();
  const r = await fetch(path);
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service WorkerはPragma:no-cacheレスポンスをキャッシュしない',
  responsePragmaNoCache.ok === true &&
  responsePragmaNoCache.cached === false &&
  responsePragmaNoCache.data.kind === 'response-pragma-no-cache',
  JSON.stringify(responsePragmaNoCache));
const responseExpired = await page.evaluate(async () => {
  const path = 'response-expired-probe.json?ts=' + Date.now();
  const r = await fetch(path);
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service Workerは期限切れExpiresレスポンスをキャッシュしない',
  responseExpired.ok === true && responseExpired.cached === false && responseExpired.data.kind === 'response-expired',
  JSON.stringify(responseExpired));
const responseVaryAuthorization = await page.evaluate(async () => {
  const path = 'response-vary-authorization-probe.json?ts=' + Date.now();
  const r = await fetch(path);
  const data = r.ok ? await r.json() : { status: r.status };
  const cached = await caches.match(path);
  return { ok: r.ok, cached: !!cached, data };
});
check('Service WorkerはVary:Authorizationレスポンスをキャッシュしない',
  responseVaryAuthorization.ok === true &&
  responseVaryAuthorization.cached === false &&
  responseVaryAuthorization.data.kind === 'response-vary-authorization',
  JSON.stringify(responseVaryAuthorization));

// 何か作図して状態を作る(キャッシュ確立のため少し待つ)
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.addShape({ id: 'p1', type: 'rect', x: 0, y: 0, w: 30, h: 20, stroke: '#fff', strokeWidth: 2, fill: null }); });
await page.waitForTimeout(400); // SWキャッシュ書き込み待ち

// オフラインにして再読込 → アプリが復元(SWキャッシュ配信)
await ctx.setOffline(true);
let offlineOk = true, offErr = '';
try {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SimpleCAD, null, { timeout: 5000 });
} catch (e) { offlineOk = false; offErr = e.message; }
check('オフラインでもアプリが読み込める(SWキャッシュ)', offlineOk, offErr);
const title = await page.title();
check('オフライン再読込でタイトルが正しい', /SimpleCAD/.test(title), title);
const offlineMissing = await page.evaluate(async () => {
  try {
    const r = await fetch('missing-sw-offline-' + Date.now() + '.txt');
    const text = await r.text();
    return { resolved: true, status: r.status, simplecadHtml: /SimpleCAD/.test(text) };
  } catch (e) {
    return { resolved: false, message: e && e.message ? e.message : String(e) };
  }
});
check('オフライン時の通常リソース失敗はアプリHTMLへフォールバックしない',
  offlineMissing.resolved === false || (offlineMissing.status >= 400 && offlineMissing.simplecadHtml === false),
  JSON.stringify(offlineMissing));
const offlineIcon = await page.evaluate(async () => {
  try {
    const r = await fetch('icon-192.png');
    const blob = await r.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      ok: r.ok,
      type: blob.type,
      size: blob.size,
      sig: [...bytes.slice(0, 8)].map(v => v.toString(16).padStart(2, '0')).join(''),
    };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});
check('オフラインでもPWA PNGアイコンをキャッシュから取得できる',
  offlineIcon.ok === true && offlineIcon.type === 'image/png' && offlineIcon.size > 0 && offlineIcon.sig === '89504e470d0a1a0a',
  JSON.stringify(offlineIcon));
await page.evaluate(async () => {
  const keys = await caches.keys();
  for (const key of keys.filter(k => /^simplecad-v\d+$/.test(k))) {
    const cache = await caches.open(key);
    await Promise.all([
      './',
      './index.html',
      'index.html',
      location.origin + '/',
      location.origin + '/index.html',
    ].map(asset => cache.delete(asset).catch(() => false)));
  }
});
let evictedShellFallback = {};
try {
  const resp = await page.goto(base + 'offline-shell-evicted-' + Date.now(), { waitUntil: 'domcontentloaded' });
  evictedShellFallback = {
    loaded: true,
    status: resp ? resp.status() : 0,
    title: await page.title(),
    body: await page.textContent('body').catch(() => ''),
  };
} catch (e) {
  evictedShellFallback = { loaded: false, message: e && e.message ? e.message : String(e) };
}
check('オフライン時にアプリシェルが欠落しても制御された案内ページを返す',
  evictedShellFallback.loaded === true &&
  evictedShellFallback.status === 503 &&
  /SimpleCAD/.test(evictedShellFallback.title) &&
  /オフライン/.test(evictedShellFallback.body || ''),
  JSON.stringify(evictedShellFallback));
await ctx.setOffline(false);

check('PWA関連でコンソールエラーなし', errs.length === 0, errs.join(' | '));

await browser.close();
server.close();
console.log(`\nPWA検証: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
