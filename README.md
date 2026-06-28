# SimpleCAD — ブラウザ簡易CAD

スマホでもPCでも使える、ランタイム依存ゼロの**単一HTMLファイル**製2D CADです。
`index.html` をブラウザで開くだけで動きます（インストール・サーバー不要）。

🔗 公開版: **https://machaniconico.github.io/simple-cad/**
（スマホのブラウザで開き、ホーム画面に追加すればオフラインでもアプリのように使えます＝PWA対応）

## 使い方

`index.html` をダブルクリック、またはブラウザにドラッグして開くだけです。
スマホでは上記URLを開くか、ファイルをクラウド/ローカルに置いてブラウザで開いてください。

## 作図ツール（左パレット）
| アイコン | 機能 | キー |
|---|---|---|
| 🖱 選択 | 選択・移動。範囲ドラッグ/Shiftクリックで複数選択。単一選択時は回転・リサイズハンドル | V |
| ／ 線 | 線分（Shiftで0/45/90°拘束） | L |
| ▭ 矩形 | 矩形（Shiftで正方形） | R |
| ◯ 円 | 円 | C |
| ⬭ 楕円 | 楕円（Shiftで真円） | O |
| ⌒ 円弧 | 中心→始点→終点の3クリックで円弧 | — |
| ⏚ 連線 | ポリライン（始点付近で閉じる/確定ボタン/ダブルタップ終了） | P |
| ⬡ 多角 | 正多角形（辺数を右パネルで指定） | — |
| A 文字 | テキスト注記（ダブルクリックで編集／プロパティ欄で左・中央・右に整列） | T |
| ↔ 寸法 | 2点間距離をmm注記 | M |
| ∠ 角度 | 角度寸法。頂点→1辺目→2辺目の3クリックで内角を度数注記(プロパティ欄で内角を数値編集) | A |
| ⇿ 連寸 | 連続寸法。点を連続クリックし確定すると隣接区間をまとめて寸法化 | — |
| ⌫ 削除 | タップで削除 | E |

## ビュー操作
- **スマホ**: 2本指ピンチ→ズーム、2本指ドラッグ→パン。1本指で作図。
- **PC**: ホイールでズーム、スペース＋ドラッグ（または中ボタン）でパン。

## 編集
- **複数選択**: 空き場所をドラッグで範囲選択、Shift＋クリックで追加/解除、`Ctrl+A` で全選択。
- **移動**: 選択してドラッグ、または矢印キー（グリッド単位／Shiftで10倍）。`Alt+ドラッグ`で複製しながら移動。
- **コピー/切取/貼付/複製**: `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+D`。スマホは選択時の画面ボタン（複製/削除）で操作可。
- **変形**: 単一選択で四隅□=リサイズ、上部●=回転（グリッド吸着ON時15°スナップ）。タッチ時は判定を自動で広く。
- **整列・分布**: 複数選択で右パネルに整列UI（左右中央/上下中央揃え、横/縦の等間隔分布）。
- **重ね順**: 最前面/前面へ/背面へ/最背面。
- **配列複製**: 行×列・間隔を指定して並べて複製（▦配列）。
- **グループ化**: `Ctrl+G` / `Ctrl+Shift+G`。メンバークリックで一括選択・移動。
- **数値直接入力 & 計測**: 単一選択で座標・寸法・角度・本文・不透明度を編集、面積/長さ/周長を表示。
- **Undo/Redo**: `Ctrl+Z` / `Ctrl+Y`。`Delete` で削除。
- **ツール切替キー**: V/L/R/C/O/P/T/M/A/E、ヘルプは `?`。

## レイヤー（🗂 レイヤー）
- 追加／リネーム／表示・非表示（👁）／ロック（🔒）／アクティブ切替／削除。図形入りレイヤー削除は確認できます。
- 新規図形はアクティブレイヤーに作成。選択図形を現レイヤーへ移動（⇲）。
- 非表示レイヤーは描画・書き出し・選択の対象外。ロックレイヤーは編集不可。

