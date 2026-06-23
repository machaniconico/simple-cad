// SimpleCAD Service Worker — オフライン対応(cache-first)
const CACHE_PREFIX = 'simplecad-v';
const CACHE = 'simplecad-v251';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const APP_SHELL = './index.html';
const OFFLINE_FALLBACK_HTML = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SimpleCAD オフライン</title><body><h1>SimpleCAD オフライン</h1><p>アプリ本体のキャッシュが見つかりません。接続後に再読み込みしてください。</p></body></html>';

function headerValueSafely(target, key) {
  try {
    const headers = target && target.headers;
    const get = headers && headers.get;
    return typeof get === 'function' ? (get.call(headers, key) || '') : '';
  } catch (_) {
    return '';
  }
}

function cacheModeBypassesRuntimeCache(cacheMode) {
  return cacheMode === 'no-store' || cacheMode === 'reload' || cacheMode === 'no-cache';
}

function cacheControlDisallowsRuntimeCache(cacheControl) {
  return /\b(?:no-store|no-cache|private)\b/i.test(cacheControl) ||
    /\b(?:s-maxage|max-age)\s*=\s*0+\b/i.test(cacheControl);
}

function pragmaDisallowsRuntimeCache(pragma) {
  return /\bno-cache\b/i.test(pragma);
}

function expiredHeaderDisallowsRuntimeCache(expires) {
  try {
    if (!expires) return false;
    const timestamp = Date.parse(expires);
    return Number.isFinite(timestamp) && timestamp <= Date.now();
  } catch (_) {
    return false;
  }
}

function sensitiveRequestHeaderDisallowsRuntimeCache(req) {
  return !!(headerValueSafely(req, 'Authorization') || headerValueSafely(req, 'Cookie'));
}

function varyDisallowsRuntimeCache(vary) {
  try {
    if (!vary) return false;
    const parts = String(vary).split(',');
    for (let i = 0; i < parts.length; i++) {
      const token = parts[i].trim().toLowerCase();
      if (token === '*' || token === 'authorization' || token === 'cookie') return true;
    }
  } catch (_) {}
  return false;
}

function serviceWorkerBaseUrl() {
  try {
    return self.location.href || (self.location.origin + '/');
  } catch (_) {
    return '';
  }
}

function appAssetUrlMatches(url, asset) {
  try {
    return url.href === new URL(asset, serviceWorkerBaseUrl()).href;
  } catch (_) {
    return false;
  }
}

function isKnownAppAssetUrl(url) {
  try {
    const length = Number(ASSETS.length);
    const count = Number.isFinite(length) && length > 0 ? Math.min(Math.floor(length), 10000) : 0;
    for (let i = 0; i < count; i++) {
      let asset;
      try {
        asset = ASSETS[i];
      } catch (_) {
        continue;
      }
      if (appAssetUrlMatches(url, asset)) return true;
    }
  } catch (_) {}
  return false;
}

function requestDisallowsRuntimeCache(req) {
  const cacheMode = readRequestFieldSafely(req, 'cache', '');
  return cacheModeBypassesRuntimeCache(cacheMode) ||
    cacheControlDisallowsRuntimeCache(headerValueSafely(req, 'Cache-Control')) ||
    pragmaDisallowsRuntimeCache(headerValueSafely(req, 'Pragma')) ||
    sensitiveRequestHeaderDisallowsRuntimeCache(req);
}

function responseDisallowsRuntimeCache(resp) {
  return cacheControlDisallowsRuntimeCache(headerValueSafely(resp, 'Cache-Control')) ||
    pragmaDisallowsRuntimeCache(headerValueSafely(resp, 'Pragma')) ||
    expiredHeaderDisallowsRuntimeCache(headerValueSafely(resp, 'Expires')) ||
    varyDisallowsRuntimeCache(headerValueSafely(resp, 'Vary'));
}

function shouldCache(req, resp, url) {
  if (url.origin !== self.location.origin) return false;
  if (!isKnownAppAssetUrl(url)) return false;
  if (!resp || !resp.ok) return false;
  const status = readRequestFieldSafely(resp, 'status', 0);
  if (status === 206) return false;
  if (requestDisallowsRuntimeCache(req)) return false;
  if (headerValueSafely(req, 'Range')) return false;
  if (headerValueSafely(resp, 'Content-Range')) return false;
  return !responseDisallowsRuntimeCache(resp);
}

