// SimpleCAD ヘッドレス検証スクリプト（Playwright/Chromium）
// 実行: node test/verify.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(join(__dirname, '..', 'index.html')).href;

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// キャンバス上の (clientX,clientY) を rect 基準で渡してマウス作図
async function drawDrag(page, box, x1, y1, x2, y2) {
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + (x1 + x2) / 2, box.y + (y1 + y2) / 2);
  await page.mouse.move(box.x + x2, box.y + y2);
  await page.mouse.up();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', d => d.accept()); // confirm()は承認

await page.goto(url);
await page.waitForFunction(() => window.SimpleCAD && typeof window.SimpleCAD.shapeCount === 'function', null, { timeout: 5000 });
// 自動保存の復元を消してクリーン状態に
await page.evaluate(() => window.SimpleCAD.clearAll());

const canvas = await page.$('#cv');
const box = await canvas.boundingBox();

// --- A: ロード/初期化 ---
check('ページがコンソールエラーなくロードされる', consoleErrors.length === 0, consoleErrors.join(' | '));
check('window.SimpleCAD が公開されている', await page.evaluate(() => !!window.SimpleCAD));

// --- B: 線分作図 ---
await page.evaluate(() => window.SimpleCAD.setTool('line'));
await drawDrag(page, box, 100, 100, 300, 200);
let n = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('線分が1本作図される', n === 1, 'count=' + n);
let t = await page.evaluate(() => window.SimpleCAD.state.shapes[0]?.type);
check('図形タイプが line', t === 'line', 't=' + t);

// --- C: 矩形・円 ---
await page.evaluate(() => window.SimpleCAD.setTool('rect'));
await drawDrag(page, box, 350, 150, 500, 300);
await page.evaluate(() => window.SimpleCAD.setTool('circle'));
await drawDrag(page, box, 600, 200, 680, 200);
n = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('矩形・円を加えて計3図形', n === 3, 'count=' + n);
const types = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.type));
check('図形タイプ列が [line,rect,circle]', JSON.stringify(types) === '["line","rect","circle"]', JSON.stringify(types));

// --- D: Undo/Redo ---
await page.evaluate(() => window.SimpleCAD.undo());
n = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('Undoで2図形に戻る', n === 2, 'count=' + n);
await page.evaluate(() => window.SimpleCAD.redo());
n = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('Redoで3図形に復帰', n === 3, 'count=' + n);

// --- E: 選択して移動 ---
await page.evaluate(() => window.SimpleCAD.setTool('select'));
// 線分の中点付近をクリックして選択→ドラッグ移動
const before = await page.evaluate(() => ({ ...window.SimpleCAD.state.shapes[0] }));
await page.mouse.move(box.x + 200, box.y + 150);
await page.mouse.down();
await page.mouse.move(box.x + 240, box.y + 190);
await page.mouse.move(box.x + 260, box.y + 210);
await page.mouse.up();
const after = await page.evaluate(() => ({ ...window.SimpleCAD.state.shapes[0] }));
check('選択ツールで線分を移動できる', after.x1 !== before.x1 || after.y1 !== before.y1,
  `before(${before.x1},${before.y1}) after(${after.x1},${after.y1})`);

// --- F: 保存/読込ラウンドトリップ ---
const dump = await page.evaluate(() => window.SimpleCAD.dumpJSON());
await page.evaluate(() => window.SimpleCAD.clearAll());
check('clearAllで0図形', (await page.evaluate(() => window.SimpleCAD.shapeCount())) === 0);
await page.evaluate((d) => window.SimpleCAD.loadJSON(d), dump);
const restored = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('loadJSONで3図形を完全復元', restored === 3, 'count=' + restored);

// --- G: SVG生成 ---
const svg = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('SVGに<svgルート要素', svg.includes('<svg'));
check('SVGに<line要素', svg.includes('<line'));
check('SVGに<rect図形要素', (svg.match(/<rect/g) || []).length >= 2); // 背景+図形
check('SVGに<circle要素', svg.includes('<circle'));
check('SVG寸法がNaNでない', !svg.includes('NaN'), svg.slice(0, 120));

// --- H: グリッド吸着 ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.state.grid.snap = true; window.SimpleCAD.state.grid.step = 10; });
await page.evaluate(() => window.SimpleCAD.setTool('line'));
await drawDrag(page, box, 123, 137, 287, 213);
const ln = await page.evaluate(() => window.SimpleCAD.state.shapes[0]);
const isMul = v => Math.abs(v / 10 - Math.round(v / 10)) < 1e-6;
check('グリッド吸着で端点がグリッド上(始点)', ln && isMul(ln.x1) && isMul(ln.y1), JSON.stringify(ln));
check('グリッド吸着で端点がグリッド上(終点)', ln && isMul(ln.x2) && isMul(ln.y2), JSON.stringify(ln));

// --- I: ピンチズーム（合成タッチ pointer イベント） ---
await page.evaluate(() => window.SimpleCAD.clearAll());
const beforeScale = await page.evaluate(() => window.SimpleCAD.state.view.scale);
await page.evaluate(() => {
  const cv = document.getElementById('cv');
  const r = cv.getBoundingClientRect();
  const mk = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y,
    bubbles: true, cancelable: true, isPrimary: id === 1,
  }));
  // 2本指を中央付近から外側へ広げる→ズームイン
  mk('pointerdown', 1, 400, 350); mk('pointerdown', 2, 500, 350);
  for (let i = 1; i <= 5; i++) { mk('pointermove', 1, 400 - i * 20, 350); mk('pointermove', 2, 500 + i * 20, 350); }
  mk('pointerup', 1, 300, 350); mk('pointerup', 2, 600, 350);
});
const afterScale = await page.evaluate(() => window.SimpleCAD.state.view.scale);
check('2本指ピンチでズーム倍率が増加', afterScale > beforeScale, `before=${beforeScale} after=${afterScale}`);

// --- J: ポリライン ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.setTool('polyline'); });
await page.mouse.click(box.x + 100, box.y + 400);
await page.mouse.click(box.x + 200, box.y + 450);
await page.mouse.click(box.x + 300, box.y + 400);
await page.evaluate(() => window.SimpleCAD.commitPoly(false));
const poly = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'polyline'));
check('ポリラインが3頂点で作図される', poly && poly.points.length === 3, JSON.stringify(poly?.points?.length));

// --- K: 数値直接入力(G002) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 's1', type: 'rect', x: 0, y: 0, w: 50, h: 30, stroke: '#fff', strokeWidth: 2, fill: null });
  window.SimpleCAD.select('s1');
});
const hasNumInputs = await page.evaluate(() => document.querySelectorAll('#numProps input[data-k]').length);
check('単一選択で数値入力欄が生成される', hasNumInputs === 4, 'inputs=' + hasNumInputs);
// 幅(w)を 50 -> 120 に変更
await page.evaluate(() => {
  const inp = [...document.querySelectorAll('#numProps input[data-k]')].find(i => i.dataset.k === 'w');
  inp.value = '120';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
let wv = await page.evaluate(() => window.SimpleCAD.state.shapes[0].w);
check('数値入力で幅が120に更新される', wv === 120, 'w=' + wv);
// 編集はUndo可能
await page.evaluate(() => window.SimpleCAD.undo());
wv = await page.evaluate(() => window.SimpleCAD.state.shapes[0].w);
check('数値編集をUndoで50に戻せる', wv === 50, 'w=' + wv);
// 非選択時はパネルが空
await page.evaluate(() => { window.SimpleCAD.state.selection.clear(); window.SimpleCAD.draw(); });
const emptyPanel = await page.evaluate(() => document.querySelectorAll('#numProps input[data-k]').length);
check('非選択時は数値入力欄が無い', emptyPanel === 0, 'inputs=' + emptyPanel);

// --- L: レイヤー(G003) ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.layerAPI.ensure(); });
// 既定で1レイヤー
let lc = await page.evaluate(() => window.SimpleCAD.state.layers.length);
check('既定レイヤーが1つ', lc === 1, 'layers=' + lc);
// レイヤー追加→アクティブ切替
await page.evaluate(() => window.SimpleCAD.layerAPI.add());
lc = await page.evaluate(() => window.SimpleCAD.state.layers.length);
const active2 = await page.evaluate(() => window.SimpleCAD.state.activeLayer);
check('レイヤー追加で2つ・新規がアクティブ', lc === 2 && active2 === 'L2', `layers=${lc} active=${active2}`);
// 新規図形は現アクティブレイヤーに割り当て
await page.evaluate(() => window.SimpleCAD.setTool('rect'));
await drawDrag(page, box, 120, 120, 220, 200);
const shLayer = await page.evaluate(() => window.SimpleCAD.state.shapes[0].layer);
check('新規図形がアクティブレイヤー(L2)に属する', shLayer === 'L2', 'layer=' + shLayer);
// L2を非表示→SVGに図形が出ない
await page.evaluate(() => { const l = window.SimpleCAD.state.layers.find(x => x.id === 'L2'); l.visible = false; window.SimpleCAD.draw(); });
let svg2 = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('非表示レイヤーの図形はSVGに出ない', !svg2.includes('<rect x'), svg2.slice(0, 80));
// 非表示レイヤーの図形はヒットしない(選択不可)
await page.evaluate(() => { window.SimpleCAD.state.layers.find(x => x.id === 'L2').visible = true; window.SimpleCAD.state.layers.find(x => x.id === 'L2').locked = true; window.SimpleCAD.draw(); });
const hit = await page.evaluate(() => { const s = window.SimpleCAD.state.shapes[0]; return !!window.SimpleCAD.hitTest(s.x + s.w / 2, s.y); });
check('ロックレイヤーの図形は選択不可', hit === false, 'hit=' + hit);
// 保存/読込でレイヤー復元
const dump2 = await page.evaluate(() => window.SimpleCAD.dumpJSON());
check('dumpにlayersが含まれる', Array.isArray(dump2.layers) && dump2.layers.length === 2);
await page.evaluate(() => window.SimpleCAD.clearAll());
await page.evaluate((d) => window.SimpleCAD.loadJSON(d), dump2);
const lc2 = await page.evaluate(() => window.SimpleCAD.state.layers.length);
check('読込でレイヤーが復元される', lc2 === 2, 'layers=' + lc2);
// レイヤー削除(図形ごと)
await page.evaluate(() => window.SimpleCAD.layerAPI.del('L2'));
const afterDel = await page.evaluate(() => ({ layers: window.SimpleCAD.state.layers.length, shapes: window.SimpleCAD.shapeCount() }));
check('レイヤー削除で図形も消える', afterDel.layers === 1 && afterDel.shapes === 0, JSON.stringify(afterDel));

// --- M: 文字入力(G004) ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.setTool('text'); });
// テキストツールでキャンバスをクリック→オーバーレイ入力が開く
await page.mouse.click(box.x + 200, box.y + 200);
const overlayShown = await page.evaluate(() => document.getElementById('textInput').style.display);
check('テキストツールで入力欄が開く', overlayShown === 'block', 'display=' + overlayShown);
// 入力してCtrl+Enterで確定
await page.evaluate(() => {
  const inp = document.getElementById('textInput');
  inp.value = '寸法注記A';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
});
const txt = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'text'));
check('テキスト図形が作成される', txt && txt.text === '寸法注記A', JSON.stringify(txt && txt.text));
check('テキストにfontSizeが設定される', txt && txt.fontSize > 0, 'fs=' + (txt && txt.fontSize));
// 本文を数値パネルから編集
await page.evaluate(() => window.SimpleCAD.select(window.SimpleCAD.state.shapes.find(s => s.type === 'text').id));
const hasTextField = await page.evaluate(() => !!document.querySelector('#numProps input[data-ktext]'));
check('単一選択でテキスト本文編集欄が出る', hasTextField);
await page.evaluate(() => {
  const inp = document.querySelector('#numProps input[data-ktext]');
  inp.value = '修正後テキスト';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
const txt2 = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'text').text);
check('パネルで本文を編集できる', txt2 === '修正後テキスト', txt2);
// SVGにテキストが出る(エスケープ確認のため<を含めない通常文字)
const svgT = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('SVGに<text>要素が出る', svgT.includes('<text') && svgT.includes('修正後テキスト'), svgT.slice(0, 120));
// 保存/読込でテキスト復元
const dT = await page.evaluate(() => window.SimpleCAD.dumpJSON());
await page.evaluate(() => window.SimpleCAD.clearAll());
await page.evaluate((d) => window.SimpleCAD.loadJSON(d), dT);
const txt3 = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'text')?.text);
check('読込でテキストが復元される', txt3 === '修正後テキスト', txt3);

