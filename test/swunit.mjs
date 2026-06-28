// Service Worker unit checks for failure paths that are hard to force in Chromium.
import vm from 'vm';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'sw.js'), 'utf8');
const currentCacheName = source.match(/const CACHE = '([^']+)'/)?.[1];
if (!currentCacheName) {
  throw new Error('Service WorkerのCACHE定数を抽出できませんでした');
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''));
  }
};

function createHarness({ cachesImpl, fetchImpl, claimImpl, skipWaitingImpl }) {
  const listeners = new Map();
  const state = { skipWaitingCalls: 0, claimCalls: 0 };
  const context = {
    self: {
      location: { origin: 'https://simplecad.test' },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      skipWaiting() {
        state.skipWaitingCalls++;
        return typeof skipWaitingImpl === 'function' ? skipWaitingImpl() : Promise.resolve();
      },
      clients: {
        claim() {
          state.claimCalls++;
          return typeof claimImpl === 'function' ? claimImpl() : Promise.resolve();
        },
      },
    },
    caches: cachesImpl,
    fetch: fetchImpl,
    Response,
    Request,
    URL,
    Promise,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });
  return { listeners, state, context };
}

async function dispatchInstall(harness) {
  const handler = harness.listeners.get('install');
  if (typeof handler !== 'function') return { waited: false };
  let waitPromise = null;
  handler({
    waitUntil(promiseLike) {
      waitPromise = Promise.resolve(promiseLike);
    },
  });
  if (waitPromise) await waitPromise;
  return { waited: !!waitPromise, skipWaitingCalls: harness.state.skipWaitingCalls };
}

async function dispatchActivate(harness) {
  const handler = harness.listeners.get('activate');
  if (typeof handler !== 'function') return { waited: false };
  let waitPromise = null;
  handler({
    waitUntil(promiseLike) {
      waitPromise = Promise.resolve(promiseLike);
    },
  });
  if (waitPromise) await waitPromise;
  return { waited: !!waitPromise, claimCalls: harness.state.claimCalls };
}

async function dispatchFetch(harness, request) {
  const handler = harness.listeners.get('fetch');
  if (typeof handler !== 'function') return { responded: false, response: null };
  let responsePromise = null;
  handler({
    request,
    respondWith(promiseLike) {
      responsePromise = Promise.resolve(promiseLike);
    },
  });
  return {
    responded: !!responsePromise,
    response: responsePromise ? await responsePromise : null,
  };
}