## 入出力
- **保存/読込**: JSONでローカル保存・復元。保存JSONにはSimpleCAD形式識別子・単位（mm）・形式バージョンを含め、識別子/単位/バージョンを省略した旧データは読める一方、空/別形式・空/別単位・空/不正/未来バージョンは現在図面を保持したまま未対応として拒否します。既存図面があるときはJSON読込の上書き前に確認し、承認後の置き換えもUndo/Redoできます。確認ダイアログが利用できない場合は安全側にキャンセルします。ブラウザに自動保存され次回開くと復元（ビュー位置/倍率や設定も保持）。壊れた自動保存は隔離し、復旧時刻を通知しながら直前正常バックアップから復旧します。容量不足などで自動保存できない場合は常駐通知からJSON退避と再試行ができ、未解消の保存失敗がある状態での離脱も確認します。未対応ファイル形式は読み込み前に拒否し、空/壊れたファイル選択イベントやFileReader生成失敗は安全に無視/通知します。
- **取り込み（📥 取込）**: 外部 **DXF（R12中心・一部拡張）/ SVG** をパースして現在の図面に図形として追加（取り込み図形もサニタイズ適用）。SVGの曲線パス（C/S/Q/T/A）は線分近似で取り込み、`defs` / `symbol` 参照の `use` も展開（`viewBox` 付きsymbolは`preserveAspectRatio`を考慮して`width/height`へ配置）。ルート/入れ子`svg`の`x/y/viewBox`も子図形座標へ反映。座標・寸法・線幅・文字サイズは `mm` / `cm` / `in` / `pt` / `pc` / `q` などのSVG length単位も取り込み時に正規化。transformは祖先要素を含む `translate` / `scale` / `matrix` / `rotate` / `skewX` / `skewY` を座標へ反映し、テキストは `tspan` 座標/`dx`/`dy`、直書き文字と`tspan`の混在、非表示`tspan`除外、`xml:space`/`white-space`の空白保持、`text-anchor` の左端座標変換、baseline/`dominant-baseline`/`alignment-baseline` の上端座標変換、回転角も保持、軸平行で表現できない図形はポリライン近似で保持。`vector-effect:non-scaling-stroke` の線幅はtransform倍率を掛けずに保持。`display:none` / `visibility:hidden` / `opacity="0"` / 透明paint の非表示要素と、stroke無し/`stroke="none"`/`stroke-width="0"`の不可視な線・open path・open polylineは除外。線色・塗り（SVG既定の黒塗り含む）・gradient/pattern paint（代表色へ変換）・透明度（`opacity` / `stroke-opacity` / `fill-opacity`）・線幅・線種/位相（`stroke-dasharray` / `stroke-dashoffset`）・線端/線結合/角のmiter上限（`stroke-linecap` / `stroke-linejoin` / `stroke-miterlimit`）・文字サイズは属性、inline style（祖先`g`含む）、単純なtag/class/id/複合/子孫セレクタstyleから取り込み、CSS `!important` の優先度、`currentColor` / `color` 継承、`rgb()` / `rgba()` / `hsl()` / `hsla()` 色も安全な形式へ正規化。埋め込みラスタ画像（`data:image/...;base64`）は安全なものだけ画像図形として取り込み。stroke="none"は塗り色に矯正。DXFはエンティティ色（ACI/trueColor/ByLayerレイヤー色）、線幅（entity/LAYER lineweight）、線種（entity/LAYER/LTYPEを実線・破線・点線へ変換）、`HATCH` のpolyline/line/arc境界（複数外周を塗り付き閉ポリライン化）、`LWPOLYLINE` / `POLYLINE` のbulge円弧（線分近似）、`ELLIPSE` の全楕円/楕円弧、`SPLINE` のNURBS/fit point線分近似、`MLINE` の中心線ポリライン、`SHAPE` の記号名テキスト、`TOLERANCE` の幾何公差テキスト、`WIPEOUT` の白塗りマスクポリライン、`IMAGE` / `PDFUNDERLAY` / `DWFUNDERLAY` / `DGNUNDERLAY` / `OLE2FRAME` / `VIEWPORT` / `SECTION` の参照フットプリントとラベル、`MESH` のlevel 0 face/edge list投影、`HELIX` のXY投影ポリライン化、`MLEADER` / `MULTILEADER` の引出線・テキスト分解、`ACAD_TABLE` の表グリッド・セル文字分解、`LEADER` の直線/スプラインリーダーと矢羽根、`POINT` の点マーカー、`RAY` / `XLINE` の有限構築線フォールバック、ネストを含む `BLOCK` / `INSERT` の基点・倍率・回転展開、`ATTDEF` 既定値とINSERT付随 `ATTRIB` 文字、ByBlock/Layer0属性継承、レイヤー（同名の層へ割当、無ければ作成）も取り込み。
- **画像配置（🖼）**: PNG/JPEG/GIF/WebP/BMPの手書きスケッチや図面を読み込んで上からトレース（不透明度調整可）。SVGは「取込」からベクター図形として追加できます。
- **DXF HATCH補足**: edge境界のellipse/splineも線分近似で取り込み、gradient色は代表色へ単色化して塗り付き閉ポリラインとして扱います。
- **DXF SOLID/TRACE補足**: 4隅または三角形の塗り面を塗り付き閉ポリラインとして取り込みます。
- **DXF 3DFACE補足**: XY投影した面を塗り付きポリラインとして取り込み、不可視エッジフラグを可視線分に反映します。
- **DXF polyface mesh補足**: POLYLINE/VERTEX形式のpolyface meshを塗り面と可視エッジへ分解し、負の頂点番号による不可視エッジも反映します。
- **DXF LWPOLYLINE/POLYLINE幅補足**: constant widthや頂点ごとのstart/end widthはSimpleCADの単一線幅へ代表値として取り込み、BLOCK/INSERT倍率にも追従します。
- **DXF LAYER/visibility/space補足**: LAYERテーブルのOFF/フリーズ/ロック状態を、新規作成したDXF由来レイヤーの表示/ロックへ反映します。DXF書き出しでもレイヤーのOFF/ロック状態をLAYERテーブルへ出力します。図形単位のvisibility(code 60=1)は不可視エンティティとして取り込まず、model/paper space(code 67)が混在するDXFではmodel spaceを優先し、paper-only DXFは取り込みます。
- **DXF DIMENSION/LEADER補足**: 寸法の匿名ブロック表現を展開し、無い場合は線形/整列/半径/直径/角度寸法をSimpleCAD寸法線または角度寸法へ、座標寸法はリーダー線と座標値テキストへフォールバックします。LEADERは頂点列をポリライン化し、矢印フラグ付きなら先端に簡易矢羽根を追加します。
- **DXF MLEADER/MULTILEADER補足**: MLEADER/MULTILEADERはcontext data内のleader line、dogleg、MText内容を読み、引出線ポリライン・矢羽根・テキストへ分解します。
- **DXF ACAD_TABLE補足**: ACAD_TABLEは表オブジェクトの編集機能までは再現せず、挿入点・横方向・行高・列幅・セル文字列をグリッド線と中央寄せテキストへ分解します。
- **DXF POINT/RAY/XLINE補足**: POINTは小さな十字マーカー、RAY/XLINEは編集可能な有限線分として取り込みます。
- **DXF MLINE補足**: MLINEはスタイル定義の複線幅までは再現せず、経路を失わない中心線ポリラインとして取り込みます。
- **DXF SHAPE補足**: SHAPEは外部shape/SHX定義の輪郭までは再現せず、記号名・挿入点・サイズ・回転を保ったテキストとして取り込みます。
- **DXF TOLERANCE補足**: TOLERANCEはfeature control frameの枠形状までは再現せず、表示文字列・挿入点・X軸方向を保ったテキストとして取り込みます。
- **DXF WIPEOUT補足**: WIPEOUTは外部画像ではなく隠蔽領域として、矩形/ポリゴンのクリップ境界を白塗り閉ポリラインへ変換します。
- **DXF IMAGE補足**: IMAGEは外部画像ファイル本体を読み込まず、配置範囲とIMAGEDEFのファイル名を参照フットプリントとして取り込みます。
- **DXF UNDERLAY補足**: PDF/DWF/DGN UNDERLAYは外部ファイル本体を読み込まず、PDFDEFINITION/DWFDEFINITION/DGNDEFINITION等のファイル名、挿入点、倍率、回転、クリップ境界を参照フットプリントとして取り込みます。
- **DXF OLE2FRAME補足**: OLE2FRAMEは埋め込み/リンクされたOLE本体を読み込まず、上左/右下コーナー、OLE種別、説明文字列を参照フットプリントと中央ラベルとして取り込みます。
- **DXF VIEWPORT補足**: VIEWPORTは紙空間の表示窓として、中心点・幅/高さ・ID・ON/OFF状態・縮尺・非矩形クリップ有無をフレームと中央ラベルとして取り込みます。
- **DXF SECTION補足**: SECTIONは3D断面平面そのものではなく、断面頂点列と背面線頂点列をポリライン化し、名前・状態・高さ情報を中央ラベルとして取り込みます。
- **DXF LIGHT補足**: LIGHTは3D照明レンダリングではなく、位置マーカー、ターゲット方向線、ライト名・種別・ON/OFF・強度ラベルとして取り込みます。
- **DXF MESH補足**: MESH(SubDMesh)はlevel 0のface list/edge listをXY投影し、塗り面と可視エッジへ分解します。
- **DXF HELIX補足**: HELIXは3D曲線そのものではなく、軸・開始点・半径・巻数・1巻き高さ・左右手を反映したXY投影ポリラインとして取り込みます。
- **DXF TEXT/MTEXT補足**: `%%d` / `%%p` / `%%c` / `%%nnn` と、MTEXTの `\U+XXXX` / stacked fraction / 装飾コードを表示文字へ正規化して取り込みます。
- **書き出し（⬇書出）**: SVG（実寸mm・ベクター、寸法ラベル/矢羽根、斜め寸法ラベル回転、線端/線結合/miter上限も明示）/ PNG / PDF（実寸mm）/ **DXF（他CADと相互運用。レイヤー名・OFF/ロック状態・線色・線種・線幅を保持し、矩形・ポリライン・円弧・楕円はCADネイティブ形状、寸法ラベルはTEXT、寸法矢羽根はLINE、複数行文字はMTEXTで出力）**。「選択範囲のみ」も可。
- **印刷（🖨 書出メニュー / Ctrl+P）**: 実寸（mm）のベクターSVGを非表示iframeへ展開し、ブラウザの印刷ダイアログを開きます（ポップアップブロッカーを回避）。`@page` で余白を確保し、印刷ダイアログで**倍率100%（実寸/原寸）**を選べば紙面に1:1で出力できます。「選択範囲のみ」設定も反映。プリンタへの直接印刷、PDFプリンタ経由のPDF化のどちらにも使えます。
- **Fit**: 全図形が収まるようズーム。**New**: 全消去。