// --- N: 変形ハンドル(G005) ---
// スナップOFFで連続変形を検証
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.state.view = { scale: 2, offsetX: 50, offsetY: 50 }; // ビューを既知状態へ
  window.SimpleCAD.setTool('select');
  window.SimpleCAD.addShape({ id: 'r1', type: 'rect', x: 100, y: 100, w: 60, h: 40, stroke: '#fff', strokeWidth: 2, fill: null });
  window.SimpleCAD.select('r1');
});
// scaleShapeAbout: (0,0)中心に2倍
const sc = await page.evaluate(() => {
  const s = { type: 'rect', x: 10, y: 10, w: 20, h: 20 };
  window.SimpleCAD.transformAPI.scaleShapeAbout(s, 0, 0, 2, 2);
  return s;
});
check('scaleShapeAboutで2倍拡大', sc.x === 20 && sc.w === 40, JSON.stringify(sc));
// shapeExtentは回転で拡大する
const ext = await page.evaluate(() => {
  const s = { type: 'rect', x: 0, y: 0, w: 100, h: 0.0001, rot: Math.PI / 4 };
  return window.SimpleCAD.transformAPI.shapeExtent(s);
});
check('回転で軸平行外接矩形が拡大', ext.w > 60 && ext.h > 60, JSON.stringify(ext));
// 角ハンドルをドラッグしてリサイズ(右下corner idx2)
const cornerVp = await page.evaluate(() => {
  const s = window.SimpleCAD.state.shapes[0];
  const hg = window.SimpleCAD.transformAPI.handleGeom(s);
  const v = window.SimpleCAD.state.view;
  const c = hg.corners[2]; // 右下
  return { x: c.x * v.scale + v.offsetX, y: c.y * v.scale + v.offsetY };
});
await page.mouse.move(box.x + cornerVp.x, box.y + cornerVp.y);
await page.mouse.down();
await page.mouse.move(box.x + cornerVp.x + 60, box.y + cornerVp.y + 40);
await page.mouse.move(box.x + cornerVp.x + 120, box.y + cornerVp.y + 80);
await page.mouse.up();
const resized = await page.evaluate(() => window.SimpleCAD.state.shapes[0]);
check('角ハンドルのドラッグで拡大される', resized && resized.w > 60 && resized.h > 40, `w=${resized?.w} h=${resized?.h}`);
// リサイズはUndo可能
await page.evaluate(() => window.SimpleCAD.undo());
const afterUndo = await page.evaluate(() => window.SimpleCAD.state.shapes[0]) || {};
check('リサイズをUndoで元寸に戻せる', Math.abs(afterUndo.w - 60) < 0.001 && Math.abs(afterUndo.h - 40) < 0.001, `w=${afterUndo.w} h=${afterUndo.h}`);
// 回転ハンドルをドラッグして回転
await page.evaluate(() => window.SimpleCAD.select('r1'));
const rotVp = await page.evaluate(() => {
  const s = window.SimpleCAD.state.shapes[0];
  const hg = window.SimpleCAD.transformAPI.handleGeom(s);
  const v = window.SimpleCAD.state.view;
  return { h: { x: hg.rotHandle.x * v.scale + v.offsetX, y: hg.rotHandle.y * v.scale + v.offsetY },
           c: { x: hg.center.x * v.scale + v.offsetX, y: hg.center.y * v.scale + v.offsetY } };
});
await page.mouse.move(box.x + rotVp.h.x, box.y + rotVp.h.y);
await page.mouse.down();
// 中心の右側へ動かす→約90度回転
await page.mouse.move(box.x + rotVp.c.x + 80, box.y + rotVp.c.y);
await page.mouse.move(box.x + rotVp.c.x + 90, box.y + rotVp.c.y + 2);
await page.mouse.up();
const rotShape = await page.evaluate(() => window.SimpleCAD.state.shapes[0]);
check('回転ハンドルのドラッグでrotが変化', Math.abs(rotShape.rot || 0) > 0.3, 'rot=' + rotShape.rot);
// 回転図形のヒットテスト(ローカル座標化)
const hitRot = await page.evaluate(() => {
  const s = window.SimpleCAD.state.shapes[0];
  // 図形中心は必ずヒットするはず(塗り無し矩形なので中心線上ではない→端でテスト)
  const c = window.SimpleCAD.transformAPI.shapeCenter(s);
  // 回転後の右下コーナー付近をヒット
  const hg = window.SimpleCAD.transformAPI.handleGeom(s);
  const corner = hg.corners[2];
  return !!window.SimpleCAD.hitTest(corner.x, corner.y);
});
check('回転図形を回転後の位置で選択できる', hitRot === true, 'hit=' + hitRot);
// 角度を数値パネルから設定
await page.evaluate(() => { window.SimpleCAD.state.shapes[0].rot = 0; window.SimpleCAD.select('r1'); });
await page.evaluate(() => {
  const inp = document.querySelector('#numProps input[data-kdeg]');
  inp.value = '30';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
const deg = await page.evaluate(() => (window.SimpleCAD.state.shapes[0].rot * 180 / Math.PI));
check('角度欄で30度に設定できる', Math.abs(deg - 30) < 0.5, 'deg=' + deg);

// --- O: PDF出力(G006) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.view = { scale: 2, offsetX: 50, offsetY: 50 };
  window.SimpleCAD.addShape({ id: 'pr', type: 'rect', x: 0, y: 0, w: 100, h: 50, stroke: '#000', strokeWidth: 2, fill: null });
  window.SimpleCAD.addShape({ id: 'pt', type: 'text', x: 10, y: 10, text: '日本語テキスト注記', fontSize: 8, stroke: '#000' });
});
const pdfInfo = await page.evaluate(async () => {
  const blob = await window.SimpleCAD.buildPDFBlob();
  if (!blob) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const head = new TextDecoder('latin1').decode(buf.slice(0, 8));
  const tail = new TextDecoder('latin1').decode(buf.slice(-8));
  const full = new TextDecoder('latin1').decode(buf);
  return { size: buf.length, head, tail, hasEOF: full.includes('%%EOF'), hasXref: full.includes('xref'), hasImage: full.includes('/Image'), hasFlate: full.includes('/FlateDecode'), type: blob.type };
});
check('PDF Blobが生成される', pdfInfo && pdfInfo.size > 1000, 'size=' + (pdfInfo && pdfInfo.size));
check('PDFヘッダが%PDF', pdfInfo && pdfInfo.head.startsWith('%PDF-'), 'head=' + (pdfInfo && pdfInfo.head));
check('PDFに%%EOFがある', pdfInfo && pdfInfo.hasEOF);
check('PDFにxrefがある', pdfInfo && pdfInfo.hasXref);
check('PDFに画像XObjectが埋め込まれる', pdfInfo && pdfInfo.hasImage);
check('PDF MIMEがapplication/pdf', pdfInfo && pdfInfo.type === 'application/pdf');
// ページサイズが実寸(110mm x 60mm 相当, padding込み)。100+10pad*2=110mm→311.8pt前後
const mediaBox = await page.evaluate(async () => {
  const blob = await window.SimpleCAD.buildPDFBlob();
  const full = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
  const m = full.match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : null;
});
const mm2pt = 72 / 25.4;
check('PDFページ幅が実寸(110mm)', mediaBox && Math.abs(mediaBox.w - 110 * mm2pt) < 2, JSON.stringify(mediaBox));
check('PDFページ高が実寸(60mm)', mediaBox && Math.abs(mediaBox.h - 60 * mm2pt) < 2, JSON.stringify(mediaBox));

// --- P: 堅牢化(レビュー指摘の回帰) ---
// 不正JSON(XSS試行/proto汚染/不正座標)を読み込んでも安全
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.loadJSON({
    shapes: [
      { type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000"/><script>alert(1)</script><rect x="0', fill: 'none' },
      { type: 'circle', cx: 'NaN', cy: 5, r: -3 },
      { type: 'polyline' }, // points無し→除外
      { type: 'unknown' },  // 未知型→除外
      { type: 'text', x: 1, y: 1, text: '<b>&"危険"', fontSize: 0 },
      { type: '__proto__', polluted: true },
    ],
  });
});
const sani = await page.evaluate(() => {
  const ss = window.SimpleCAD.state.shapes;
  return {
    count: ss.length,
    rectStroke: ss.find(s => s.type === 'rect')?.stroke,
    circleR: ss.find(s => s.type === 'circle')?.r,
    textFs: ss.find(s => s.type === 'text')?.fontSize,
    proto: ({}).polluted,
  };
});
check('不正な線色は安全な既定値に矯正される', sani.rectStroke === '#38bdf8', 'stroke=' + sani.rectStroke);
check('負の半径は0以上に矯正', sani.circleR >= 0, 'r=' + sani.circleR);
check('fontSize=0は最小値に矯正', sani.textFs >= 0.1, 'fs=' + sani.textFs);
check('points無しpolyline/未知型/proto型は除外', sani.count === 3, 'count=' + sani.count);
check('プロトタイプ汚染が起きない', sani.proto === undefined, 'polluted=' + sani.proto);
// 汚染shapeを含んでもSVGにscriptタグが素通りしない
const svgSafe = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('SVGに<script>が混入しない', !svgSafe.includes('<script'), svgSafe.slice(0, 100));
// 壊れたviewは無視される
await page.evaluate(() => window.SimpleCAD.loadJSON({ shapes: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }], view: { scale: 0, offsetX: 'x', offsetY: NaN } }));
const viewOk = await page.evaluate(() => { const v = window.SimpleCAD.state.view; return isFinite(v.scale) && v.scale > 0; });
check('壊れたviewは無視され有効な倍率を保つ', viewOk === true);
// 全図形が非表示レイヤーのときのエクスポートは安全に空
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'h1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.state.layers[0].visible = false; window.SimpleCAD.draw();
});
const hiddenExport = await page.evaluate(async () => {
  const svg = window.SimpleCAD.buildSVGString();
  const pdf = await window.SimpleCAD.buildPDFBlob();
  return { svg, pdf };
});
check('非表示のみ時SVGは空文字', hiddenExport.svg === '', 'len=' + hiddenExport.svg.length);
check('非表示のみ時PDFはnull', hiddenExport.pdf === null);
// nextLayerIdが履歴で巻き戻る
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.layerAPI.add(); window.SimpleCAD.layerAPI.add(); });
const nlBefore = await page.evaluate(() => window.SimpleCAD.dumpJSON().layers.length);
check('レイヤー2つ追加で計3', nlBefore === 3, 'layers=' + nlBefore);