const installPartialPrecacheFailure = await (async () => {
  const attempted = [];
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({
          add(asset) {
            attempted.push(asset);
            if (asset === './icon-512.png') return Promise.reject(new Error('asset unavailable'));
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const result = await dispatchInstall(harness);
  return { ...result, attempted };
})();
check('Service Workerはプリキャッシュの一部失敗でもインストールを完了する',
  installPartialPrecacheFailure.waited === true &&
  installPartialPrecacheFailure.skipWaitingCalls === 1 &&
  installPartialPrecacheFailure.attempted.includes('./index.html') &&
  installPartialPrecacheFailure.attempted.includes('./simplecad.ico') &&
  installPartialPrecacheFailure.attempted.includes('./icon-512.png'),
  JSON.stringify(installPartialPrecacheFailure));

const installSyncPrecacheFailure = await (async () => {
  const attempted = [];
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({
          add(asset) {
            attempted.push(asset);
            if (asset === './icon-192.png') throw new Error('asset add crashed');
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const result = await dispatchInstall(harness);
  return { ...result, attempted };
})();
check('Service Workerはプリキャッシュの同期例外でも残りアセットを試行してインストールを完了する',
  installSyncPrecacheFailure.waited === true &&
  installSyncPrecacheFailure.skipWaitingCalls === 1 &&
  installSyncPrecacheFailure.attempted.includes('./icon-192.png') &&
  installSyncPrecacheFailure.attempted.includes('./simplecad.ico') &&
  installSyncPrecacheFailure.attempted.includes('./icon-512.png') &&
  installSyncPrecacheFailure.attempted.indexOf('./icon-192.png') < installSyncPrecacheFailure.attempted.indexOf('./icon-512.png'),
  JSON.stringify(installSyncPrecacheFailure));

const installBrokenAssetMap = await (async () => {
  const attempted = [];
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({
          add(asset) {
            attempted.push(asset);
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  vm.runInContext("Array.prototype.map = function(){ throw new Error('map crashed'); };", harness.context);
  const result = await dispatchInstall(harness);
  return { ...result, attempted };
})();
check('Service Workerはプリキャッシュ配列メソッドが壊れても全アセットを試行する',
  installBrokenAssetMap.waited === true &&
  installBrokenAssetMap.skipWaitingCalls === 1 &&
  installBrokenAssetMap.attempted.includes('./index.html') &&
  installBrokenAssetMap.attempted.includes('./simplecad.ico') &&
  installBrokenAssetMap.attempted.includes('./icon-512.png') &&
  installBrokenAssetMap.attempted.length >= 8,
  JSON.stringify(installBrokenAssetMap));

const installBrokenPromiseAll = await (async () => {
  const attempted = [];
  const originalPromiseAll = Promise.all;
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({
          add(asset) {
            attempted.push(asset);
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  try {
    vm.runInContext("Promise.all = function(){ throw new Error('Promise.all crashed'); };", harness.context);
    const result = await dispatchInstall(harness);
    return { ...result, attempted };
  } finally {
    Promise.all = originalPromiseAll;
  }
})();
check('Service WorkerはプリキャッシュでPromise.allが壊れても全アセットを待って導入する',
  installBrokenPromiseAll.waited === true &&
  installBrokenPromiseAll.skipWaitingCalls === 1 &&
  installBrokenPromiseAll.attempted.includes('./index.html') &&
  installBrokenPromiseAll.attempted.includes('./simplecad.ico') &&
  installBrokenPromiseAll.attempted.includes('./icon-512.png') &&
  installBrokenPromiseAll.attempted.length >= 8,
  JSON.stringify(installBrokenPromiseAll));

const installWaitUntilSyncFailure = await (async () => {
  let handlerError = '';
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({
          add() {
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const handler = harness.listeners.get('install');
  try {
    handler({
      waitUntil() {
        throw new Error('waitUntil crashed');
      },
    });
  } catch (err) {
    handlerError = err && err.message ? err.message : String(err);
  }
  return { handlerError };
})();
check('Service Workerはinstall waitUntil同期例外をハンドラ外へ漏らさない',
  installWaitUntilSyncFailure.handlerError === '',
  JSON.stringify(installWaitUntilSyncFailure));

const installCacheStorageFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.reject(new Error('cache storage unavailable'));
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  return dispatchInstall(harness);
})();
check('Service Workerはインストール時にCache Storageが使えなくても導入を完了する',
  installCacheStorageFailure.waited === true &&
  installCacheStorageFailure.skipWaitingCalls === 1,
  JSON.stringify(installCacheStorageFailure));

const installCacheStorageSyncFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      open() {
        throw new Error('cache storage crashed');
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  return dispatchInstall(harness);
})();
check('Service Workerはインストール時のCache Storage同期例外でも導入を完了する',
  installCacheStorageSyncFailure.waited === true &&
  installCacheStorageSyncFailure.skipWaitingCalls === 1,
  JSON.stringify(installCacheStorageSyncFailure));

const installSkipWaitingFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({ add: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
    skipWaitingImpl() {
      return Promise.reject(new Error('skip waiting failed'));
    },
  });
  return dispatchInstall(harness);
})();
check('Service WorkerはskipWaiting失敗でもインストールを完了する',
  installSkipWaitingFailure.waited === true &&
  installSkipWaitingFailure.skipWaitingCalls === 1,
  JSON.stringify(installSkipWaitingFailure));

const installSkipWaitingSyncFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      open() {
        return Promise.resolve({ add: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
    skipWaitingImpl() {
      throw new Error('skip waiting crashed');
    },
  });
  return dispatchInstall(harness);
})();
check('Service WorkerはskipWaiting同期例外でもインストールを完了する',
  installSkipWaitingSyncFailure.waited === true &&
  installSkipWaitingSyncFailure.skipWaitingCalls === 1,
  JSON.stringify(installSkipWaitingSyncFailure));

const activateDeleteFailure = await (async () => {
  const deleted = [];
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve(['simplecad-v1', currentCacheName, 'foreign-cache']);
      },
      delete(key) {
        deleted.push(key);
        return Promise.reject(new Error('delete failed'));
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const result = await dispatchActivate(harness);
  return { ...result, deleted };
})();
check('Service Workerは旧キャッシュ削除に失敗しても有効化を完了する',
  activateDeleteFailure.waited === true &&
  activateDeleteFailure.claimCalls === 1 &&
  activateDeleteFailure.deleted.length === 1 &&
  activateDeleteFailure.deleted[0] === 'simplecad-v1' &&
  !activateDeleteFailure.deleted.includes(currentCacheName) &&
  !activateDeleteFailure.deleted.includes('foreign-cache'),
  JSON.stringify(activateDeleteFailure));

const activateDeleteSyncFailure = await (async () => {
  const deleted = [];
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve(['simplecad-v1', 'simplecad-v2', currentCacheName, 'foreign-cache']);
      },
      delete(key) {
        deleted.push(key);
        if (key === 'simplecad-v1') throw new Error('delete threw');
        return Promise.reject(new Error('delete failed'));
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const result = await dispatchActivate(harness);
  return { ...result, deleted };
})();
check('Service Workerは旧キャッシュ削除の同期例外でも残りの旧キャッシュ削除を試行する',
  activateDeleteSyncFailure.waited === true &&
  activateDeleteSyncFailure.claimCalls === 1 &&
  activateDeleteSyncFailure.deleted.length === 2 &&
  activateDeleteSyncFailure.deleted.includes('simplecad-v1') &&
  activateDeleteSyncFailure.deleted.includes('simplecad-v2') &&
  !activateDeleteSyncFailure.deleted.includes(currentCacheName) &&
  !activateDeleteSyncFailure.deleted.includes('foreign-cache'),
  JSON.stringify(activateDeleteSyncFailure));

const activateMalformedKeysIgnored = await (async () => {
  const deleted = [];
  const malformedKey = {};
  Object.defineProperty(malformedKey, 'startsWith', {
    get() {
      throw new Error('startsWith getter crashed');
    },
  });
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve([null, malformedKey, 'simplecad-v1', currentCacheName, 'foreign-cache']);
      },
      delete(key) {
        deleted.push(key);
        return Promise.resolve(true);
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const result = await dispatchActivate(harness);
  return { ...result, deleted };
})();
check('Service Workerは不正なキャッシュキーを無視し有効な旧キャッシュ削除を継続する',
  activateMalformedKeysIgnored.waited === true &&
  activateMalformedKeysIgnored.claimCalls === 1 &&
  activateMalformedKeysIgnored.deleted.length === 1 &&
  activateMalformedKeysIgnored.deleted[0] === 'simplecad-v1',
  JSON.stringify(activateMalformedKeysIgnored));

const activateBrokenKeysArrayMethods = await (async () => {
  const deleted = [];
  const keys = ['simplecad-v1', 'simplecad-v2', currentCacheName, 'foreign-cache'];
  keys.filter = () => {
    throw new Error('filter crashed');
  };
  keys.map = () => {
    throw new Error('map crashed');
  };
  Object.defineProperty(keys, 4, {
    get() {
      throw new Error('key getter crashed');
    },
  });
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve(keys);
      },
      delete(key) {
        deleted.push(key);
        return Promise.resolve(true);
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const result = await dispatchActivate(harness);
  return { ...result, deleted };
})();
check('Service Workerはキャッシュ一覧の配列メソッドが壊れても旧キャッシュ削除を継続する',
  activateBrokenKeysArrayMethods.waited === true &&
  activateBrokenKeysArrayMethods.claimCalls === 1 &&
  activateBrokenKeysArrayMethods.deleted.length === 2 &&
  activateBrokenKeysArrayMethods.deleted.includes('simplecad-v1') &&
  activateBrokenKeysArrayMethods.deleted.includes('simplecad-v2') &&
  !activateBrokenKeysArrayMethods.deleted.includes(currentCacheName) &&
  !activateBrokenKeysArrayMethods.deleted.includes('foreign-cache'),
  JSON.stringify(activateBrokenKeysArrayMethods));

const activateBrokenArrayPrototypeMap = await (async () => {
  const deleted = [];
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve(['simplecad-v1', 'simplecad-v2', currentCacheName, 'foreign-cache']);
      },
      delete(key) {
        deleted.push(key);
        return Promise.resolve(true);
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  vm.runInContext("Array.prototype.map = function(){ throw new Error('prototype map crashed'); };", harness.context);
  const result = await dispatchActivate(harness);
  return { ...result, deleted };
})();
check('Service WorkerはArray.prototype.mapが壊れても旧キャッシュ削除を継続する',
  activateBrokenArrayPrototypeMap.waited === true &&
  activateBrokenArrayPrototypeMap.claimCalls === 1 &&
  activateBrokenArrayPrototypeMap.deleted.length === 2 &&
  activateBrokenArrayPrototypeMap.deleted.includes('simplecad-v1') &&
  activateBrokenArrayPrototypeMap.deleted.includes('simplecad-v2') &&
  !activateBrokenArrayPrototypeMap.deleted.includes(currentCacheName) &&
  !activateBrokenArrayPrototypeMap.deleted.includes('foreign-cache'),
  JSON.stringify(activateBrokenArrayPrototypeMap));

const activateWaitUntilSyncFailure = await (async () => {
  let handlerError = '';
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve(['simplecad-v1', currentCacheName]);
      },
      delete() {
        return Promise.resolve(true);
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  const handler = harness.listeners.get('activate');
  try {
    handler({
      waitUntil() {
        throw new Error('activate waitUntil crashed');
      },
    });
  } catch (err) {
    handlerError = err && err.message ? err.message : String(err);
  }
  return { handlerError };
})();
check('Service Workerはactivate waitUntil同期例外をハンドラ外へ漏らさない',
  activateWaitUntilSyncFailure.handlerError === '',
  JSON.stringify(activateWaitUntilSyncFailure));

const activateKeysFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.reject(new Error('keys failed'));
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  return dispatchActivate(harness);
})();
check('Service Workerはキャッシュ一覧取得に失敗しても有効化を完了する',
  activateKeysFailure.waited === true &&
  activateKeysFailure.claimCalls === 1,
  JSON.stringify(activateKeysFailure));

const activateKeysSyncFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      keys() {
        throw new Error('keys crashed');
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  return dispatchActivate(harness);
})();
check('Service Workerはキャッシュ一覧取得の同期例外でも有効化を完了する',
  activateKeysSyncFailure.waited === true &&
  activateKeysSyncFailure.claimCalls === 1,
  JSON.stringify(activateKeysSyncFailure));

const activateClaimFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve([]);
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
    claimImpl() {
      return Promise.reject(new Error('claim failed'));
    },
  });
  return dispatchActivate(harness);
})();
check('Service Workerはclients.claim失敗でも有効化Promiseを完了する',
  activateClaimFailure.waited === true &&
  activateClaimFailure.claimCalls === 1,
  JSON.stringify(activateClaimFailure));

const activateClaimSyncFailure = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      keys() {
        return Promise.resolve([]);
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('unexpected fetch'));
    },
    claimImpl() {
      throw new Error('claim crashed');
    },
  });
  return dispatchActivate(harness);
})();
check('Service Workerはclients.claim同期例外でも有効化Promiseを完了する',
  activateClaimSyncFailure.waited === true &&
  activateClaimSyncFailure.claimCalls === 1,
  JSON.stringify(activateClaimSyncFailure));

