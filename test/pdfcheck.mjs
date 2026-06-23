// 生成PDFをディスクに書き出し、xrefオフセットの妥当性まで検証する
import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
await p.goto(pathToFileURL(join(root, 'index.html')).href);
await p.waitForFunction(() => window.SimpleCAD);
await p.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'a', type: 'rect', x: 0, y: 0, w: 120, h: 80, stroke: '#c00', strokeWidth: 2, fill: null });
  window.SimpleCAD.addShape({ id: 'b', type: 'circle', cx: 60, cy: 40, r: 30, stroke: '#06c', strokeWidth: 2, fill: null });
  window.SimpleCAD.addShape({ id: 'c', type: 'text', x: 5, y: 5, text: '図面PDFテスト 日本語OK', fontSize: 8, stroke: '#000' });
});
const arr = await p.evaluate(async () => {
  const bl = await window.SimpleCAD.buildPDFBlob();
  return [...new Uint8Array(await bl.arrayBuffer())];
});
await b.close();

const buf = Buffer.from(arr);
const outDir = mkdtempSync(join(tmpdir(), 'simplecad-pdf-'));
writeFileSync(join(outDir, 'drawing.pdf'), buf);
const s = buf.toString('latin1');

let ok = true;
const fail = (m) => { ok = false; console.log('  ❌ ' + m); };
const pass = (m) => console.log('  ✅ ' + m);

buf.length > 2000 ? pass('サイズ ' + buf.length + ' bytes') : fail('サイズが小さい');
s.startsWith('%PDF-1.') ? pass('ヘッダ %PDF-1.x') : fail('ヘッダ不正');
s.includes('%%EOF') ? pass('%%EOF あり') : fail('%%EOF なし');

// startxref のオフセットが xref を指すか
const sx = s.match(/startxref\s+(\d+)/);
if (!sx) fail('startxref なし');
else {
  const xoff = parseInt(sx[1]);
  s.slice(xoff, xoff + 4) === 'xref' ? pass('startxrefがxrefを指す') : fail('startxrefがxref位置とずれ: ' + s.slice(xoff, xoff + 8));
}
// xref各エントリのオフセットが "N 0 obj" を指すか
const xrefBlock = s.slice(s.indexOf('xref'));
const entries = [...xrefBlock.matchAll(/(\d{10}) (\d{5}) n/g)].map(m => parseInt(m[1]));
let objOk = true;
entries.forEach((off, i) => {
  const expect = `${i + 1} 0 obj`;
  if (s.slice(off, off + expect.length) !== expect) { objOk = false; fail(`obj${i + 1}のオフセット不正: "${s.slice(off, off + 12)}"`); }
});
if (objOk && entries.length === 5) pass('全5オブジェクトのxrefオフセットが正確');
else if (objOk) fail('xrefエントリ数=' + entries.length);

console.log(ok ? '\nPDF構造検証: OK' : '\nPDF構造検証: FAILED');
process.exit(ok ? 0 : 1);