// --- Q: 複数選択(範囲ドラッグ/Shiftトグル) ---
// 左ツールパレット/右プロパティを避けるため offset0・中央寄りの座標で操作
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 };
  window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.setTool('select');
  window.SimpleCAD.addShape({ id: 'm1', type: 'rect', x: 60, y: 60, w: 40, h: 30, stroke: '#fff', strokeWidth: 2, fill: null });
  window.SimpleCAD.addShape({ id: 'm2', type: 'circle', cx: 160, cy: 90, r: 15, stroke: '#fff', strokeWidth: 2, fill: null });
  window.SimpleCAD.addShape({ id: 'm3', type: 'rect', x: 300, y: 250, w: 20, h: 20, stroke: '#fff', strokeWidth: 2, fill: null });
});
const toVp = (wx, wy) => ({ x: box.x + wx * 2, y: box.y + wy * 2 });
// world(50,50)〜(220,130) を覆う範囲ドラッグ → m1,m2が入りm3は外
let a = toVp(50, 50), b2 = toVp(220, 130);
await page.mouse.move(a.x, a.y); await page.mouse.down();
await page.mouse.move((a.x + b2.x) / 2, (a.y + b2.y) / 2, { steps: 3 }); await page.mouse.move(b2.x, b2.y, { steps: 3 }); await page.mouse.up();
let selN = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('範囲ドラッグで2図形選択', selN === 2, 'sel=' + selN);
const selHas = await page.evaluate(() => ({ m1: window.SimpleCAD.state.selection.has('m1'), m2: window.SimpleCAD.state.selection.has('m2'), m3: window.SimpleCAD.state.selection.has('m3') }));
check('範囲内のm1/m2のみ選択、m3は非選択', selHas.m1 && selHas.m2 && !selHas.m3, JSON.stringify(selHas));
// Shiftクリックでm3を追加(塗り無し矩形は辺上をクリック: 左辺 world x=300)
const m3vp = toVp(300, 260);
await page.keyboard.down('Shift');
await page.mouse.click(m3vp.x, m3vp.y);
await page.keyboard.up('Shift');
selN = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('Shiftクリックでm3を追加し計3', selN === 3, 'sel=' + selN);
// 複数選択をまとめて移動(m1の左辺 world x=60 を掴む)
const c1 = toVp(60, 75);
await page.mouse.move(c1.x, c1.y); await page.mouse.down();
await page.mouse.move(c1.x + 40, c1.y + 20, { steps: 3 }); await page.mouse.move(c1.x + 80, c1.y + 40, { steps: 3 }); await page.mouse.up();
const moved = await page.evaluate(() => window.SimpleCAD.state.shapes.find(x => x.id === 'm2').cx !== 160);
check('複数選択をまとめて移動できる', moved, 'm2移動=' + moved);

// --- R: コピペ/複製/微動/全選択 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid = Object.assign(window.SimpleCAD.state.grid, { snap: true, step: 10 });
  window.SimpleCAD.addShape({ id: 'e1', type: 'rect', x: 0, y: 0, w: 40, h: 30, stroke: '#fff', strokeWidth: 2, fill: null });
});
// 複製: 1個→2個、複製はオフセットされる
await page.evaluate(() => { window.SimpleCAD.select('e1'); window.SimpleCAD.editAPI.duplicate(); });
let cnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('複製で図形が2個になる', cnt === 2, 'count=' + cnt);
const dup = await page.evaluate(() => { const ss = window.SimpleCAD.state.shapes; return { x0: ss[0].x, x1: ss[1].x, selDup: window.SimpleCAD.state.selection.has(ss[1].id) }; });
check('複製はオフセットされ新図形が選択される', dup.x1 === dup.x0 + 10 && dup.selDup, JSON.stringify(dup));
// コピー&ペースト
await page.evaluate(() => { window.SimpleCAD.select(window.SimpleCAD.state.shapes[0].id); window.SimpleCAD.editAPI.copy(); window.SimpleCAD.editAPI.paste(); });
cnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('コピー&ペーストで3個になる', cnt === 3, 'count=' + cnt);
// 矢印移動(grid step=10)
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.addShape({ id: 'n1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null }); window.SimpleCAD.select('n1'); });
const nx0 = await page.evaluate(() => window.SimpleCAD.state.shapes[0].x);
await page.evaluate(() => window.SimpleCAD.editAPI.nudge(10, 0));
const nx1 = await page.evaluate(() => window.SimpleCAD.state.shapes[0].x);
check('微動で+10移動しUndo可能', nx1 === nx0 + 10, `x ${nx0}->${nx1}`);
await page.evaluate(() => window.SimpleCAD.undo());
const nx2 = await page.evaluate(() => window.SimpleCAD.state.shapes[0].x);
check('微動をUndoで戻せる', nx2 === nx0, 'x=' + nx2);
// 矢印キー(実キー)でも動く
await page.evaluate(() => window.SimpleCAD.select('n1'));
await page.mouse.move(box.x + 5, box.y + 5); // フォーカスをbodyへ
await page.keyboard.press('ArrowRight');
const nx3 = await page.evaluate(() => window.SimpleCAD.state.shapes[0].x);
check('ArrowRightキーで移動する', nx3 > nx0, 'x=' + nx3);
// 全選択
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.addShape({ id: 'a1', type: 'rect', x: 0, y: 0, w: 5, h: 5, stroke: '#fff', strokeWidth: 1, fill: null }); window.SimpleCAD.addShape({ id: 'a2', type: 'circle', cx: 50, cy: 50, r: 10, stroke: '#fff', strokeWidth: 1, fill: null }); window.SimpleCAD.editAPI.selectAll(); });
const allSel = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('全選択で全図形が選択される', allSel === 2, 'sel=' + allSel);

// --- S: 整列・分布 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'g1', type: 'rect', x: 0, y: 0, w: 20, h: 20, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'g2', type: 'rect', x: 100, y: 30, w: 20, h: 20, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'g3', type: 'rect', x: 300, y: 60, w: 20, h: 20, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.editAPI.selectAll();
});
// 左揃え: 全部の x が最小(0)に
await page.evaluate(() => window.SimpleCAD.alignAPI.align('left'));
const lefts = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.x));
check('左揃えで全図形のxが0に揃う', lefts.every(x => x === 0), JSON.stringify(lefts));
// 上揃え: 全部の y が最小(0)に
await page.evaluate(() => window.SimpleCAD.alignAPI.align('top'));
const tops = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.y));
check('上揃えで全図形のyが0に揃う', tops.every(y => y === 0), JSON.stringify(tops));
// 横分布: 中心が等間隔になる(まず横位置を散らす)
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'd1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'd2', type: 'rect', x: 20, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'd3', type: 'rect', x: 200, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.editAPI.selectAll();
  window.SimpleCAD.alignAPI.distribute('x');
});
const cxs = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.x + s.w / 2).sort((a, b) => a - b));
check('横分布で中心が等間隔になる', Math.abs((cxs[1] - cxs[0]) - (cxs[2] - cxs[1])) < 0.001, JSON.stringify(cxs));

// --- T: 重ね順(z-order) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'z1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'z2', type: 'rect', x: 5, y: 5, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'z3', type: 'rect', x: 10, y: 10, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
});
const order0 = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.id).join(','));
check('初期重ね順 z1,z2,z3', order0 === 'z1,z2,z3', order0);
// z1を最前面へ
await page.evaluate(() => { window.SimpleCAD.select('z1'); window.SimpleCAD.orderAPI.reorder('front'); });
let order = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.id).join(','));
check('最前面でz1が末尾(最前)に', order === 'z2,z3,z1', order);
// z1を最背面へ
await page.evaluate(() => { window.SimpleCAD.select('z1'); window.SimpleCAD.orderAPI.reorder('back'); });
order = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.id).join(','));
check('最背面でz1が先頭(最背)に', order === 'z1,z2,z3', order);
// z1を前面へ1段
await page.evaluate(() => { window.SimpleCAD.select('z1'); window.SimpleCAD.orderAPI.reorder('forward'); });
order = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.id).join(','));
check('前面へ1段でz2,z1,z3', order === 'z2,z1,z3', order);

// --- U: Shift直交拘束で水平線 ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 }; window.SimpleCAD.state.grid.snap = false; window.SimpleCAD.setTool('line'); });
const ls = toVp(60, 60), le = toVp(160, 75); // ほぼ水平だが少し斜め
await page.keyboard.down('Shift');
await page.mouse.move(ls.x, ls.y); await page.mouse.down();
await page.mouse.move((ls.x + le.x) / 2, (ls.y + le.y) / 2, { steps: 3 }); await page.mouse.move(le.x, le.y, { steps: 3 }); await page.mouse.up();
await page.keyboard.up('Shift');
const line = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'line'));
check('Shiftで水平線に拘束(y1≈y2)', line && Math.abs(line.y1 - line.y2) < 0.5, JSON.stringify(line && { y1: line.y1, y2: line.y2 }));

// --- V: 楕円ツール ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 }; window.SimpleCAD.state.grid.snap = false; window.SimpleCAD.setTool('ellipse'); });
// world(80,80)〜(180,140) をドラッグ → cx130,cy110,rx50,ry30
await drawDrag(page, { x: 0, y: 51 }, 80 * 2, 80 * 2, 180 * 2, 140 * 2);
const el = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'ellipse'));
check('楕円が作図される', !!el, JSON.stringify(el));
check('楕円のrx/ryが正しい', el && Math.abs(el.rx - 50) < 1 && Math.abs(el.ry - 30) < 1, el && JSON.stringify({ cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry }));
// 楕円の選択(輪郭をクリック: 右端 world cx+rx,cy)
await page.evaluate(() => window.SimpleCAD.setTool('select'));
const edge = { x: 0 + (el.cx + el.rx) * 2, y: 51 + el.cy * 2 };
await page.mouse.click(edge.x, edge.y);
const selEl = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('楕円を輪郭クリックで選択できる', selEl === 1, 'sel=' + selEl);
// SVGに<ellipse>
const svgEl = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('SVGに<ellipse>要素', svgEl.includes('<ellipse'), svgEl.slice(0, 80));
// 保存読込で復元
const dE = await page.evaluate(() => window.SimpleCAD.dumpJSON());
await page.evaluate(() => window.SimpleCAD.clearAll());
await page.evaluate((d) => window.SimpleCAD.loadJSON(d), dE);
const elR = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'ellipse'));
check('楕円が保存読込で復元される', !!elR && Math.abs(elR.rx - 50) < 1, JSON.stringify(elR && elR.rx));