const malformedFetchRequestIgnored = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(null);
      },
      open() {
        return Promise.resolve({ put: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('unexpected'));
    },
  });
  const handler = harness.listeners.get('fetch');
  function invoke(request) {
    let handlerError = '';
    let responded = false;
    try {
      handler({
        request,
        respondWith(promiseLike) {
          responded = true;
          Promise.resolve(promiseLike).catch(() => {});
        },
      });
    } catch (err) {
      handlerError = err && err.message ? err.message : String(err);
    }
    return { handlerError, responded };
  }
  const brokenMethodRequest = {};
  Object.defineProperty(brokenMethodRequest, 'method', {
    get() {
      throw new Error('method crashed');
    },
  });
  const brokenUrlRequest = { method: 'GET' };
  Object.defineProperty(brokenUrlRequest, 'url', {
    get() {
      throw new Error('url crashed');
    },
  });
  const unsupportedUrlRequest = {
    method: 'GET',
    url: 'chrome-extension://invalid/probe',
    mode: 'same-origin',
    cache: 'default',
  };
  return {
    results: [
      invoke(brokenMethodRequest),
      invoke(brokenUrlRequest),
      invoke(unsupportedUrlRequest),
    ],
    fetchCalls,
    matchCalls,
  };
})();
check('Service Workerは壊れた/未対応fetch requestを無視してハンドラ例外を漏らさない',
    malformedFetchRequestIgnored.results.every(r => r.handlerError === '' && r.responded === false) &&
    malformedFetchRequestIgnored.fetchCalls === 0 &&
    malformedFetchRequestIgnored.matchCalls === 0,
    JSON.stringify(malformedFetchRequestIgnored));

