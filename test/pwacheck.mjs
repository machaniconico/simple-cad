// PWA検証: ローカルHTTPで配信し、SW登録→オフライン化→再読込でアプリが復元するか確認
import { chromium } from 'playwright';
import http from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
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
await page.goto(base);
await page.waitForFunction(() => window.SimpleCAD, null, { timeout: 5000 });

// manifest が link されていて取得・パースできる
const manifestHref = await page.getAttribute('link[rel=manifest]', 'href');
check('manifestがリンクされている', manifestHref === 'manifest.webmanifest', 'href=' + manifestHref);
const man = await page.evaluate(async () => { const r = await fetch('manifest.webmanifest'); return r.ok ? await r.json() : null; });
check('manifestが有効JSONでname/icons/start_urlを持つ', !!man && !!man.name && Array.isArray(man.icons) && man.icons.length > 0 && !!man.start_url, JSON.stringify(man && man.name));

// SWが登録されactiveになる
const swReady = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(reg && (reg.active || reg.installing || reg.waiting));
});
check('Service Workerが登録・有効化される', swReady === true);

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
await ctx.setOffline(false);

check('PWA関連でコンソールエラーなし', errs.length === 0, errs.join(' | '));

await browser.close();
server.close();
console.log(`\nPWA検証: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