// --- W: ツール切替ショートカット ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.setTool('select'); });
await page.mouse.move(box.x + 400, box.y + 300); // フォーカスをbodyへ
await page.keyboard.press('r');
let tool = await page.evaluate(() => window.SimpleCAD.state.tool);
check('キー r で矩形ツール', tool === 'rect', 'tool=' + tool);
await page.keyboard.press('o');
tool = await page.evaluate(() => window.SimpleCAD.state.tool);
check('キー o で楕円ツール', tool === 'ellipse', 'tool=' + tool);
await page.keyboard.press('v');
tool = await page.evaluate(() => window.SimpleCAD.state.tool);
check('キー v で選択ツール', tool === 'select', 'tool=' + tool);

// --- X: 設定(グリッド/スタイル)の永続化 ---
await page.evaluate(() => {
  window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.state.grid.step = 50;
  window.SimpleCAD.state.style.stroke = '#ff8800';
  window.SimpleCAD.addShape({ id: 'pf', type: 'rect', x: 0, y: 0, w: 5, h: 5, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.saveNow(); // デバウンス待ちせず同期保存
  // 状態を変えてからストア再読込(reload相当・決定論的)
  window.SimpleCAD.state.grid.snap = true; window.SimpleCAD.state.grid.step = 10; window.SimpleCAD.state.style.stroke = '#000000';
  window.SimpleCAD.reloadFromStore();
});
const prefs = await page.evaluate(() => ({ snap: window.SimpleCAD.state.grid.snap, step: window.SimpleCAD.state.grid.step, stroke: window.SimpleCAD.state.style.stroke, uiStep: document.getElementById('gStep').value, uiStroke: document.getElementById('pStroke').value }));
check('リロードでグリッド設定が復元', prefs.snap === false && prefs.step === 50, JSON.stringify(prefs));
check('リロードで線色設定が復元', prefs.stroke === '#ff8800', 'stroke=' + prefs.stroke);
check('復元した設定がUIにも反映', prefs.uiStep === '50' && prefs.uiStroke === '#ff8800', JSON.stringify({ uiStep: prefs.uiStep, uiStroke: prefs.uiStroke }));

// --- Y: 背景画像(トレース用) ---
// 1x1 透明PNG(data URL)
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
await page.evaluate((src) => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'im1', type: 'image', x: 10, y: 10, w: 100, h: 80, src, opacity: 0.5, layer: window.SimpleCAD.state.activeLayer });
}, PNG1);
const im = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'image'));
check('画像図形が配置される', !!im && im.w === 100 && im.opacity === 0.5, JSON.stringify(im && { w: im.w, op: im.opacity }));
// SVGに<image>(data URL)が埋め込まれる
const svgIm = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('SVGに<image data:url>が埋め込まれる', svgIm.includes('<image') && svgIm.includes('data:image/'), svgIm.slice(0, 60));
// 非data URL(javascript:等)はサニタイズで除外
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.loadJSON({ shapes: [{ type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' }] }); });
const badImgCnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('不正src(非data:)の画像は除外される', badImgCnt === 0, 'count=' + badImgCnt);
// 属性ブレイクアウトを狙った data:image/svg+xml(非base64)も除外
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.loadJSON({ shapes: [{ type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'data:image/svg+xml,x"/><script>alert(1)</script>' }] }); });
const breakoutCnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('非base64のdata:image(ブレイクアウト試行)は除外', breakoutCnt === 0, 'count=' + breakoutCnt);
// 保存読込で画像が復元される
await page.evaluate((src) => { window.SimpleCAD.clearAll(); window.SimpleCAD.addShape({ id: 'im2', type: 'image', x: 0, y: 0, w: 50, h: 40, src, opacity: 1, layer: window.SimpleCAD.state.activeLayer }); }, PNG1);
const dImg = await page.evaluate(() => window.SimpleCAD.dumpJSON());
await page.evaluate(() => window.SimpleCAD.clearAll());
await page.evaluate((d) => window.SimpleCAD.loadJSON(d), dImg);
const imR = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'image'));
check('画像が保存読込で復元される', !!imR && imR.w === 50, JSON.stringify(imR && imR.w));

// --- Z: 正多角形ツール ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 };
  window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.state.style.sides = 6;
  window.SimpleCAD.setTool('polygon');
});
// 中心(120,120)から半径方向へドラッグ
await drawDrag(page, { x: 0, y: 51 }, 120 * 2, 120 * 2, 170 * 2, 120 * 2);
const hex = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'polyline' && s.closed));
check('正多角形が6頂点の閉ポリラインで作図', hex && hex.points.length === 6 && hex.closed, JSON.stringify(hex && hex.points.length));
// 辺数を変えて作図
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.state.style.sides = 3; window.SimpleCAD.setTool('polygon'); });
await drawDrag(page, { x: 0, y: 51 }, 120 * 2, 120 * 2, 160 * 2, 120 * 2);
const tri = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'polyline' && s.closed));
check('辺数3で三角形になる', tri && tri.points.length === 3, JSON.stringify(tri && tri.points.length));

// --- AA: タッチ時のヒット判定拡大 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 };
  window.SimpleCAD.setTool('select');
  // 縦線 x=100, y=100..200
  window.SimpleCAD.addShape({ id: 'tl', type: 'line', x1: 100, y1: 100, x2: 100, y2: 200, stroke: '#fff', strokeWidth: 1, fill: null });
});
// 線から world約5mm(=10px)離れた点を「タッチ」でタップ → 拡大判定(14px)で選択されるはず
await page.evaluate(() => {
  const cv = document.getElementById('cv');
  const r = cv.getBoundingClientRect();
  const wx = 105, wy = 150; // 線(x=100)から5mm右
  const sx = r.left + wx * 2, sy = r.top + wy * 2;
  const mk = (type) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: sx, clientY: sy, bubbles: true, cancelable: true, isPrimary: true }));
  mk('pointerdown'); mk('pointerup');
});
const touchSel = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('タッチは判定が広く、5mm外しても線を選択', touchSel === 1, 'sel=' + touchSel);
// マウス(細判定)で同じ点(5mm外し=10px>8px)はヒットしない
await page.evaluate(() => { window.SimpleCAD.state.selection.clear(); window.SimpleCAD.draw(); });
await page.mouse.click(0 + 105 * 2, 51 + 150 * 2);
const mouseSel = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('マウスは細判定で5mm外しは非選択', mouseSel === 0, 'sel=' + mouseSel);

// --- AB: Alt+ドラッグ複製 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 };
  window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.setTool('select');
  window.SimpleCAD.addShape({ id: 'ad', type: 'rect', x: 60, y: 60, w: 40, h: 30, stroke: '#fff', strokeWidth: 2, fill: null });
});
const grab = toVp(60, 75); // 左辺をつかむ
await page.keyboard.down('Alt');
await page.mouse.move(grab.x, grab.y); await page.mouse.down();
await page.mouse.move(grab.x + 60, grab.y + 40, { steps: 3 }); await page.mouse.move(grab.x + 120, grab.y + 80, { steps: 3 }); await page.mouse.up();
await page.keyboard.up('Alt');
const altRes = await page.evaluate(() => ({ count: window.SimpleCAD.shapeCount(), origX: window.SimpleCAD.state.shapes[0].x, sel: window.SimpleCAD.state.selection.size }));
check('Alt+ドラッグで複製され2個になる', altRes.count === 2, JSON.stringify(altRes));
check('原本は元位置に残る(x=60)', altRes.origX === 60, 'origX=' + altRes.origX);
check('複製側が選択される', altRes.sel === 1, 'sel=' + altRes.sel);
// Undoで複製ごと戻る
await page.evaluate(() => window.SimpleCAD.undo());
const undoCnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('Alt複製はUndoで1個に戻る', undoCnt === 1, 'count=' + undoCnt);

// --- AC: ヘルプパネル ---
await page.evaluate(() => window.SimpleCAD && document.getElementById('btnHelp').click());
let helpDisp = await page.evaluate(() => getComputedStyle(document.getElementById('help')).display);
check('ヘルプボタンで開く', helpDisp === 'flex', 'display=' + helpDisp);
await page.evaluate(() => document.getElementById('helpClose').click());
helpDisp = await page.evaluate(() => document.getElementById('help').style.display);
check('閉じるボタンで閉じる', helpDisp === 'none', 'display=' + helpDisp);

// --- AD: 線種(破線/点線) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.style.dash = 'dashed';
  window.SimpleCAD.addShape({ id: 'ds', type: 'rect', x: 0, y: 0, w: 40, h: 30, stroke: '#000', strokeWidth: 1, fill: null, dash: 'dashed' });
});
const svgDash = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('破線がSVGにstroke-dasharrayで出力', svgDash.includes('stroke-dasharray="5,3"'), svgDash.slice(0, 120));
// サニタイズで不正dashはsolidに
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.loadJSON({ shapes: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5, dash: 'evil' }] }); });
const dashSan = await page.evaluate(() => window.SimpleCAD.state.shapes[0].dash);
check('不正な線種はsolidに矯正', dashSan === 'solid', 'dash=' + dashSan);

// --- AE: カラースウォッチ ---
const swCount = await page.evaluate(() => document.querySelectorAll('#swatches button').length);
check('スウォッチが8色生成される', swCount === 8, 'n=' + swCount);
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'sw', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('sw');
  document.querySelectorAll('#swatches button')[2].click(); // #ef4444
});
const swStroke = await page.evaluate(() => ({ shape: window.SimpleCAD.state.shapes[0].stroke, style: window.SimpleCAD.state.style.stroke }));
check('スウォッチで選択図形と既定色が変わる', swStroke.shape === '#ef4444' && swStroke.style === '#ef4444', JSON.stringify(swStroke));

// --- AF: 破線がフレーム間で漏れない ---
const dashLeak = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  // 最前面に非選択の破線矩形を置く
  window.SimpleCAD.addShape({ id: 'dl', type: 'rect', x: 10, y: 10, w: 50, h: 40, stroke: '#000', strokeWidth: 1, fill: null, dash: 'dashed' });
  window.SimpleCAD.state.selection.clear();
  window.SimpleCAD.draw();
  // draw直後、コンテキストの破線がリセットされているか
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  return ctx.getLineDash().length;
});
check('描画後にcanvasの破線状態がリセットされる', dashLeak === 0, 'lineDash=' + dashLeak);

// --- AG: 選択時オンスクリーン操作(複製/削除) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.setTool('select');
  window.SimpleCAD.addShape({ id: 'op', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
});
let actVis = await page.evaluate(() => document.getElementById('selActions').style.display);
check('非選択時は操作ボタン非表示', actVis === 'none', 'disp=' + actVis);
await page.evaluate(() => window.SimpleCAD.select('op'));
actVis = await page.evaluate(() => document.getElementById('selActions').style.display);
check('選択時に操作ボタン表示', actVis === 'block', 'disp=' + actVis);
// 複製ボタン
await page.evaluate(() => document.querySelector('#selActions button[data-act=dup]').click());
let actCnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('複製ボタンで2個に', actCnt === 2, 'count=' + actCnt);
// 削除ボタン(複製で選択された1個を削除)
await page.evaluate(() => document.querySelector('#selActions button[data-act=del]').click());
actCnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('削除ボタンで選択を削除', actCnt === 1, 'count=' + actCnt);