const fetchRespondWithSyncFailure = await (async () => {
  let fetchCalls = 0;
  let handlerError = '';
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        return Promise.resolve({
          put() {
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('network-ok', { status: 200 }));
    },
  });
  const handler = harness.listeners.get('fetch');
  try {
    handler({
      request: {
        method: 'GET',
        url: 'https://simplecad.test/icon-192.png',
        mode: 'same-origin',
        cache: 'default',
      },
      respondWith() {
        throw new Error('respondWith crashed');
      },
    });
  } catch (err) {
    handlerError = err && err.message ? err.message : String(err);
  }
  return { handlerError, fetchCalls };
})();
check('Service Workerはfetch respondWith同期例外をハンドラ外へ漏らさない',
  fetchRespondWithSyncFailure.handlerError === '' &&
  fetchRespondWithSyncFailure.fetchCalls === 0,
  JSON.stringify(fetchRespondWithSyncFailure));

const cacheMatchFailureFallback = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.reject(new Error('cache match failed'));
      },
      open() {
        return Promise.resolve({ put: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('network-ok', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    matchCalls,
  };
})();
check('Service Workerは通常リソースのキャッシュ参照失敗時にネットワークへフォールバックする',
  cacheMatchFailureFallback.responded === true &&
  cacheMatchFailureFallback.status === 200 &&
  cacheMatchFailureFallback.text === 'network-ok' &&
  cacheMatchFailureFallback.fetchCalls === 1 &&
  cacheMatchFailureFallback.matchCalls === 1,
  JSON.stringify(cacheMatchFailureFallback));

const cacheMatchSyncFailureFallback = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        throw new Error('cache match crashed');
      },
      open() {
        return Promise.resolve({ put: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('network-ok', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    matchCalls,
  };
})();
check('Service Workerは通常リソースのキャッシュ参照同期例外時にネットワークへフォールバックする',
  cacheMatchSyncFailureFallback.responded === true &&
  cacheMatchSyncFailureFallback.status === 200 &&
  cacheMatchSyncFailureFallback.text === 'network-ok' &&
  cacheMatchSyncFailureFallback.fetchCalls === 1 &&
  cacheMatchSyncFailureFallback.matchCalls === 1,
  JSON.stringify(cacheMatchSyncFailureFallback));

const cacheHeaderFailureKeepsNetworkResponse = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({ put: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get() {
            throw new Error('headers unavailable');
          },
        },
        clone() {
          throw new Error('clone should not run');
        },
        text() {
          return Promise.resolve('network-ok');
        },
      });
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
  };
})();
check('Service Workerはキャッシュ判定用ヘッダー参照が壊れても成功レスポンスを返す',
  cacheHeaderFailureKeepsNetworkResponse.responded === true &&
  cacheHeaderFailureKeepsNetworkResponse.status === 200 &&
  cacheHeaderFailureKeepsNetworkResponse.text === 'network-ok' &&
  cacheHeaderFailureKeepsNetworkResponse.fetchCalls === 1 &&
  cacheHeaderFailureKeepsNetworkResponse.openCalls === 0,
  JSON.stringify(cacheHeaderFailureKeepsNetworkResponse));