## 図形・スタイル
- 線/矩形/円/楕円/円弧/ポリライン/正多角形/テキスト（左中右整列）/寸法/角度寸法/画像。
- 線色（カラースウォッチでワンタップ）/塗り/線幅/**線種（実線・破線・点線）**/字高。

## グリッド・スナップ・表示
- グリッド表示・グリッド吸着・オブジェクトスナップ（端点・中点・中心・四分点・**線分どうしの交点**）のON/OFF、間隔（1〜100mm）。
- **用紙(白)モード**で紙に描く感覚／印刷イメージの表示。**小数桁数(0〜3)**で寸法・計測ラベルの精度を切替。設定はブラウザに保存。

## 座標系
- 単位はミリメートル(mm)。ステータスバーにカーソル座標・倍率・グリッド間隔・図形数を表示。倍率100% = 2px/mm。

## 技術メモ
- 純粋な HTML + CSS + Canvas 2D + Pointer Events。ランタイム依存ゼロ。
- 高DPI(`devicePixelRatio`)対応、`touch-action:none`。
- 回転は各図形の `rot`(ラジアン)で保持し、ヒットテスト/ハンドルは中心まわり逆回転でローカル座標化。
- PWA: `manifest.webmanifest` + `sw.js`（cache-first）でオフライン動作・ホーム画面追加。Manifestに安定ID/言語/SVG+PNGアイコンを明示し、ブラウザ互換用にICO faviconも同梱します。runtime cacheは既知のアプリ静的資産だけに限定します。クエリ付き動的URL、`cache:no-store/no-cache/reload`リクエスト、`Authorization`/`Cookie`付きリクエスト、`Cache-Control:no-store/no-cache/private/max-age=0`レスポンス、`Pragma:no-cache`、期限切れ`Expires`、`Vary:*`/`Vary:Authorization`/`Vary:Cookie`、`Range`/`Content-Range`付きの部分レスポンスは保存しません。Service Worker更新検知時は保留中の自動保存を同期保存し、再読み込みで最新版を反映できる更新通知バンドを表示します。ロード後の登録再実行/多重呼び出しも安全に処理し、アプリシェルのキャッシュ欠落時も制御されたオフライン案内を返します。
- アクセシビリティ: 主要ツールバー/キャンバス/プロパティ/通知/ステータスに `role` / `aria-label` / `aria-live` を付与し、色スウォッチ/レイヤー操作/モーダル/書き出しメニューのラベル、可視フォーカス、フォーカス復帰も検証します。
- PDF: SVG化→高解像度ラスタライズ→`FlateDecode`可逆埋め込み、ページを実寸mm（pt換算）に。日本語も崩れない。
- 外部JSON/localStorage/画像は取り込み時にサニタイズ（型allowlist・色検証・数値範囲クランプ・画像配置はラスタ`data:image/…;base64`のみ・未使用画像キャッシュ破棄・`__proto__`除去）。
- CSP/Referrer-Policy: 単一HTML/インラインscript構成を維持しつつ、外部読み込みを自己配信中心に制限し、`object` / `base` / `form` を閉じる防御層を設定。`data:` scriptの実行ブロックとHTTPリクエストの参照元抑制も自動テストで確認します。