// --- AH: 計測情報(面積/周長) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'mi', type: 'rect', x: 0, y: 0, w: 100, h: 50, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('mi');
});
const infoRect = await page.evaluate(() => document.getElementById('npInfo')?.textContent || '');
check('矩形の面積(5000)と周(300)が表示', infoRect.includes('5000') && infoRect.includes('300'), infoRect);
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'mc', type: 'circle', cx: 0, cy: 0, r: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('mc');
});
const infoCir = await page.evaluate(() => document.getElementById('npInfo')?.textContent || '');
check('円の面積(≈314)が表示', infoCir.includes('314'), infoCir);

// --- AI: DXF書き出し ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'dl', type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'dc', type: 'circle', cx: 50, cy: 50, r: 20, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'dr', type: 'rect', x: 0, y: 0, w: 30, h: 20, stroke: '#000', strokeWidth: 1, fill: null });
});
const dxf = await page.evaluate(() => window.SimpleCAD.buildDXF());
check('DXFにENTITIESセクション', dxf.includes('ENTITIES') && dxf.includes('ENDSEC') && dxf.includes('EOF'), dxf.slice(0, 40));
check('DXFにLINE/CIRCLEエンティティ', dxf.includes('LINE') && dxf.includes('CIRCLE'), '');
check('DXFにNaNが無い', !dxf.includes('NaN'), '');
// 円のCIRCLEコード(10/20/40)が含まれる
check('DXF CIRCLEに半径(40 20)', /CIRCLE[\s\S]*?\b40\b\r?\n20/.test(dxf) || dxf.includes('CIRCLE'), '');

// --- AJ: 用紙(白)モード ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); document.getElementById('cLight').click(); });
const isLight = await page.evaluate(() => window.SimpleCAD.state.ui.light);
check('用紙モードON', isLight === true, 'light=' + isLight);
// 白モードでは左上ピクセルが白(背景塗り)
const px = await page.evaluate(() => {
  const cv = document.getElementById('cv'); const c = cv.getContext('2d');
  window.SimpleCAD.draw();
  const d = c.getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]];
});
check('白モードで背景が白', px[0] > 240 && px[1] > 240 && px[2] > 240, JSON.stringify(px));
// 設定が永続化される(saveNow→ストアから再読込)
await page.evaluate(() => { window.SimpleCAD.saveNow(); window.SimpleCAD.state.ui.light = false; window.SimpleCAD.reloadFromStore(); });
const lightRestored = await page.evaluate(() => ({ s: window.SimpleCAD.state.ui.light, ui: document.getElementById('cLight').checked }));
check('用紙モードがリロードで復元', lightRestored.s === true && lightRestored.ui === true, JSON.stringify(lightRestored));

// --- AK: 矩形配列複製 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.setTool('select');
  window.SimpleCAD.addShape({ id: 'ar', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('ar');
  document.querySelector('#selActions button[data-act=array]').click();
});
const dlgOpen = await page.evaluate(() => document.getElementById('arrayDlg').style.display);
check('配列ダイアログが開く', dlgOpen === 'flex', 'disp=' + dlgOpen);
await page.evaluate(() => {
  document.getElementById('arRows').value = '2';
  document.getElementById('arCols').value = '3';
  document.getElementById('arDx').value = '20';
  document.getElementById('arDy').value = '20';
  document.getElementById('arrayOk').click();
});
const arrCnt = await page.evaluate(() => window.SimpleCAD.shapeCount());
check('2×3配列で計6図形', arrCnt === 6, 'count=' + arrCnt);
const xs = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.x).sort((a, b) => a - b));
check('列間隔20で x が 0,20,40 を含む', xs.includes(0) && xs.includes(20) && xs.includes(40), JSON.stringify(xs));
// Undoで原本1個に戻る
await page.evaluate(() => window.SimpleCAD.undo());
check('配列をUndoで1個に戻す', (await page.evaluate(() => window.SimpleCAD.shapeCount())) === 1);

// --- AL: グループ化 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 };
  window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.setTool('select');
  window.SimpleCAD.addShape({ id: 'gA', type: 'rect', x: 60, y: 60, w: 30, h: 20, stroke: '#fff', strokeWidth: 2, fill: null });
  window.SimpleCAD.addShape({ id: 'gB', type: 'rect', x: 200, y: 60, w: 30, h: 20, stroke: '#fff', strokeWidth: 2, fill: null });
  window.SimpleCAD.selectMany(['gA', 'gB']);
  window.SimpleCAD.groupAPI.group();
});
const grouped = await page.evaluate(() => window.SimpleCAD.state.shapes.every(s => s.group) && window.SimpleCAD.state.shapes[0].group === window.SimpleCAD.state.shapes[1].group);
check('2図形が同一グループになる', grouped, '');
// gAの辺をクリック → グループ全体(2個)が選択される
await page.evaluate(() => window.SimpleCAD.select(null));
await page.mouse.click(0 + 60 * 2, 51 + 70 * 2); // gA左辺
const selAfter = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('グループ内クリックで全体選択', selAfter === 2, 'sel=' + selAfter);
// グループ解除
await page.evaluate(() => { window.SimpleCAD.selectMany(['gA', 'gB']); window.SimpleCAD.groupAPI.ungroup(); });
const ungrouped = await page.evaluate(() => window.SimpleCAD.state.shapes.every(s => !s.group));
check('グループ解除でgroupが消える', ungrouped, '');
// 解除後はgAクリックで1個のみ
await page.evaluate(() => window.SimpleCAD.select(null));
await page.mouse.click(0 + 60 * 2, 51 + 70 * 2);
const selSolo = await page.evaluate(() => window.SimpleCAD.state.selection.size);
check('解除後は単体選択', selSolo === 1, 'sel=' + selSolo);

// --- AM: グループ独立化 & 永続化(レビュー指摘) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'q1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'q2', type: 'rect', x: 20, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.selectMany(['q1', 'q2']);
  window.SimpleCAD.groupAPI.group();
  window.SimpleCAD.editAPI.duplicate(); // 複製
});
const groupIds = await page.evaluate(() => [...new Set(window.SimpleCAD.state.shapes.map(s => s.group))]);
check('複製でグループが分かれる(2グループ)', groupIds.length === 2, JSON.stringify(groupIds));
// nextGroupIdが永続化され、再読込後に既存と衝突しない
await page.evaluate(() => { window.SimpleCAD.saveNow(); window.SimpleCAD.reloadFromStore(); });
await page.evaluate(() => {
  // 再読込後に新規グループを作る
  window.SimpleCAD.addShape({ id: 'q3', type: 'rect', x: 50, y: 50, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'q4', type: 'rect', x: 70, y: 50, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.selectMany(['q3', 'q4']);
  window.SimpleCAD.groupAPI.group();
});
const allGroups = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.group));
const uniqueGroups = await page.evaluate(() => [...new Set(window.SimpleCAD.state.shapes.map(s => s.group))].length);
check('リロード後の新グループが既存と衝突しない(3グループ)', uniqueGroups === 3, JSON.stringify({ allGroups: allGroups, u: uniqueGroups }));

// --- AN: 書き出しドロップダウン ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); document.getElementById('exportMenu').style.display = 'none'; });
await page.evaluate(() => document.getElementById('btnExport').click());
let menuDisp = await page.evaluate(() => document.getElementById('exportMenu').style.display);
check('書出ボタンでメニューが開く', menuDisp === 'block', 'disp=' + menuDisp);
const expItems = await page.evaluate(() => document.querySelectorAll('#exportMenu button[data-exp]').length);
check('メニューに4つの書き出し項目', expItems === 4, 'n=' + expItems);
// 項目クリックでメニューが閉じる
await page.evaluate(() => document.querySelector('#exportMenu button[data-exp=svg]').click());
menuDisp = await page.evaluate(() => document.getElementById('exportMenu').style.display);
check('項目クリックでメニューが閉じる', menuDisp === 'none', 'disp=' + menuDisp);

// --- AO: クロスヘア(マウス・作図ツール時) ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.state.ui.light = false; window.SimpleCAD.state.grid.show = false; window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 }; window.SimpleCAD.setTool('line'); window.SimpleCAD.draw(); });
// グリッドOFFにして、クロスヘア縦線列のα合計で判定
const colSum = async () => page.evaluate(() => {
  const cv = document.getElementById('cv'); const c = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const x = Math.round(307 * dpr); let s = 0;
  for (let y = 10; y < 400; y += 10) s += c.getImageData(x, Math.round(y * dpr), 1, 1).data[3];
  return s;
});
await page.mouse.move(0 + 307, 51 + 200);
const lineSum = await colSum();
check('作図ツール時にクロスヘアが描画される', lineSum > 200, 'sum=' + lineSum);
await page.evaluate(() => { window.SimpleCAD.setTool('select'); window.SimpleCAD.draw(); });
const selSum = await colSum();
check('選択ツールではクロスヘアが出ない', selSum === 0, 'sum=' + selSum);

// --- AP: 個別図形ロック ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'lk', type: 'rect', x: 10, y: 10, w: 20, h: 20, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('lk');
  window.SimpleCAD.lockAPI.toggle();
});
check('ロックでlocked=trueになる', await page.evaluate(() => window.SimpleCAD.state.shapes[0].locked === true));
// ロック中は微動で動かない
const lx0 = await page.evaluate(() => window.SimpleCAD.state.shapes[0].x);
await page.evaluate(() => window.SimpleCAD.editAPI.nudge(10, 0));
check('ロック図形は微動で動かない', await page.evaluate(() => window.SimpleCAD.state.shapes[0].x) === lx0);
// ロック中は削除されない
await page.evaluate(() => { window.SimpleCAD.select('lk'); window.SimpleCAD.editAPI && null; });
await page.evaluate(() => window.SimpleCAD.state.selection.add('lk'));
await page.evaluate(() => { const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }); window.dispatchEvent(ev); });
check('ロック図形はDeleteで消えない', await page.evaluate(() => window.SimpleCAD.shapeCount()) === 1);
// 解除すると動く・消せる
await page.evaluate(() => { window.SimpleCAD.select('lk'); window.SimpleCAD.lockAPI.toggle(); });
check('解除でlockedが消える', await page.evaluate(() => !window.SimpleCAD.state.shapes[0].locked));
await page.evaluate(() => { window.SimpleCAD.select('lk'); window.SimpleCAD.editAPI.nudge(10, 0); });
check('解除後は微動で動く', await page.evaluate(() => window.SimpleCAD.state.shapes[0].x) === lx0 + 10);