const cacheCloneFailureKeepsNetworkResponse = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({ put: () => Promise.resolve() });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get() {
            return '';
          },
        },
        clone() {
          throw new Error('clone unavailable');
        },
        text() {
          return Promise.resolve('network-ok');
        },
      });
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
  };
})();
check('Service Workerはキャッシュ保存用cloneが壊れても成功レスポンスを返す',
  cacheCloneFailureKeepsNetworkResponse.responded === true &&
  cacheCloneFailureKeepsNetworkResponse.status === 200 &&
  cacheCloneFailureKeepsNetworkResponse.text === 'network-ok' &&
  cacheCloneFailureKeepsNetworkResponse.fetchCalls === 1 &&
  cacheCloneFailureKeepsNetworkResponse.openCalls === 0,
  JSON.stringify(cacheCloneFailureKeepsNetworkResponse));

const knownAppAssetResponseIsCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  let putUrl = '';
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put(req) {
            putCalls++;
            putUrl = req && req.url ? req.url : '';
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('known-app-asset', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  await Promise.resolve();
  await Promise.resolve();
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
    putUrl,
  };
})();
check('Service Workerは既知のアプリ静的資産だけをruntime cacheへ保存する',
  knownAppAssetResponseIsCached.responded === true &&
  knownAppAssetResponseIsCached.status === 200 &&
  knownAppAssetResponseIsCached.text === 'known-app-asset' &&
  knownAppAssetResponseIsCached.fetchCalls === 1 &&
  knownAppAssetResponseIsCached.openCalls === 1 &&
  knownAppAssetResponseIsCached.putCalls === 1 &&
  knownAppAssetResponseIsCached.putUrl === 'https://simplecad.test/icon-192.png',
  JSON.stringify(knownAppAssetResponseIsCached));

const dynamicSameOriginResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(new Response('should-not-use-cache'));
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('dynamic-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/api/dynamic-cache-probe.json?ts=1',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  await Promise.resolve();
  await Promise.resolve();
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    matchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service Workerは未知の動的URLをキャッシュ参照せず保存もしない',
  dynamicSameOriginResponseIsNotCached.responded === true &&
  dynamicSameOriginResponseIsNotCached.status === 200 &&
  dynamicSameOriginResponseIsNotCached.text === 'dynamic-json' &&
  dynamicSameOriginResponseIsNotCached.fetchCalls === 1 &&
  dynamicSameOriginResponseIsNotCached.matchCalls === 0 &&
  dynamicSameOriginResponseIsNotCached.openCalls === 0 &&
  dynamicSameOriginResponseIsNotCached.putCalls === 0,
  JSON.stringify(dynamicSameOriginResponseIsNotCached));

const noCacheResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('fresh-no-cache', {
        status: 200,
        headers: { 'Cache-Control': 'no-cache, max-age=0' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service WorkerはCache-Control:no-cacheレスポンスをキャッシュしない',
  noCacheResponseIsNotCached.responded === true &&
  noCacheResponseIsNotCached.status === 200 &&
  noCacheResponseIsNotCached.text === 'fresh-no-cache' &&
  noCacheResponseIsNotCached.fetchCalls === 1 &&
  noCacheResponseIsNotCached.openCalls === 0 &&
  noCacheResponseIsNotCached.putCalls === 0,
  JSON.stringify(noCacheResponseIsNotCached));

const pragmaNoCacheResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('fresh-pragma-no-cache', {
        status: 200,
        headers: { 'Pragma': 'no-cache' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service WorkerはPragma:no-cacheレスポンスをキャッシュしない',
  pragmaNoCacheResponseIsNotCached.responded === true &&
  pragmaNoCacheResponseIsNotCached.status === 200 &&
  pragmaNoCacheResponseIsNotCached.text === 'fresh-pragma-no-cache' &&
  pragmaNoCacheResponseIsNotCached.fetchCalls === 1 &&
  pragmaNoCacheResponseIsNotCached.openCalls === 0 &&
  pragmaNoCacheResponseIsNotCached.putCalls === 0,
  JSON.stringify(pragmaNoCacheResponseIsNotCached));

const expiredResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('fresh-expired', {
        status: 200,
        headers: { 'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service Workerは期限切れExpiresレスポンスをキャッシュしない',
  expiredResponseIsNotCached.responded === true &&
  expiredResponseIsNotCached.status === 200 &&
  expiredResponseIsNotCached.text === 'fresh-expired' &&
  expiredResponseIsNotCached.fetchCalls === 1 &&
  expiredResponseIsNotCached.openCalls === 0 &&
  expiredResponseIsNotCached.putCalls === 0,
  JSON.stringify(expiredResponseIsNotCached));

const varyAuthorizationResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('fresh-vary-authorization', {
        status: 200,
        headers: { 'Vary': 'Authorization' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service WorkerはVary:Authorizationレスポンスをキャッシュしない',
  varyAuthorizationResponseIsNotCached.responded === true &&
  varyAuthorizationResponseIsNotCached.status === 200 &&
  varyAuthorizationResponseIsNotCached.text === 'fresh-vary-authorization' &&
  varyAuthorizationResponseIsNotCached.fetchCalls === 1 &&
  varyAuthorizationResponseIsNotCached.openCalls === 0 &&
  varyAuthorizationResponseIsNotCached.putCalls === 0,
  JSON.stringify(varyAuthorizationResponseIsNotCached));

const varyWildcardResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('fresh-vary-wildcard', {
        status: 200,
        headers: { 'Vary': '*' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service WorkerはVary:*レスポンスをキャッシュしない',
  varyWildcardResponseIsNotCached.responded === true &&
  varyWildcardResponseIsNotCached.status === 200 &&
  varyWildcardResponseIsNotCached.text === 'fresh-vary-wildcard' &&
  varyWildcardResponseIsNotCached.fetchCalls === 1 &&
  varyWildcardResponseIsNotCached.openCalls === 0 &&
  varyWildcardResponseIsNotCached.putCalls === 0,
  JSON.stringify(varyWildcardResponseIsNotCached));

const rangeResponseIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('partial-content', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-14/100' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'range' ? 'bytes=0-14' : '';
      },
    },
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service WorkerはRangeリクエストの部分レスポンスをキャッシュしない',
  rangeResponseIsNotCached.responded === true &&
  rangeResponseIsNotCached.status === 206 &&
  rangeResponseIsNotCached.text === 'partial-content' &&
  rangeResponseIsNotCached.fetchCalls === 1 &&
  rangeResponseIsNotCached.openCalls === 0 &&
  rangeResponseIsNotCached.putCalls === 0,
  JSON.stringify(rangeResponseIsNotCached));

const partialResponseWithoutRangeRequestIsNotCached = await (async () => {
  let fetchCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
      open() {
        openCalls++;
        return Promise.resolve({
          put() {
            putCalls++;
            return Promise.resolve();
          },
        });
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.resolve(new Response('server-partial-content', {
        status: 206,
        headers: { 'Content-Range': 'bytes 15-29/100' },
      }));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
    headers: {
      get() {
        return '';
      },
    },
  });
  const text = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    text,
    fetchCalls,
    openCalls,
    putCalls,
  };
})();
check('Service Workerは206部分レスポンスをRangeヘッダーなしでもキャッシュしない',
  partialResponseWithoutRangeRequestIsNotCached.responded === true &&
  partialResponseWithoutRangeRequestIsNotCached.status === 206 &&
  partialResponseWithoutRangeRequestIsNotCached.text === 'server-partial-content' &&
  partialResponseWithoutRangeRequestIsNotCached.fetchCalls === 1 &&
  partialResponseWithoutRangeRequestIsNotCached.openCalls === 0 &&
  partialResponseWithoutRangeRequestIsNotCached.putCalls === 0,
  JSON.stringify(partialResponseWithoutRangeRequestIsNotCached));

const crossOriginFetchSyncFailure = await (async () => {
  let fetchCalls = 0;
  let handlerError = '';
  let responsePromise = null;
  const harness = createHarness({
    fetchImpl() {
      fetchCalls++;
      throw new Error('cross-origin fetch crashed');
    },
  });
  const handler = harness.listeners.get('fetch');
  try {
    handler({
      request: {
        method: 'GET',
        url: 'https://cdn.example.test/cross-origin-probe.css',
        mode: 'cors',
        cache: 'default',
      },
      respondWith(promiseLike) {
        responsePromise = Promise.resolve(promiseLike);
      },
    });
  } catch (err) {
    handlerError = err && err.message ? err.message : String(err);
  }
  const response = responsePromise ? await responsePromise : null;
  const text = response ? await response.text() : 'missing';
  return {
    fetchCalls,
    handlerError,
    responded: !!responsePromise,
    status: response ? response.status : 0,
    cacheControl: response ? response.headers.get('Cache-Control') : '',
    text,
  };
})();
check('Service Workerはcross-origin fetchの同期例外時も504を返す',
  crossOriginFetchSyncFailure.responded === true &&
  crossOriginFetchSyncFailure.handlerError === '' &&
  crossOriginFetchSyncFailure.status === 504 &&
  crossOriginFetchSyncFailure.cacheControl === 'no-store' &&
  crossOriginFetchSyncFailure.text === '' &&
  crossOriginFetchSyncFailure.fetchCalls === 1,
  JSON.stringify(crossOriginFetchSyncFailure));

const crossOriginFetchRejectFailure = await (async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    fetchImpl() {
      fetchCalls++;
      return Promise.reject(new Error('cross-origin network unavailable'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://cdn.example.test/cross-origin-reject-probe.css',
    mode: 'cors',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : 'missing';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    text,
    fetchCalls,
  };
})();
check('Service Workerはcross-origin fetchのネットワーク失敗時も504を返す',
  crossOriginFetchRejectFailure.responded === true &&
  crossOriginFetchRejectFailure.status === 504 &&
  crossOriginFetchRejectFailure.cacheControl === 'no-store' &&
  crossOriginFetchRejectFailure.text === '' &&
  crossOriginFetchRejectFailure.fetchCalls === 1,
  JSON.stringify(crossOriginFetchRejectFailure));

const sameOriginFetchFailure = await (async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.reject(new Error('network unavailable'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/icon-192.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : 'missing';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    text,
    fetchCalls,
  };
})();
check('Service Workerは通常リソースのキャッシュミスとネットワーク失敗時に504を返す',
  sameOriginFetchFailure.responded === true &&
  sameOriginFetchFailure.status === 504 &&
  sameOriginFetchFailure.cacheControl === 'no-store' &&
  sameOriginFetchFailure.text === '' &&
  sameOriginFetchFailure.fetchCalls === 1,
  JSON.stringify(sameOriginFetchFailure));

const sameOriginFetchSyncFailure = await (async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.resolve(null);
      },
    },
    fetchImpl() {
      fetchCalls++;
      throw new Error('network crashed');
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/sync-network-failure.png',
    mode: 'same-origin',
    cache: 'default',
  });
  const text = result.response ? await result.response.text() : 'missing';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    text,
    fetchCalls,
  };
})();
check('Service Workerは通常リソースの同期ネットワーク失敗時に504を返す',
  sameOriginFetchSyncFailure.responded === true &&
  sameOriginFetchSyncFailure.status === 504 &&
  sameOriginFetchSyncFailure.cacheControl === 'no-store' &&
  sameOriginFetchSyncFailure.text === '' &&
  sameOriginFetchSyncFailure.fetchCalls === 1,
  JSON.stringify(sameOriginFetchSyncFailure));

const noStoreFetchFailure = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(new Response('should-not-use-cache'));
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.reject(new Error('network unavailable'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/request-no-store-probe.json',
    mode: 'same-origin',
    cache: 'no-store',
  });
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    fetchCalls,
    matchCalls,
  };
})();
check('Service Workerはcache:no-storeのネットワーク失敗時もキャッシュを使わず504を返す',
  noStoreFetchFailure.responded === true &&
  noStoreFetchFailure.status === 504 &&
  noStoreFetchFailure.cacheControl === 'no-store' &&
  noStoreFetchFailure.fetchCalls === 1 &&
  noStoreFetchFailure.matchCalls === 0,
  JSON.stringify(noStoreFetchFailure));