function offlineFallbackResponse() {
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function networkFailureResponse() {
  return new Response('', {
    status: 504,
    statusText: 'Gateway Timeout',
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

function readRequestFieldSafely(req, key, fallback) {
  try {
    return req ? req[key] : fallback;
  } catch (_) {
    return fallback;
  }
}

function getFetchRequestInfoSafely(e) {
  try {
    const req = e && e.request;
    const method = readRequestFieldSafely(req, 'method', '');
    if (method !== 'GET') return null;
    const url = new URL(readRequestFieldSafely(req, 'url', ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      req,
      url,
      mode: readRequestFieldSafely(req, 'mode', ''),
      cache: readRequestFieldSafely(req, 'cache', ''),
      sameOrigin: url.origin === self.location.origin,
    };
  } catch (_) {
    return null;
  }
}

function openCurrentCacheSafely() {
  try {
    return Promise.resolve(caches.open(CACHE)).catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

function cacheResponseSafely(req, resp, url) {
  try {
    if (!shouldCache(req, resp, url)) return;
    const cached = resp.clone();
    openCurrentCacheSafely().then(c => c && c.put(req, cached)).catch(() => {});
  } catch (_) {}
}

function fetchSafely(req) {
  try {
    return Promise.resolve(fetch(req));
  } catch (err) {
    return Promise.reject(err);
  }
}

function fetchAndMaybeCache(req, url) {
  return fetchSafely(req).then(resp => {
    cacheResponseSafely(req, resp, url);
    return resp;
  });
}

function fetchResourceSafely(req, url) {
  return fetchAndMaybeCache(req, url).catch(() => networkFailureResponse());
}

function fetchWithoutCacheSafely(req) {
  return fetchSafely(req).catch(() => networkFailureResponse());
}

function matchCacheSafely(req) {
  try {
    return Promise.resolve(caches.match(req)).catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

function precacheAssetSafely(cache, asset) {
  try {
    return Promise.resolve(cache.add(asset)).catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

function precacheAssetsSafely(cache) {
  let chain = Promise.resolve();
  try {
    const length = Number(ASSETS.length);
    const count = Number.isFinite(length) && length > 0 ? Math.min(Math.floor(length), 10000) : 0;
    for (let i = 0; i < count; i++) {
      let asset;
      try {
        asset = ASSETS[i];
      } catch (_) {
        continue;
      }
      chain = chain.then(() => precacheAssetSafely(cache, asset));
    }
  } catch (_) {}
  return chain;
}

function deleteCacheSafely(key) {
  try {
    return Promise.resolve(caches.delete(key)).catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

function isOldSimpleCadCacheKey(key) {
  try {
    return typeof key === 'string' && key.startsWith(CACHE_PREFIX) && key !== CACHE;
  } catch (_) {
    return false;
  }
}

function oldSimpleCadCacheKeysSafely(keys) {
  const oldKeys = [];
  try {
    const length = keys && Number(keys.length);
    if (!Number.isFinite(length) || length <= 0) return oldKeys;
    const count = Math.min(Math.floor(length), 10000);
    for (let i = 0; i < count; i++) {
      let key;
      try {
        key = keys[i];
      } catch (_) {
        continue;
      }
      if (isOldSimpleCadCacheKey(key)) oldKeys[oldKeys.length] = key;
    }
  } catch (_) {}
  return oldKeys;
}

function cleanupOldCachesSafely() {
  try {
    return Promise.resolve(caches.keys())
      .then(keys => {
        let chain = Promise.resolve([]);
        const oldKeys = oldSimpleCadCacheKeysSafely(keys);
        try {
          const length = oldKeys && Number(oldKeys.length);
          if (!Number.isFinite(length) || length <= 0) return chain;
          const count = Math.min(Math.floor(length), 10000);
          for (let i = 0; i < count; i++) {
            let key;
            try {
              key = oldKeys[i];
            } catch (_) {
              continue;
            }
            chain = chain.then(() => deleteCacheSafely(key));
          }
        } catch (_) {}
        return chain;
      })
      .catch(() => []);
  } catch (_) {
    return Promise.resolve([]);
  }
}

function claimClientsSafely() {
  try {
    return Promise.resolve(self.clients.claim()).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

function skipWaitingSafely() {
  try {
    return Promise.resolve(self.skipWaiting()).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

function waitUntilSafely(e, promiseLike) {
  try {
    if (e && typeof e.waitUntil === 'function') e.waitUntil(promiseLike);
  } catch (_) {}
}

function respondWithSafely(e, promiseLike) {
  try {
    if (e && typeof e.respondWith === 'function') e.respondWith(promiseLike);
  } catch (_) {}
}

self.addEventListener('install', e => {
  waitUntilSafely(e,
    openCurrentCacheSafely()
      .then(c => (c ? precacheAssetsSafely(c) : null))
      .catch(() => {})
      .then(() => skipWaitingSafely())
  );
});

self.addEventListener('activate', e => {
  waitUntilSafely(e,
    cleanupOldCachesSafely().then(() => claimClientsSafely())
  );
});

self.addEventListener('fetch', e => {
  const info = getFetchRequestInfoSafely(e);
  if (!info) return;
  const { req, url, mode, cache, sameOrigin } = info;
  if (mode === 'navigate') {
    respondWithSafely(e,
      fetchAndMaybeCache(req, url)
        .catch(() => matchCacheSafely(APP_SHELL).then(resp => resp || offlineFallbackResponse()).catch(() => offlineFallbackResponse()))
    );
    return;
  }
  if (!sameOrigin) {
    respondWithSafely(e, fetchWithoutCacheSafely(req));
    return;
  }
  if (requestDisallowsRuntimeCache(req) || !isKnownAppAssetUrl(url)) {
    respondWithSafely(e, fetchWithoutCacheSafely(req));
    return;
  }
  respondWithSafely(e,
    matchCacheSafely(req).then(cached => cached || fetchResourceSafely(req, url))
  );
});