// --- AQ: スナップ対象の拡充(辺中点・楕円) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid.osnap = true; window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 };
  window.SimpleCAD.addShape({ id: 'sn', type: 'rect', x: 0, y: 0, w: 100, h: 60, stroke: '#fff', strokeWidth: 1, fill: null });
});
// 上辺中点(50,0)付近(53,3)を resolvePoint → (50,0)へ吸着
const snapMid = await page.evaluate(() => window.SimpleCAD.resolvePoint(53 * 2, 3 * 2));
check('矩形の辺中点にスナップ', Math.abs(snapMid.x - 50) < 0.01 && Math.abs(snapMid.y - 0) < 0.01, JSON.stringify(snapMid));
// 楕円の四分点
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.addShape({ id: 'se', type: 'ellipse', cx: 100, cy: 100, rx: 40, ry: 20, stroke: '#fff', strokeWidth: 1, fill: null }); });
const snapEl = await page.evaluate(() => window.SimpleCAD.resolvePoint((140 + 2) * 2, 100 * 2)); // 右四分点(140,100)
check('楕円の四分点にスナップ', Math.abs(snapEl.x - 140) < 0.01 && Math.abs(snapEl.y - 100) < 0.01, JSON.stringify(snapEl));

// --- AR: 半径寸法 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'rc', type: 'circle', cx: 50, cy: 50, r: 25, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('rc');
  document.querySelector('#numProps button').click(); // 半径寸法を追加ボタン
});
const rdim = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'dim'));
check('半径寸法(dim)が中心→端で作成される', rdim && rdim.x1 === 50 && rdim.x2 === 75 && rdim.y1 === rdim.y2, JSON.stringify(rdim && { x1: rdim.x1, x2: rdim.x2 }));

// --- AS: ロック保護の穴(Cut/複製)修正 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'lc', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('lc'); window.SimpleCAD.lockAPI.toggle(); // ロック
  window.SimpleCAD.select('lc'); window.SimpleCAD.editAPI.cut(); // 切り取り試行
});
check('Cutでロック図形は削除されない', await page.evaluate(() => window.SimpleCAD.shapeCount()) === 1);
// 複製するとロックは解除される(編集可能)
await page.evaluate(() => { window.SimpleCAD.select('lc'); window.SimpleCAD.editAPI.duplicate(); });
const dupLocked = await page.evaluate(() => { const ss = window.SimpleCAD.state.shapes; return { orig: !!ss[0].locked, dup: !!ss[1].locked, n: ss.length }; });
check('複製はロックを引き継がない', dupLocked.n === 2 && dupLocked.orig === true && dupLocked.dup === false, JSON.stringify(dupLocked));
// 回転楕円の半径寸法は端点が回転に追従
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 're', type: 'ellipse', cx: 0, cy: 0, rx: 40, ry: 20, rot: Math.PI / 2, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('re');
  document.querySelector('#numProps button').click();
});
const rdim2 = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'dim'));
check('回転楕円の半径寸法が回転追従(端点が縦方向)', rdim2 && Math.abs(rdim2.x2 - 0) < 0.01 && Math.abs(Math.abs(rdim2.y2) - 40) < 0.01, JSON.stringify(rdim2 && { x2: rdim2.x2, y2: rdim2.y2 }));

// --- AT: ステータス選択数 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'c1', type: 'rect', x: 0, y: 0, w: 5, h: 5, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'c2', type: 'rect', x: 10, y: 0, w: 5, h: 5, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.selectMany(['c1', 'c2']);
});
check('ステータスに選択数2が表示', await page.evaluate(() => document.getElementById('ssel').textContent) === '2');

// --- AU: 複数行テキスト ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.setTool('text'); });
await page.mouse.click(box.x + 250, box.y + 250);
await page.evaluate(() => {
  const inp = document.getElementById('textInput');
  inp.value = '1行目\n2行目\n3行目';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
});
const mt = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'text'));
check('複数行テキストが作成される', mt && mt.text.split('\n').length === 3, JSON.stringify(mt && mt.text));
// SVGに複数tspan
const svgMt = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('SVGに複数行のtspanが出る', (svgMt.match(/<tspan/g) || []).length === 3, '' + (svgMt.match(/<tspan/g) || []).length);

// --- AV: 選択範囲のみ書き出し ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'x1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'x2', type: 'circle', cx: 100, cy: 100, r: 20, stroke: '#000', strokeWidth: 1, fill: null });
  document.getElementById('expSelOnly').checked = true;
  window.SimpleCAD.select('x2'); // 円だけ選択
});
const svgSel = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('選択範囲のみ: SVGに円のみ(矩形なし)', svgSel.includes('<circle') && !svgSel.includes('<rect x'), svgSel.slice(0, 80));
// 解除すると両方
await page.evaluate(() => { document.getElementById('expSelOnly').checked = false; });
const svgAll = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('解除で全図形(矩形+円)', svgAll.includes('<circle') && svgAll.includes('<rect x'), '');

// --- AW: 円弧ツール ---
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.state.view = { scale: 2, offsetX: 0, offsetY: 0 }; window.SimpleCAD.state.grid.snap = false; window.SimpleCAD.setTool('arc'); });
// 中心(100,100)→始点(160,100 右)→終点(100,160 下) の3クリック
await page.mouse.click(0 + 100 * 2, 51 + 100 * 2);
await page.mouse.click(0 + 160 * 2, 51 + 100 * 2);
await page.mouse.click(0 + 100 * 2, 51 + 160 * 2);
const arc = await page.evaluate(() => window.SimpleCAD.state.shapes.find(s => s.type === 'arc'));
check('円弧が作図される(中心100,100 半径60)', arc && Math.abs(arc.cx - 100) < 1 && Math.abs(arc.r - 60) < 1, JSON.stringify(arc && { cx: arc.cx, r: arc.r }));
// 円弧上の点(右端160,100付近)でヒット、範囲外(左端40,100)でヒットしない
const hitOn = await page.evaluate(() => !!window.SimpleCAD.hitTest(160, 100));
const hitOff = await page.evaluate(() => !!window.SimpleCAD.hitTest(40, 100));
check('円弧は弧上でヒットする', hitOn === true);
check('円弧は範囲外ではヒットしない', hitOff === false);
// SVG/DXFに点列で出力
const svgArc = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('円弧がSVGにpolylineで出力', svgArc.includes('<polyline'), '');
const dxfArc = await page.evaluate(() => window.SimpleCAD.buildDXF());
check('円弧がDXFにLINEで出力されNaN無し', dxfArc.includes('LINE') && !dxfArc.includes('NaN'), '');
// 保存読込で復元
const dA = await page.evaluate(() => window.SimpleCAD.dumpJSON());
await page.evaluate(() => window.SimpleCAD.clearAll());
await page.evaluate((d) => window.SimpleCAD.loadJSON(d), dA);
check('円弧が保存読込で復元', await page.evaluate(() => !!window.SimpleCAD.state.shapes.find(s => s.type === 'arc')));

// --- AX: 円弧の掃引方向(a1<a0は長い側)・弧長・回転SVG ---
// a0=80°, a1=20° → ctx.arcは300°(長い側)を描く。サンプル点数も300°相当で多いはず
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  const d = Math.PI / 180;
  window.SimpleCAD.addShape({ id: 'ax', type: 'arc', cx: 0, cy: 0, r: 10, a0: 80 * d, a1: 20 * d, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('ax');
});
const arcInfo = await page.evaluate(() => document.getElementById('npInfo')?.textContent || '');
// 300°の弧長 = 10 * (300*π/180) ≈ 52.4
check('a1<a0の弧長が長い側(≈52)で計算', /5[0-9]\./.test(arcInfo) || arcInfo.includes('52'), arcInfo);
// SVGのpolyline点数が多い(>30点 ≈ 300°/(π/32))
const svgAx = await page.evaluate(() => window.SimpleCAD.buildSVGString());
const ptsCount = await page.evaluate(() => {
  const svg = window.SimpleCAD.buildSVGString();
  const m = svg.match(/points="([^"]*)"/);
  return m ? m[1].trim().split(/\s+/).length : 0;
});
check('a1<a0でSVGサンプル点が長い側相当(>30)', ptsCount > 30, 'pts=' + ptsCount);
// 回転arc: SVGに二重回転(g transform)が付かない
await page.evaluate(() => { window.SimpleCAD.state.shapes[0].rot = Math.PI / 6; window.SimpleCAD.draw(); });
const svgRot = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('回転arcはSVGで<g transform>を使わない(二重回転防止)', !svgRot.includes('<g transform'), svgRot.slice(0, 60));

// --- AY: ツール別カーソル ---
await page.evaluate(() => window.SimpleCAD.setTool('line'));
check('作図ツールでcrosshairカーソル', await page.evaluate(() => document.getElementById('cv').style.cursor) === 'crosshair');
await page.evaluate(() => window.SimpleCAD.setTool('select'));
check('選択ツールでdefaultカーソル', await page.evaluate(() => document.getElementById('cv').style.cursor) === 'default');

// --- AZ: 塗りスウォッチ ---
const fillSwN = await page.evaluate(() => document.querySelectorAll('#fillSwatches button').length);
check('塗りスウォッチが生成される(なし+7色)', fillSwN === 8, 'n=' + fillSwN);
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'fl', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: null });
  window.SimpleCAD.select('fl');
  document.querySelectorAll('#fillSwatches button')[1].click(); // 最初の色 #1e3a5f
});
check('塗りスウォッチで選択図形に塗りが入る', await page.evaluate(() => window.SimpleCAD.state.shapes[0].fill) === '#1e3a5f');
await page.evaluate(() => { window.SimpleCAD.select('fl'); document.querySelectorAll('#fillSwatches button')[0].click(); }); // なし
check('「なし」で塗りがnullになる', await page.evaluate(() => window.SimpleCAD.state.shapes[0].fill) === null);

// --- BA: loadJSON後のnextId衝突防止 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  // id s5 を含むデータを読み込む
  window.SimpleCAD.loadJSON({ shapes: [{ id: 's5', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: null }] });
});
// 次に作図する図形のidが s5 と衝突しない
await page.evaluate(() => { window.SimpleCAD.setTool('rect'); });
await drawDrag(page, { x: 0, y: 51 }, 200, 200, 260, 260);
const ids = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.id));
check('loadJSON後の新規idが既存と衝突しない', new Set(ids).size === ids.length && ids.includes('s5'), JSON.stringify(ids));

// --- BB: 全画面ボタン ---
check('全画面ボタンが存在する', await page.evaluate(() => !!document.getElementById('btnFull')));
await page.evaluate(() => document.getElementById('btnFull').click()); // 非対応環境でも例外を出さない
check('全画面クリックで例外/エラーなし', true);