## 検証
ヘッドレスブラウザ（Playwright/Chromium）による自動テストを同梱。

```bash
npm install                                  # 初回のみ
npm run ci                                   # 全検証 + リポジトリ衛生チェック
npm test                                     # 機能/PWA/PDF/SW検証
node test/verify.mjs                         # 機能テスト 712項目
node test/pwacheck.mjs  # PWA(SW/オフライン) 34項目
node test/pdfcheck.mjs  # 生成PDFのxrefオフセット構造検証
node test/swunit.mjs   # Service Worker単体検証 44項目
```

- 作図・複数選択・編集・整列・変形・重ね順・配列・グループ・レイヤー・文字(整列)・画像・楕円・円弧・多角形・角度寸法・連続寸法・線種・計測(小数桁)・交点スナップ・DXF/SVG/PNG/PDF書き出し・DXF/SVG取り込み・PWA・入力サニタイズまで全項目パス。
- `npm test` / `npm run ci` は事前処理でPlaywright Chromiumを導入するため、初回も同じコマンドで検証できます。
- GitHub ActionsのCIで `npm run ci` をpush / pull requestごとに実行し、Playwright Chromium導入、全検証、CI workflow構造、末尾空白/最終改行/マージ衝突マーカー/JSON構文/PWA公開資産参照/start_url・scope整合性/HTML headのPWA・CSP契約/SVG・ICOアイコン構造/ローカルショートカット混入のリポジトリ衛生チェックまで自動確認します。`.gitattributes` でテキスト改行とPNG/PDF等のバイナリ属性も固定しています。
- コードレビュー／セキュリティレビューを複数回実施し、指摘事項は反映済み。