const noCacheFetchFailure = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(new Response('should-not-use-cache'));
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.reject(new Error('network unavailable'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/request-no-cache-probe.json',
    mode: 'same-origin',
    cache: 'no-cache',
  });
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    fetchCalls,
    matchCalls,
  };
})();
check('Service Workerはcache:no-cacheのネットワーク失敗時もキャッシュを使わず504を返す',
  noCacheFetchFailure.responded === true &&
  noCacheFetchFailure.status === 504 &&
  noCacheFetchFailure.cacheControl === 'no-store' &&
  noCacheFetchFailure.fetchCalls === 1 &&
  noCacheFetchFailure.matchCalls === 0,
  JSON.stringify(noCacheFetchFailure));

const pragmaNoCacheFetchFailure = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(new Response('should-not-use-cache'));
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.reject(new Error('network unavailable'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/request-pragma-no-cache-probe.json',
    mode: 'same-origin',
    cache: 'default',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'pragma' ? 'no-cache' : '';
      },
    },
  });
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    fetchCalls,
    matchCalls,
  };
})();
check('Service WorkerはPragma:no-cacheリクエストのネットワーク失敗時もキャッシュを使わず504を返す',
  pragmaNoCacheFetchFailure.responded === true &&
  pragmaNoCacheFetchFailure.status === 504 &&
  pragmaNoCacheFetchFailure.cacheControl === 'no-store' &&
  pragmaNoCacheFetchFailure.fetchCalls === 1 &&
  pragmaNoCacheFetchFailure.matchCalls === 0,
  JSON.stringify(pragmaNoCacheFetchFailure));