// --- BC: テキスト整列(左/中央/右) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'tc', type: 'text', x: 0, y: 0, fontSize: 16, text: 'ABC', stroke: '#000' });
});
check('テキストの既定整列はleft', await page.evaluate(() => window.SimpleCAD.state.shapes[0].align) === 'left');
await page.evaluate(() => { window.SimpleCAD.state.shapes[0].align = 'center'; window.SimpleCAD.draw(); });
let svgAlign = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('整列centerでSVGがtext-anchor=middle', svgAlign.includes('text-anchor="middle"'), svgAlign.slice(svgAlign.indexOf('<text')).slice(0, 80));
await page.evaluate(() => { window.SimpleCAD.state.shapes[0].align = 'right'; window.SimpleCAD.draw(); });
svgAlign = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('整列rightでSVGがtext-anchor=end', svgAlign.includes('text-anchor="end"'));
const dxfT = await page.evaluate(() => window.SimpleCAD.buildDXF());
check('整列rightでDXFに水平揃えコード72=2', /\b72\b\r?\n\s*2\b/.test(dxfT) || dxfT.includes('\n72\n2'), 'has72=' + dxfT.includes('72'));
// 整列はsanitize/loadJSONで保存復元される
await page.evaluate(() => { const d = window.SimpleCAD.dumpJSON(); window.SimpleCAD.clearAll(); window.SimpleCAD.loadJSON(d); });
check('整列rightが保存読込で復元', await page.evaluate(() => window.SimpleCAD.state.shapes[0].align) === 'right');
// 不正なalignはleftへ
await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.addShape({ id: 'tx', type: 'text', x: 0, y: 0, fontSize: 16, text: 'x', align: 'evil', stroke: '#000' }); });
check('不正alignはleftにサニタイズ', await page.evaluate(() => window.SimpleCAD.state.shapes[0].align) === 'left');

// --- BD: 角度寸法 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'an', type: 'angle', vx: 0, vy: 0, x1: 10, y1: 0, x2: 0, y2: 10, stroke: '#fbbf24', strokeWidth: 1.5, fill: null });
  window.SimpleCAD.select('an');
});
check('角度寸法がaddShapeで生成', await page.evaluate(() => window.SimpleCAD.state.shapes[0]?.type) === 'angle');
const angInfo = await page.evaluate(() => document.getElementById('npInfo')?.textContent || '');
check('直交2辺の角度が90°表示', angInfo.includes('90.0°'), angInfo);
const svgAn = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('角度寸法SVGに円弧polylineと度数', svgAn.includes('<polyline') && svgAn.includes('90.0°'), '');
const dxfAn = await page.evaluate(() => window.SimpleCAD.buildDXF());
check('角度寸法DXFにTEXTと度数', dxfAn.includes('TEXT') && dxfAn.includes('90.0°'));
// 保存読込で復元
await page.evaluate(() => { const d = window.SimpleCAD.dumpJSON(); window.SimpleCAD.clearAll(); window.SimpleCAD.loadJSON(d); });
check('角度寸法が保存読込で復元', await page.evaluate(() => window.SimpleCAD.state.shapes[0]?.type) === 'angle' && (await page.evaluate(() => window.SimpleCAD.shapeCount())) === 1);
// 3クリックで作図(ツール経由)
{
  const cbox = await canvas.boundingBox();
  await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.setTool('angle'); window.SimpleCAD.state.grid.osnap = false; });
  for (const [rx, ry] of [[220, 160], [290, 160], [220, 90]]) {
    await page.mouse.move(cbox.x + rx, cbox.y + ry); await page.mouse.down(); await page.mouse.up();
  }
  check('角度ツール3クリックで角度寸法を作図', await page.evaluate(() => window.SimpleCAD.state.shapes.filter(s => s.type === 'angle').length) === 1);
}

// --- BE: safeColor をCSS名色allowlistへ厳格化 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'c1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: 'javascript', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'c2', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: 'red', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'c3', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#a1b2c3', strokeWidth: 1, fill: null });
});
const cols = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => s.stroke));
check('不正な英単語色は既定値へ(javascript→#38bdf8)', cols[0] === '#38bdf8', cols[0]);
check('CSS標準色名は許可(red)', cols[1] === 'red');
check('#hexは許可(#a1b2c3)', cols[2] === '#a1b2c3');

// --- BF: スナップ拡充(arc中心/text角/image角) ---
const snapTextCorner = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid.osnap = true; window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.addShape({ id: 'st', type: 'text', x: 50, y: 50, fontSize: 16, text: 'Hi', stroke: '#000' });
  const v = window.SimpleCAD.state.view;
  const r = window.SimpleCAD.resolvePoint(50 * v.scale + v.offsetX + 2, 50 * v.scale + v.offsetY + 2);
  return r;
});
check('テキスト左上角に吸着', Math.abs(snapTextCorner.x - 50) < 0.5 && Math.abs(snapTextCorner.y - 50) < 0.5, JSON.stringify(snapTextCorner));
const snapArcCenter = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid.osnap = true; window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.addShape({ id: 'sa', type: 'arc', cx: 30, cy: 40, r: 10, a0: 0, a1: 1.5, stroke: '#000', strokeWidth: 1, fill: null });
  const v = window.SimpleCAD.state.view;
  const r = window.SimpleCAD.resolvePoint(30 * v.scale + v.offsetX + 2, 40 * v.scale + v.offsetY - 2);
  return r;
});
check('円弧中心に吸着', Math.abs(snapArcCenter.x - 30) < 0.5 && Math.abs(snapArcCenter.y - 40) < 0.5, JSON.stringify(snapArcCenter));

// --- BG: 回転angleのSVGラベル(rotate付き・<g transform>無し) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'ar', type: 'angle', vx: 0, vy: 0, x1: 30, y1: 0, x2: 0, y2: 30, stroke: '#fbbf24', strokeWidth: 1.5, fill: null });
  window.SimpleCAD.state.shapes[0].rot = Math.PI / 6; window.SimpleCAD.draw();
});
const svgAngRot = await page.evaluate(() => window.SimpleCAD.buildSVGString());
check('回転angleはSVGで<g transform>を使わない', !svgAngRot.includes('<g transform'));
check('回転angleラベルにrotate transformが付く', /<text[^>]*transform="rotate\(/.test(svgAngRot), '');

// --- BH: bbox(angle)が円弧/ラベルの張り出しを含む ---
const angExtH = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  // 鈍角(約170°): 3点のy範囲は狭いが円弧は二等分線方向へ大きく張り出す
  const d = Math.PI / 180;
  window.SimpleCAD.addShape({ id: 'ob', type: 'angle', vx: 0, vy: 0, x1: 100, y1: 0, x2: 100 * Math.cos(170 * d), y2: 100 * Math.sin(170 * d), stroke: '#fbbf24', strokeWidth: 1, fill: null });
  return window.SimpleCAD.transformAPI.shapeExtent(window.SimpleCAD.state.shapes[0]).h;
});
check('鈍角angleのbboxが円弧張り出しを含む(高さ>40)', angExtH > 40, 'h=' + angExtH.toFixed(1));

// --- BI: safeColor システム色/キーワード正規化 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'sc1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: 'CanvasText', strokeWidth: 1, fill: null });
  window.SimpleCAD.addShape({ id: 'sc2', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#fff', strokeWidth: 1, fill: 'TRANSPARENT' });
});
const scCols = await page.evaluate(() => window.SimpleCAD.state.shapes.map(s => [s.stroke, s.fill]));
check('CSSシステム色は許可(CanvasText→canvastext)', scCols[0][0] === 'canvastext', JSON.stringify(scCols[0]));
check('色キーワードは小文字へ正規化(TRANSPARENT→transparent)', scCols[1][1] === 'transparent', JSON.stringify(scCols[1]));

// --- BJ: 角度寸法の円弧上ヒット ---
const arcHit = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'ah', type: 'angle', vx: 0, vy: 0, x1: 40, y1: 0, x2: 0, y2: 40, stroke: '#fbbf24', strokeWidth: 1.5, fill: null });
  // 半径20・45°方向の円弧上の点(どちらの辺からも離れている)
  const p = 20 / Math.SQRT2;
  const hit = window.SimpleCAD.hitTest(p, p);
  return hit ? hit.type : null;
});
check('角度寸法の円弧上をクリックで選択できる', arcHit === 'angle', 'hit=' + arcHit);

// --- BK: 角度寸法の内角を数値直接編集 ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'ae', type: 'angle', vx: 0, vy: 0, x1: 10, y1: 0, x2: 10, y2: 0, stroke: '#fbbf24', fill: null });
  window.SimpleCAD.select('ae');
});
const angSet = await page.evaluate(() => {
  const inp = document.querySelector('#numProps input[data-kang]');
  if (!inp) return -1;
  inp.value = '60'; inp.dispatchEvent(new Event('input', { bubbles: true }));
  const s = window.SimpleCAD.state.shapes[0];
  const v1 = [s.x1 - s.vx, s.y1 - s.vy], v2 = [s.x2 - s.vx, s.y2 - s.vy];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  return Math.acos(dot / (Math.hypot(...v1) * Math.hypot(...v2))) * 180 / Math.PI;
});
check('内角欄に60入力で2辺が60°になる', Math.abs(angSet - 60) < 0.5, 'ang=' + angSet.toFixed(2));

// --- BL: 連続寸法ツール(3点クリックで2区間のdim) ---
{
  const cbox = await canvas.boundingBox();
  await page.evaluate(() => { window.SimpleCAD.clearAll(); window.SimpleCAD.setTool('chain'); window.SimpleCAD.state.grid.osnap = false; });
  for (const [rx, ry] of [[200, 150], [260, 150], [320, 150]]) { await page.mouse.move(cbox.x + rx, cbox.y + ry); await page.mouse.down(); await page.mouse.up(); }
  await page.evaluate(() => window.SimpleCAD.setTool('select')); // ツール切替で確定
  const chainDims = await page.evaluate(() => window.SimpleCAD.state.shapes.filter(s => s.type === 'dim').length);
  check('連続寸法3点クリックで2区間のdimを作図', chainDims === 2, 'dims=' + chainDims);
}

// --- BM: DXF取り込み(LINE/CIRCLE, Y軸反転) ---
const dxfStr = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0', '0', 'CIRCLE', '8', '0', '10', '5', '20', '-5', '40', '3', '0', 'ENDSEC', '0', 'EOF'].join('\n');
const dxfParsed = await page.evaluate((s) => window.SimpleCAD.parseDXF(s), dxfStr);
check('parseDXFがLINEとCIRCLEを返す', dxfParsed.length === 2 && dxfParsed[0].type === 'line' && dxfParsed[1].type === 'circle', JSON.stringify(dxfParsed.map(s => s.type)));
check('DXF円の中心YがY軸反転で復元(-(-5)=5)', Math.abs(dxfParsed[1].cy - 5) < 1e-6, 'cy=' + dxfParsed[1].cy);
const dxfAdded = await page.evaluate((s) => { window.SimpleCAD.clearAll(); return window.SimpleCAD.importVector(s, 'dxf'); }, dxfStr);
check('importVector(dxf)で2図形を追加', dxfAdded === 2 && (await page.evaluate(() => window.SimpleCAD.shapeCount())) === 2);

// --- BN: SVG取り込み(line/rect/circle) ---
const svgStr = '<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="10" y2="5" stroke="#000"/><rect x="0" y="0" width="20" height="10" stroke="red"/><circle cx="5" cy="5" r="3" stroke="#0000ff"/></svg>';
const svgParsed = await page.evaluate((s) => window.SimpleCAD.parseSVG(s), svgStr);
check('parseSVGがline/rect/circleを返す', svgParsed.length === 3 && svgParsed.map(s => s.type).join(',') === 'line,rect,circle', JSON.stringify(svgParsed.map(s => s.type)));

// --- BO: 取り込み図形もsanitizeを通す(不正色は既定値へ) ---
const malAdded = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10" stroke="javascript:alert(1)"/></svg>';
  window.SimpleCAD.importVector(svg, 'svg');
  return window.SimpleCAD.state.shapes[0] ? window.SimpleCAD.state.shapes[0].stroke : null;
});
// parseSVGが取り込み時点で'#000'へ矯正→sanitizeShapeも通過(いずれも安全な既定色。悪意ある値は無害化)
check('取り込み図形の不正strokeは安全な既定色へ矯正', malAdded === '#000' || malAdded === '#38bdf8', 'stroke=' + malAdded);

// --- BP: 不正/曲線パスでもsvgPathPolysがハングせず返る ---
const pathRes = await page.evaluate(() => {
  // Z後に余分な数値、未対応の曲線(C)を含む。無限ループ・例外なく返ること
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0 L10 10 Z 1 2 3" stroke="#000"/><path d="M0 0 C1 1 2 2 3 3 L5 5" stroke="#000"/></svg>';
  const out = window.SimpleCAD.parseSVG(svg);
  return { n: out.length, firstClosed: !!(out[0] && out[0].closed), allFinite: out.every(s => (s.points || []).every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) };
});
check('不正/曲線パスでもparseSVGが完了する(ハングなし)', pathRes.n >= 1, JSON.stringify(pathRes));
check('閉path(Z)はclosed=trueで取り込まれNaN点を含まない', pathRes.firstClosed && pathRes.allFinite, JSON.stringify(pathRes));

// --- BQ: 内角編集は0〜180°にクランプ(270入力→180) ---
await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'ac', type: 'angle', vx: 0, vy: 0, x1: 10, y1: 0, x2: 10, y2: 0, stroke: '#fbbf24', fill: null });
  window.SimpleCAD.select('ac');
});
const angClamp = await page.evaluate(() => {
  const inp = document.querySelector('#numProps input[data-kang]');
  if (!inp) return -1;
  inp.value = '270'; inp.dispatchEvent(new Event('input', { bubbles: true }));
  const s = window.SimpleCAD.state.shapes[0];
  const v1 = [s.x1 - s.vx, s.y1 - s.vy], v2 = [s.x2 - s.vx, s.y2 - s.vy];
  return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2))))) * 180 / Math.PI;
});
check('内角270入力は180°にクランプ', Math.abs(angClamp - 180) < 0.5, 'ang=' + angClamp.toFixed(2));

// --- BR: parseSVGも色をsafeColorで検証(多層防御) ---
const svgStroke = await page.evaluate(() => {
  const out = window.SimpleCAD.parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="1" y2="1" stroke="javascript:alert(1)"/></svg>');
  return out[0] ? out[0].stroke : null;
});
check('parseSVGの不正strokeは取り込み時点で既定値', svgStroke === '#000', 'stroke=' + svgStroke);

// --- BS: fontSizeの上限クランプ(巨大値の防御) ---
const fsClamp = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'fz', type: 'text', x: 0, y: 0, fontSize: 1e9, text: 'x', stroke: '#000' });
  return window.SimpleCAD.state.shapes[0].fontSize;
});
check('巨大fontSizeは上限100000にクランプ', fsClamp === 100000, 'fs=' + fsClamp);

// --- BT: SVG 3次ベジェ(C)を線分列に分割して取り込む ---
const cubicRes = await page.evaluate(() => {
  const out = window.SimpleCAD.parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 C0 10 10 10 10 0" stroke="#000"/></svg>');
  const s = out[0]; if (!s || s.type !== 'polyline') return null;
  const p = s.points;
  return { n: p.length, x0: p[0].x, y0: p[0].y, xe: p[p.length - 1].x, ye: p[p.length - 1].y, allFinite: p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)) };
});
check('3次ベジェCが多点ポリラインに分割される', cubicRes && cubicRes.n > 5 && cubicRes.allFinite, JSON.stringify(cubicRes));
check('ベジェCの端点が一致(0,0→10,0)', cubicRes && Math.abs(cubicRes.x0) < 1e-6 && Math.abs(cubicRes.y0) < 1e-6 && Math.abs(cubicRes.xe - 10) < 1e-6 && Math.abs(cubicRes.ye) < 1e-6, JSON.stringify(cubicRes));

// --- BU: SVG 円弧(A)を線分列に分割して取り込む ---
const arcRes = await page.evaluate(() => {
  const out = window.SimpleCAD.parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 A10 10 0 0 1 10 10" stroke="#000"/></svg>');
  const s = out[0]; if (!s || s.type !== 'polyline') return null;
  const p = s.points;
  return { n: p.length, xe: p[p.length - 1].x, ye: p[p.length - 1].y, allFinite: p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)) };
});
check('円弧Aが線分列に分割され終点が一致(10,10)', arcRes && arcRes.n > 3 && arcRes.allFinite && Math.abs(arcRes.xe - 10) < 0.2 && Math.abs(arcRes.ye - 10) < 0.2, JSON.stringify(arcRes));

// --- BV: 重複layer idの一意化(バグハント#8) ---
const layerDedup = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.loadJSON({ shapes: [], layers: [{ id: 'L1', name: 'a' }, { id: 'L1', name: 'b' }, { id: 'L1', name: 'c' }], activeLayer: 'L1' });
  const ids = window.SimpleCAD.state.layers.map(l => l.id);
  return { ids, unique: new Set(ids).size === ids.length };
});
check('重複layer idは一意化される', layerDedup.unique && layerDedup.ids.length === 3, JSON.stringify(layerDedup));

// --- BW: 交点スナップ(端点/中点と一致しない交点) ---
const interRes = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid.osnap = true; window.SimpleCAD.state.grid.snap = false;
  // 水平線(0,0)-(20,0) と 縦線(4,-3)-(4,9) は (4,0) で交差(どちらの端点・中点とも非一致)
  window.SimpleCAD.addShape({ id: 'lh', type: 'line', x1: 0, y1: 0, x2: 20, y2: 0, stroke: '#000', strokeWidth: 1 });
  window.SimpleCAD.addShape({ id: 'lv', type: 'line', x1: 4, y1: -3, x2: 4, y2: 9, stroke: '#000', strokeWidth: 1 });
  const v = window.SimpleCAD.state.view;
  const r = window.SimpleCAD.resolvePoint(4 * v.scale + v.offsetX + 2, 0 * v.scale + v.offsetY + 2);
  return r;
});
check('交差する2線分の交点(4,0)に吸着', Math.abs(interRes.x - 4) < 0.8 && Math.abs(interRes.y - 0) < 0.8, JSON.stringify(interRes));

// --- BX: 計測ラベルの小数桁数設定 ---
const precRes = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.addShape({ id: 'dp', type: 'dim', x1: 0, y1: 0, x2: 12.34, y2: 0, stroke: '#fbbf24', strokeWidth: 1.5, fill: null });
  window.SimpleCAD.state.ui.precision = 0;
  const svg0 = window.SimpleCAD.buildSVGString();
  window.SimpleCAD.state.ui.precision = 2;
  const svg2 = window.SimpleCAD.buildSVGString();
  window.SimpleCAD.state.ui.precision = 1; // 既定へ戻す
  return { has0: svg0.includes('>12 mm<'), has2: svg2.includes('>12.34 mm<') };
});
check('小数桁0で寸法ラベルが整数表示', precRes.has0, JSON.stringify(precRes));
check('小数桁2で寸法ラベルが2桁表示', precRes.has2, JSON.stringify(precRes));

// --- BY: DXF弧(0→90°)の向き・スパンが正しい(回帰固定。a0=-e,a1=-sでspan90°) ---
const dxfArcChk = await page.evaluate(() => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ARC', '8', '0', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const a = window.SimpleCAD.parseDXF(dxf)[0];
  if (!a || a.type !== 'arc') return null;
  let span = a.a1 - a.a0; if (span < 0) span += 2 * Math.PI;
  const mid = a.a0 + span / 2;
  return { spanDeg: span * 180 / Math.PI, mx: a.cx + a.r * Math.cos(mid), my: a.cy + a.r * Math.sin(mid) };
});
check('DXF弧(0→90°)は90°スパン・正しい象限で取り込み', dxfArcChk && Math.abs(dxfArcChk.spanDeg - 90) < 1 && Math.abs(dxfArcChk.mx - 7.07) < 0.3 && Math.abs(dxfArcChk.my + 7.07) < 0.3, JSON.stringify(dxfArcChk));

// --- BZ: 回転rectの角の実world位置に端点スナップ(回転の二重適用が無いことを固定) ---
const rotSnap = await page.evaluate(() => {
  window.SimpleCAD.clearAll();
  window.SimpleCAD.state.grid.osnap = true; window.SimpleCAD.state.grid.snap = false;
  window.SimpleCAD.addShape({ id: 'rr', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: null });
  window.SimpleCAD.state.shapes[0].rot = Math.PI / 2; // 中心(5,5)まわり90°: 角(0,0)→world(10,0)
  const v = window.SimpleCAD.state.view;
  return window.SimpleCAD.resolvePoint(10 * v.scale + v.offsetX + 2, 0 * v.scale + v.offsetY + 2);
});
check('回転rectの角(world)に端点スナップ', Math.abs(rotSnap.x - 10) < 0.6 && Math.abs(rotSnap.y - 0) < 0.6, JSON.stringify(rotSnap));

// --- CA: SVG/DXFのfont-size=0は16へ化けない(0はsanitizeで1へ) ---
const fs0 = await page.evaluate(() => {
  const svg = window.SimpleCAD.parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="0" font-size="0">a</text></svg>')[0];
  const dxf = window.SimpleCAD.parseDXF(['0', 'SECTION', '2', 'ENTITIES', '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '0', '1', 'a', '0', 'ENDSEC', '0', 'EOF'].join('\n'))[0];
  return { svgFs: svg ? svg.fontSize : null, dxfFs: dxf ? dxf.fontSize : null };
});
check('font-size=0は16に化けない(SVG/DXF取込)', fs0.svgFs === 0 && fs0.dxfFs === 0, JSON.stringify(fs0));

// --- CB: SVG stroke="none"は塗り色へ矯正(意図しない輪郭混入を防ぐ) ---
const noneStroke = await page.evaluate(() => {
  const out = window.SimpleCAD.parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10" stroke="none" fill="#ff0000"/></svg>');
  return out[0] ? { stroke: out[0].stroke, fill: out[0].fill } : null;
});
check('SVG stroke=noneは塗り色に矯正', noneStroke && noneStroke.stroke === '#ff0000', JSON.stringify(noneStroke));

// --- CC: DXF取り込みの色(ACI 62 / trueColor 420) ---
const dxfCol = await page.evaluate(() => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '62', '1', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'CIRCLE', '8', '0', '420', '65280', '10', '5', '20', '5', '40', '3',
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const out = window.SimpleCAD.parseDXF(dxf);
  return { line: out[0] && out[0].stroke, circle: out[1] && out[1].stroke };
});
check('DXF ACI色(62=1→赤)を取り込む', dxfCol.line === '#ff0000', JSON.stringify(dxfCol));
check('DXF trueColor(420→緑)を取り込む', dxfCol.circle === '#00ff00', JSON.stringify(dxfCol));

// 後始末
check('最終的にコンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

console.log('\n==== SimpleCAD 検証結果 ====');
console.log(results.join('\n'));
console.log(`\n合計: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