const authorizedFetchFailure = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(new Response('should-not-use-cache'));
      },
    },
    fetchImpl() {
      fetchCalls++;
      return Promise.reject(new Error('network unavailable'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/authorized-probe.json',
    mode: 'same-origin',
    cache: 'default',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'authorization' ? 'Bearer simplecad-test' : '';
      },
    },
  });
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    fetchCalls,
    matchCalls,
  };
})();
check('Service WorkerはAuthorization付きリクエストのネットワーク失敗時もキャッシュを使わず504を返す',
  authorizedFetchFailure.responded === true &&
  authorizedFetchFailure.status === 504 &&
  authorizedFetchFailure.cacheControl === 'no-store' &&
  authorizedFetchFailure.fetchCalls === 1 &&
  authorizedFetchFailure.matchCalls === 0,
  JSON.stringify(authorizedFetchFailure));

const noStoreFetchSyncFailure = await (async () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const harness = createHarness({
    cachesImpl: {
      match() {
        matchCalls++;
        return Promise.resolve(new Response('should-not-use-cache'));
      },
    },
    fetchImpl() {
      fetchCalls++;
      throw new Error('network crashed');
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/request-no-store-sync-probe.json',
    mode: 'same-origin',
    cache: 'no-store',
  });
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    fetchCalls,
    matchCalls,
  };
})();
check('Service Workerはcache:no-storeの同期ネットワーク失敗時もキャッシュを使わず504を返す',
  noStoreFetchSyncFailure.responded === true &&
  noStoreFetchSyncFailure.status === 504 &&
  noStoreFetchSyncFailure.cacheControl === 'no-store' &&
  noStoreFetchSyncFailure.fetchCalls === 1 &&
  noStoreFetchSyncFailure.matchCalls === 0,
  JSON.stringify(noStoreFetchSyncFailure));

const navigationFallbackWithBrokenCache = await (async () => {
  const harness = createHarness({
    cachesImpl: {
      match() {
        return Promise.reject(new Error('cache unavailable'));
      },
      open() {
        return Promise.reject(new Error('cache unavailable'));
      },
    },
    fetchImpl() {
      return Promise.reject(new Error('network offline'));
    },
  });
  const result = await dispatchFetch(harness, {
    method: 'GET',
    url: 'https://simplecad.test/',
    mode: 'navigate',
    cache: 'default',
  });
  const body = result.response ? await result.response.text() : '';
  return {
    responded: result.responded,
    status: result.response ? result.response.status : 0,
    cacheControl: result.response ? result.response.headers.get('Cache-Control') : '',
    hasOfflineText: /オフライン/.test(body),
  };
})();
check('Service Workerはナビゲーション時にネットワークとキャッシュが壊れてもオフライン案内を返す',
  navigationFallbackWithBrokenCache.responded === true &&
  navigationFallbackWithBrokenCache.status === 503 &&
  navigationFallbackWithBrokenCache.cacheControl === 'no-store' &&
  navigationFallbackWithBrokenCache.hasOfflineText === true,
  JSON.stringify(navigationFallbackWithBrokenCache));

console.log(`\nService Worker単体検証: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
