import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TEXT_EXTS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.svg',
  '.webmanifest',
  '.yaml',
  '.yml',
]);
const TEXT_NAMES = new Set(['.gitattributes', '.gitignore']);
const GITATTRIBUTES = '.gitattributes';
const GITIGNORE = '.gitignore';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const PACKAGE_JSON = 'package.json';
const PACKAGE_LOCK = 'package-lock.json';
const SERVICE_WORKER = 'sw.js';
const BINARY_PATTERNS = [
  '*.gif',
  '*.ico',
  '*.jpeg',
  '*.jpg',
  '*.pdf',
  '*.png',
  '*.webp',
];
const REQUIRED_GITIGNORE_LINES = [
  'Thumbs.db',
  'desktop.ini',
  '*.url',
  '*.lnk',
];
const DISALLOWED_REPO_FILENAMES = new Set(['desktop.ini', 'thumbs.db']);
const DISALLOWED_REPO_EXTS = new Set(['.lnk', '.url']);
const REQUIRED_PACKAGE_SCRIPTS = [
  ['ci', 'npm test && npm run check'],
  ['check', 'node test/checkrepo.mjs --self-test && node test/checkrepo.mjs'],
  ['pretest', 'node test/playwright-cli.mjs install chromium'],
  ['test', 'npm run test:functional && npm run test:pwa && npm run test:pdf && npm run test:sw'],
  ['test:functional', 'node test/verify.mjs'],
  ['test:pwa', 'node test/pwacheck.mjs'],
  ['test:pdf', 'node test/pdfcheck.mjs'],
  ['test:sw', 'node test/swunit.mjs'],
];

function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))].sort();
}

function isTextFile(file) {
  const base = path.basename(file);
  return TEXT_NAMES.has(base) || TEXT_EXTS.has(path.extname(file).toLowerCase());
}

function isDisallowedDistributionArtifact(file) {
  const base = path.basename(file).toLowerCase();
  return DISALLOWED_REPO_FILENAMES.has(base) || DISALLOWED_REPO_EXTS.has(path.extname(base));
}

function isJsonLike(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.json' || ext === '.webmanifest';
}

function hasConflictMarker(line) {
  return /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)(?:[ \t]|$)/.test(line);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasYamlKey(source, key) {
  return new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(?:$|#)`, 'm').test(source);
}

function hasWorkflowUses(source, action) {
  return new RegExp(`^\\s*(?:-\\s*)?uses\\s*:\\s*${escapeRegex(action)}\\s*$`, 'm').test(source);
}

function hasWorkflowRun(source, command) {
  return new RegExp(`^\\s*(?:-\\s*)?run\\s*:\\s*${escapeRegex(command)}\\s*$`, 'm').test(source);
}

function gitattributesRows(source) {
  return source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/[ \t]+/));
}

function hasGitattributesRule(source, pattern, attrs) {
  return gitattributesRows(source).some(([candidate, ...actualAttrs]) =>
    candidate === pattern && attrs.every(attr => actualAttrs.includes(attr)));
}

function hasGitignoreRule(source, pattern) {
  return source
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => line === pattern);
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function purposeTokens(icon) {
  return String(icon && icon.purpose ? icon.purpose : '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function htmlAttrsFromTag(tag) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attrRe.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function htmlTags(source, tagName) {
  const tagRe = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>`, 'gi');
  return [...source.matchAll(tagRe)].map(match => htmlAttrsFromTag(match[0]));
}

function htmlTagWithAttr(source, tagName, attrName, attrValue) {
  const key = String(attrName).toLowerCase();
  const expected = String(attrValue).toLowerCase();
  return htmlTags(source, tagName).find(attrs => String(attrs[key] || '').toLowerCase() === expected) || null;
}

function htmlMetaContent(source, attrName, attrValue) {
  const tag = htmlTagWithAttr(source, 'meta', attrName, attrValue);
  return tag ? tag.content || '' : '';
}

function htmlLinkByRel(source, rel) {
  const expected = String(rel).toLowerCase();
  return htmlTags(source, 'link').find(attrs =>
    String(attrs.rel || '').toLowerCase().split(/\s+/).includes(expected)) || null;
}

function htmlRelLinkWithHref(source, rel, href) {
  const expectedHref = String(href);
  return htmlTags(source, 'link').find(attrs =>
    String(attrs.rel || '').toLowerCase().split(/\s+/).includes(String(rel).toLowerCase()) &&
    attrs.href === expectedHref) || null;
}

function readJsonIfValid(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function localReferencePath(asset) {
  return typeof asset === 'string' ? asset.split(/[?#]/, 1)[0] : '';
}

function hasUnsafeLocalPath(asset) {
  const raw = localReferencePath(asset);
  if (!raw || raw.includes('\\') || raw.includes('\0')) return true;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true;
  }
  return decoded.split('/').some(part => part === '..');
}

function isLocalReference(asset) {
  return !!asset &&
    typeof asset === 'string' &&
    !/^[a-z][a-z0-9+.-]*:/i.test(asset) &&
    !asset.startsWith('//') &&
    !asset.startsWith('/') &&
    !hasUnsafeLocalPath(asset);
}

function normalizeAssetPath(asset) {
  if (!isLocalReference(asset)) return '';
  const clean = localReferencePath(asset).replace(/^\.\/+/, '');
  if (clean === '' || clean === '.') return 'index.html';
  return clean.endsWith('/') ? `${clean}index.html` : clean;
}

function normalizeManifestPath(asset) {
  if (!isLocalReference(asset)) return '';
  const clean = localReferencePath(asset).replace(/^\.\/+/, '');
  return clean === '.' ? '' : clean;
}

function isManifestStartWithinScope(startUrl, scope) {
  const startPath = normalizeManifestPath(startUrl);
  const scopePath = normalizeManifestPath(scope);
  if (!isLocalReference(startUrl) || !isLocalReference(scope)) return false;
  if (!scopePath) return true;
  const scopePrefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  return startPath === scopePath || startPath.startsWith(scopePrefix);
}

function checkLocalAsset(asset, owner) {
  const file = normalizeAssetPath(asset);
  if (!file) {
    problems.push(`${owner}: non-local asset reference (${asset})`);
    return '';
  }
  if (!existsSync(file)) problems.push(`${owner}: missing asset ${asset}`);
  return file;
}

function pngInfo(file) {
  const bytes = readFileSync(file);
  const sig = bytes.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function icoInfoFromBytes(bytes) {
  try {
    if (!bytes || bytes.length < 6) return null;
    if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
    const count = bytes.readUInt16LE(4);
    if (!count || count > 64 || bytes.length < 6 + count * 16) return null;
    const entries = [];
    const dataStart = 6 + count * 16;
    for (let i = 0; i < count; i++) {
      const base = 6 + i * 16;
      const width = bytes[base] === 0 ? 256 : bytes[base];
      const height = bytes[base + 1] === 0 ? 256 : bytes[base + 1];
      const colorCount = bytes[base + 2];
      const planes = bytes.readUInt16LE(base + 4);
      const bitCount = bytes.readUInt16LE(base + 6);
      const size = bytes.readUInt32LE(base + 8);
      const imageOffset = bytes.readUInt32LE(base + 12);
      if (!width || !height || !size || imageOffset < dataStart || imageOffset + size > bytes.length) return null;
      const image = bytes.subarray(imageOffset, imageOffset + size);
      const entry = {
        width,
        height,
        colorCount,
        planes,
        bitCount,
        size,
        imageOffset,
        isPng: image.length >= 24 && image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
        pngWidth: 0,
        pngHeight: 0,
      };
      if (entry.isPng) {
        entry.pngWidth = image.readUInt32BE(16);
        entry.pngHeight = image.readUInt32BE(20);
      }
      entries.push(entry);
    }
    return { count, entries };
  } catch {
    return null;
  }
}

function icoInfo(file) {
  return icoInfoFromBytes(readFileSync(file));
}

function checkIcoIconAsset(file, owner) {
  if (!file || path.extname(file).toLowerCase() !== '.ico') return;
  const info = icoInfo(file);
  if (!info) {
    problems.push(`${owner}: ${file} must be a valid ICO file`);
    return;
  }
  const sizes = new Set();
  for (const entry of info.entries) {
    sizes.add(`${entry.width}x${entry.height}`);
    if (entry.width !== entry.height) problems.push(`${owner}: ${file} contains a non-square ${entry.width}x${entry.height} icon`);
    if (entry.isPng && (entry.pngWidth !== entry.width || entry.pngHeight !== entry.height)) {
      problems.push(`${owner}: ${file} PNG payload is ${entry.pngWidth}x${entry.pngHeight}, expected ${entry.width}x${entry.height}`);
    }
  }
  for (const size of ['16x16', '32x32', '48x48']) {
    if (!sizes.has(size)) problems.push(`${owner}: ${file} must contain a ${size} icon`);
  }
}

function svgInfoFromSource(source) {
  const lower = source.toLowerCase();
  return {
    hasRoot: /<svg\b/i.test(source),
    hasXmlns: /\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(source),
    hasViewBox: /\bviewBox\s*=\s*["'][^"']+["']/.test(source),
    hasScript: /<\s*script\b/i.test(source),
    hasForeignObject: /<\s*foreignObject\b/i.test(source),
    hasEventHandler: /\son[a-z]+\s*=/i.test(source),
    hasExternalReference: /\b(?:href|xlink:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(source) ||
      /\burl\(\s*['"]?(?:https?:|\/\/)/i.test(source),
    hasDataReference: /\b(?:href|xlink:href|src)\s*=\s*["']data:/i.test(source),
    hasDoctype: /<!doctype\b/i.test(source),
    hasEntity: /<!entity\b/i.test(source),
    hasHtml: /<\s*html\b/i.test(source),
    hasImageTag: /<\s*image\b/i.test(source),
    mentionsJavascript: lower.includes('javascript:'),
  };
}

function svgInfo(file) {
  return svgInfoFromSource(readFileSync(file, 'utf8'));
}

function checkSvgIconAsset(file, owner) {
  if (!file || path.extname(file).toLowerCase() !== '.svg') return;
  const info = svgInfo(file);
  if (!info.hasRoot) problems.push(`${owner}: ${file} must contain an <svg> root`);
  if (!info.hasXmlns) problems.push(`${owner}: ${file} must declare the SVG namespace`);
  if (!info.hasViewBox) problems.push(`${owner}: ${file} must declare viewBox`);
  if (info.hasScript) problems.push(`${owner}: ${file} must not contain <script>`);
  if (info.hasForeignObject) problems.push(`${owner}: ${file} must not contain <foreignObject>`);
  if (info.hasEventHandler) problems.push(`${owner}: ${file} must not contain event handler attributes`);
  if (info.hasExternalReference) problems.push(`${owner}: ${file} must not reference external resources`);
  if (info.hasDataReference) problems.push(`${owner}: ${file} must not embed data: references`);
  if (info.hasDoctype || info.hasEntity || info.hasHtml) problems.push(`${owner}: ${file} must be a standalone SVG fragment`);
  if (info.hasImageTag) problems.push(`${owner}: ${file} must not embed nested images`);
  if (info.mentionsJavascript) problems.push(`${owner}: ${file} must not contain javascript: URLs`);
}

function quotedListValues(source, constName) {
  const m = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]) : [];
}

function singleQuotedConst(source, constName) {
  const m = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*'([^']*)'\\s*;`));
  return m ? m[1] : '';
}

function serviceWorkerCacheSeed(source) {
  return source.replace(/const\s+CACHE\s*=\s*'[^']*'\s*;/, "const CACHE = '<content-hash>';");
}

function expectedServiceWorkerCacheName(source) {
  const prefix = singleQuotedConst(source, 'CACHE_PREFIX');
  const assets = quotedListValues(source, 'ASSETS');
  if (!prefix || !assets.length) return '';

  const hash = createHash('sha256');
  hash.update('service-worker\0');
  hash.update(serviceWorkerCacheSeed(source));
  hash.update('\0assets\0');

  const seen = new Set();
  for (const asset of assets) {
    const file = normalizeAssetPath(asset);
    if (!file || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }

  const digest = hash.digest('hex').slice(0, 12);
  return `${prefix}${BigInt(`0x${digest}`).toString(10)}`;
}

function runSelfTest() {
  const markerCases = [
    { line: '<<<<<<< HEAD', marker: true },
    { line: '||||||| base', marker: true },
    { line: '=======', marker: true },
    { line: '>>>>>>> branch', marker: true },
    { line: '====== heading text', marker: false },
    { line: 'prefix <<<<<<< HEAD', marker: false },
  ];
  const failures = [];
  for (const item of markerCases) {
    const marker = hasConflictMarker(item.line);
    if (marker !== item.marker) failures.push(`${item.line}: marker=${marker}, expected ${item.marker}`);
  }

  const cases = [
    { asset: './', local: true, normalized: 'index.html' },
    { asset: './index.html?cache=1', local: true, normalized: 'index.html' },
    { asset: 'icons/icon.png', local: true, normalized: 'icons/icon.png' },
    { asset: 'sub/', local: true, normalized: 'sub/index.html' },
    { asset: '/simple-cad/', local: false },
    { asset: 'https://example.test/app.webmanifest', local: false },
    { asset: '//cdn.example.test/icon.png', local: false },
    { asset: '../index.html', local: false },
    { asset: 'icons/../../index.html', local: false },
    { asset: '%2e%2e/index.html', local: false },
    { asset: 'icons\\icon.png', local: false },
  ];
  for (const item of cases) {
    const local = isLocalReference(item.asset);
    if (local !== item.local) failures.push(`${item.asset}: local=${local}, expected ${item.local}`);
    if (item.local) {
      const normalized = normalizeAssetPath(item.asset);
      if (normalized !== item.normalized) failures.push(`${item.asset}: normalized=${normalized}, expected ${item.normalized}`);
    }
  }
  const scopeCases = [
    { start: './', scope: './', ok: true },
    { start: 'app/index.html', scope: 'app/', ok: true },
    { start: 'app', scope: 'app', ok: true },
    { start: 'app2/index.html', scope: 'app/', ok: false },
    { start: '../index.html', scope: './', ok: false },
  ];
  for (const item of scopeCases) {
    const ok = isManifestStartWithinScope(item.start, item.scope);
    if (ok !== item.ok) failures.push(`${item.start} within ${item.scope}: ${ok}, expected ${item.ok}`);
  }

  const workflowSample = [
    'on:',
    '  push:',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'steps:',
    '  - uses: actions/checkout@v4',
    '  - uses: actions/setup-node@v4',
    '  - run: npm ci',
    '  - run: npm run ci',
  ].join('\n');
  for (const key of ['push', 'pull_request', 'workflow_dispatch', 'missing']) {
    const expected = key !== 'workflow_dispatch' && key !== 'missing';
    const present = hasYamlKey(workflowSample, key);
    if (present !== expected) failures.push(`${key}: workflow key=${present}, expected ${expected}`);
  }
  if (!hasWorkflowUses(workflowSample, 'actions/checkout@v4')) failures.push('workflow sample: missing checkout action');
  if (!hasWorkflowRun(workflowSample, 'npm ci')) failures.push('workflow sample: missing npm ci');
  if (hasWorkflowRun(workflowSample, 'npm test')) failures.push('workflow sample: unexpected npm test');

  const attrsSample = [
    '* text=auto',
    '*.html text eol=lf',
    '*.png binary',
  ].join('\n');
  if (!hasGitattributesRule(attrsSample, '*', ['text=auto'])) failures.push('gitattributes sample: missing text=auto');
  if (!hasGitattributesRule(attrsSample, '*.html', ['text', 'eol=lf'])) failures.push('gitattributes sample: missing html text rule');
  if (!hasGitattributesRule(attrsSample, '*.png', ['binary'])) failures.push('gitattributes sample: missing png binary rule');
  if (hasGitattributesRule(attrsSample, '*.jpg', ['binary'])) failures.push('gitattributes sample: unexpected jpg binary rule');
  const ignoreSample = ['node_modules/', 'Thumbs.db', 'desktop.ini', '*.url', '*.lnk'].join('\n');
  for (const rule of REQUIRED_GITIGNORE_LINES) {
    if (!hasGitignoreRule(ignoreSample, rule)) failures.push(`gitignore sample: missing ${rule}`);
  }
  if (!isDisallowedDistributionArtifact('SimpleCAD.url')) failures.push('distribution artifact sample: url shortcut was accepted');
  if (!isDisallowedDistributionArtifact('SimpleCAD.lnk')) failures.push('distribution artifact sample: lnk shortcut was accepted');
  if (!isDisallowedDistributionArtifact('desktop.ini')) failures.push('distribution artifact sample: desktop.ini was accepted');
  if (!isDisallowedDistributionArtifact('Thumbs.db')) failures.push('distribution artifact sample: Thumbs.db was accepted');
  if (isDisallowedDistributionArtifact('index.html')) failures.push('distribution artifact sample: index.html was rejected');
  if (!isHexColor('#1e293b') || isHexColor('1e293b') || isHexColor('#12345g')) failures.push('hex color sample: color validation failed');
  if (JSON.stringify(purposeTokens({ purpose: 'any maskable' })) !== '["any","maskable"]') failures.push('manifest icon purpose sample: tokens failed');
  const htmlSample = [
    '<html lang="ja">',
    '<meta name="theme-color" content="#1e293b">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; object-src \'none\'">',
    '<link rel="alternate icon" href="simplecad.ico" type="image/x-icon">',
  ].join('\n');
  if (htmlTagWithAttr(htmlSample, 'html', 'lang', 'ja')?.lang !== 'ja') failures.push('html sample: lang was not detected');
  if (htmlMetaContent(htmlSample, 'name', 'theme-color') !== '#1e293b') failures.push('html sample: theme-color was not detected');
  if (!htmlLinkByRel(htmlSample, 'icon')) failures.push('html sample: icon rel was not detected');
  const alternateIcon = htmlRelLinkWithHref(htmlSample, 'icon', 'simplecad.ico');
  if (!alternateIcon || alternateIcon.type !== 'image/x-icon') failures.push('html sample: alternate icon was not detected');
  if (!htmlMetaContent(htmlSample, 'http-equiv', 'Content-Security-Policy').includes("object-src 'none'")) {
    failures.push('html sample: CSP was not detected');
  }

  const swSample = [
    "const CACHE_PREFIX = 'simplecad-v';",
    "const CACHE = 'simplecad-v0';",
    "const ASSETS = ['./index.html'];",
  ].join('\n');
  if (singleQuotedConst(swSample, 'CACHE_PREFIX') !== 'simplecad-v') failures.push('sw sample: missing cache prefix');
  if (singleQuotedConst(swSample, 'CACHE') !== 'simplecad-v0') failures.push('sw sample: missing cache const');
  if (serviceWorkerCacheSeed(swSample).includes('simplecad-v0')) failures.push('sw sample: cache seed still includes concrete cache name');
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const unsafeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://example.test/x.png"/></svg>';
  const safeSvgInfo = svgInfoFromSource(safeSvg);
  const unsafeSvgInfo = svgInfoFromSource(unsafeSvg);
  if (!safeSvgInfo.hasRoot || !safeSvgInfo.hasXmlns || !safeSvgInfo.hasViewBox) failures.push('svg sample: safe icon shape was not detected');
  if (!unsafeSvgInfo.hasScript || !unsafeSvgInfo.hasExternalReference || !unsafeSvgInfo.hasImageTag) failures.push('svg sample: unsafe icon content was not detected');
  const pngPayload = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(pngPayload, 0);
  pngPayload.writeUInt32BE(16, 16);
  pngPayload.writeUInt32BE(16, 20);
  const icoSample = Buffer.alloc(6 + 16 + pngPayload.length);
  icoSample.writeUInt16LE(0, 0);
  icoSample.writeUInt16LE(1, 2);
  icoSample.writeUInt16LE(1, 4);
  icoSample[6] = 16;
  icoSample[7] = 16;
  icoSample.writeUInt16LE(1, 10);
  icoSample.writeUInt16LE(32, 12);
  icoSample.writeUInt32LE(pngPayload.length, 14);
  icoSample.writeUInt32LE(22, 18);
  pngPayload.copy(icoSample, 22);
  const icoSampleInfo = icoInfoFromBytes(icoSample);
  if (!icoSampleInfo || icoSampleInfo.count !== 1 || icoSampleInfo.entries[0].width !== 16 || !icoSampleInfo.entries[0].isPng) {
    failures.push('ico sample: valid PNG-backed ICO was not detected');
  }
  if (icoInfoFromBytes(Buffer.from([1, 0, 1, 0, 0, 0]))) failures.push('ico sample: invalid ICO was accepted');
  if (failures.length) {
    console.error('Repository hygiene self-test failed:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('Repository hygiene self-test: OK');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

const problems = [];
const files = repoFiles();
for (const file of files) {
  if (isDisallowedDistributionArtifact(file)) {
    problems.push(`${file}: local desktop shortcut/artifact must not be tracked or included`);
  }
}
for (const file of files.filter(isTextFile)) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (/[ \t]+$/.test(line)) problems.push(`${file}:${i + 1}: trailing whitespace`);
    if (hasConflictMarker(line)) problems.push(`${file}:${i + 1}: merge conflict marker`);
  }
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) problems.push(`${file}: missing final newline`);
  if (isJsonLike(file)) {
    try {
      JSON.parse(text);
    } catch (error) {
      problems.push(`${file}: invalid JSON (${error.message})`);
    }
  }
}

if (existsSync('manifest.webmanifest')) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
  } catch {
    manifest = null;
  }
  if (manifest) {
    if (!manifest.name || typeof manifest.name !== 'string') problems.push('manifest.webmanifest name: missing');
    if (!manifest.short_name || typeof manifest.short_name !== 'string') problems.push('manifest.webmanifest short_name: missing');
    if (!manifest.description || typeof manifest.description !== 'string') problems.push('manifest.webmanifest description: missing');
    if (manifest.display !== 'standalone') problems.push(`manifest.webmanifest display: must be standalone (${manifest.display})`);
    if (manifest.orientation !== 'any') problems.push(`manifest.webmanifest orientation: must be any (${manifest.orientation})`);
    if (!isHexColor(manifest.theme_color)) problems.push(`manifest.webmanifest theme_color: must be #RRGGBB (${manifest.theme_color})`);
    if (!isHexColor(manifest.background_color)) problems.push(`manifest.webmanifest background_color: must be #RRGGBB (${manifest.background_color})`);
    if (!manifest.start_url) {
      problems.push('manifest.webmanifest start_url: missing');
    } else {
      checkLocalAsset(manifest.start_url, 'manifest.webmanifest start_url');
    }
    if (!manifest.scope || !isLocalReference(manifest.scope)) {
      problems.push(`manifest.webmanifest scope: non-local or missing scope (${manifest.scope})`);
    } else if (manifest.start_url && !isManifestStartWithinScope(manifest.start_url, manifest.scope)) {
      problems.push(`manifest.webmanifest scope: start_url ${manifest.start_url} is outside scope ${manifest.scope}`);
    }

    const iconFiles = [];
    for (const icon of manifest.icons || []) {
      const file = checkLocalAsset(icon.src, 'manifest.webmanifest icons');
      if (file) iconFiles.push(file);
      const purposes = purposeTokens(icon);
      if (!purposes.includes('any') || !purposes.includes('maskable')) {
        problems.push(`manifest.webmanifest icons: ${icon.src} purpose must include any and maskable`);
      }
      checkSvgIconAsset(file, 'manifest.webmanifest icons');
      checkIcoIconAsset(file, 'manifest.webmanifest icons');
      if (file && path.extname(file).toLowerCase() === '.svg') {
        if (icon.type !== 'image/svg+xml') problems.push(`manifest.webmanifest icons: ${file} type must be image/svg+xml`);
        if (icon.sizes !== 'any') problems.push(`manifest.webmanifest icons: ${file} sizes must be any`);
      }
      if (file && icon.type === 'image/png' && /^\d+x\d+$/.test(icon.sizes || '')) {
        const [w, h] = icon.sizes.split('x').map(Number);
        const info = pngInfo(file);
        if (!info) {
          problems.push(`manifest.webmanifest icons: ${file} is not a PNG`);
        } else if (info.width !== w || info.height !== h) {
          problems.push(`manifest.webmanifest icons: ${file} is ${info.width}x${info.height}, expected ${icon.sizes}`);
        }
      }
    }

    if (existsSync('index.html')) {
      const html = readFileSync('index.html', 'utf8');
      const htmlTag = htmlTagWithAttr(html, 'html', 'lang', 'ja');
      if (!htmlTag) problems.push('index.html: html lang must be ja');
      if (!htmlTagWithAttr(html, 'meta', 'charset', 'UTF-8')) problems.push('index.html: charset must be UTF-8');
      const viewport = htmlMetaContent(html, 'name', 'viewport');
      for (const token of ['width=device-width', 'initial-scale=1.0', 'viewport-fit=cover']) {
        if (!viewport.includes(token)) problems.push(`index.html viewport: missing ${token}`);
      }
      const themeColor = htmlMetaContent(html, 'name', 'theme-color');
      if (themeColor !== manifest.theme_color) {
        problems.push(`index.html theme-color: must match manifest theme_color ${manifest.theme_color}`);
      }
      if (htmlMetaContent(html, 'name', 'referrer') !== 'no-referrer') {
        problems.push('index.html referrer: must be no-referrer');
      }
      if (htmlMetaContent(html, 'name', 'apple-mobile-web-app-capable') !== 'yes') {
        problems.push('index.html apple-mobile-web-app-capable: must be yes');
      }
      if (htmlMetaContent(html, 'name', 'apple-mobile-web-app-status-bar-style') !== 'black-translucent') {
        problems.push('index.html apple-mobile-web-app-status-bar-style: must be black-translucent');
      }
      if (htmlMetaContent(html, 'name', 'apple-mobile-web-app-title') !== manifest.short_name) {
        problems.push(`index.html apple-mobile-web-app-title: must match manifest short_name ${manifest.short_name}`);
      }
      const csp = htmlMetaContent(html, 'http-equiv', 'Content-Security-Policy');
      for (const directive of [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ]) {
        if (!csp.includes(directive)) problems.push(`index.html CSP: missing ${directive}`);
      }
      const manifestLink = htmlRelLinkWithHref(html, 'manifest', 'manifest.webmanifest');
      if (!manifestLink) problems.push('index.html link: missing manifest.webmanifest');
      const svgIcon = htmlRelLinkWithHref(html, 'icon', 'icon.svg');
      if (!svgIcon || svgIcon.type !== 'image/svg+xml') problems.push('index.html link: icon.svg must be image/svg+xml');
      const icoIcon = htmlRelLinkWithHref(html, 'icon', 'simplecad.ico');
      if (!icoIcon || icoIcon.type !== 'image/x-icon') problems.push('index.html link: simplecad.ico must be image/x-icon');
      const appleIcon = htmlRelLinkWithHref(html, 'apple-touch-icon', 'apple-touch-icon.png');
      if (!appleIcon) problems.push('index.html link: missing apple-touch-icon.png');
      const linkAssets = [...html.matchAll(/<link\b[^>]*\b(?:href)=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
      const localLinks = linkAssets.map(href => checkLocalAsset(href, 'index.html link')).filter(Boolean);
      for (let i = 0; i < localLinks.length; i++) {
        checkSvgIconAsset(localLinks[i], 'index.html link');
        checkIcoIconAsset(localLinks[i], 'index.html link');
      }
      const apple = localLinks.find(file => file === 'apple-touch-icon.png');
      if (apple) {
        const info = pngInfo(apple);
        if (!info || info.width !== 180 || info.height !== 180) {
          problems.push(`index.html link: ${apple} must be a 180x180 PNG`);
        }
      }

      if (existsSync('sw.js')) {
        const sw = readFileSync('sw.js', 'utf8');
        const assets = quotedListValues(sw, 'ASSETS').map(normalizeAssetPath).filter(Boolean);
        const assetSet = new Set(assets);
        const manifestStart = normalizeAssetPath(manifest.start_url);
        for (const file of ['manifest.webmanifest', manifestStart, ...iconFiles, ...localLinks].filter(Boolean)) {
          if (!assetSet.has(file) && file !== 'index.html') problems.push(`sw.js ASSETS: missing referenced asset ${file}`);
        }
        for (const asset of assets) {
          const file = checkLocalAsset(asset, 'sw.js ASSETS');
          checkSvgIconAsset(file, 'sw.js ASSETS');
          checkIcoIconAsset(file, 'sw.js ASSETS');
        }
      }
    }
  }
}

if (existsSync(SERVICE_WORKER)) {
  const sw = readFileSync(SERVICE_WORKER, 'utf8');
  const prefix = singleQuotedConst(sw, 'CACHE_PREFIX');
  const cache = singleQuotedConst(sw, 'CACHE');
  const expectedCache = expectedServiceWorkerCacheName(sw);
  if (prefix !== 'simplecad-v') problems.push(`${SERVICE_WORKER}: CACHE_PREFIX must be simplecad-v`);
  if (!cache) {
    problems.push(`${SERVICE_WORKER}: missing CACHE constant`);
  } else if (!cache.startsWith(prefix) || !/^\d+$/.test(cache.slice(prefix.length))) {
    problems.push(`${SERVICE_WORKER}: CACHE must use ${prefix}<numeric-content-hash>`);
  } else if (expectedCache && cache !== expectedCache) {
    problems.push(`${SERVICE_WORKER}: CACHE must be ${expectedCache} for current service worker/assets`);
  }
} else {
  problems.push(`${SERVICE_WORKER}: missing Service Worker`);
}

if (existsSync(GITATTRIBUTES)) {
  const attrs = readFileSync(GITATTRIBUTES, 'utf8');
  if (!hasGitattributesRule(attrs, '*', ['text=auto'])) problems.push(`${GITATTRIBUTES}: missing * text=auto`);
  for (const name of TEXT_NAMES) {
    if (!hasGitattributesRule(attrs, name, ['text', 'eol=lf'])) {
      problems.push(`${GITATTRIBUTES}: missing ${name} text eol=lf`);
    }
  }
  for (const ext of TEXT_EXTS) {
    const pattern = `*${ext}`;
    if (!hasGitattributesRule(attrs, pattern, ['text', 'eol=lf'])) {
      problems.push(`${GITATTRIBUTES}: missing ${pattern} text eol=lf`);
    }
  }
  for (const pattern of BINARY_PATTERNS) {
    if (!hasGitattributesRule(attrs, pattern, ['binary'])) problems.push(`${GITATTRIBUTES}: missing ${pattern} binary`);
  }
} else {
  problems.push(`${GITATTRIBUTES}: missing Git attributes file`);
}

if (existsSync(GITIGNORE)) {
  const ignore = readFileSync(GITIGNORE, 'utf8');
  for (const rule of REQUIRED_GITIGNORE_LINES) {
    if (!hasGitignoreRule(ignore, rule)) problems.push(`${GITIGNORE}: missing ${rule}`);
  }
} else {
  problems.push(`${GITIGNORE}: missing Git ignore file`);
}

if (existsSync(PACKAGE_JSON)) {
  const pkg = readJsonIfValid(PACKAGE_JSON);
  if (pkg) {
    if (pkg.private !== true) problems.push(`${PACKAGE_JSON}: private must be true to prevent accidental npm publish`);
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    for (const [name, expected] of REQUIRED_PACKAGE_SCRIPTS) {
      if (scripts[name] !== expected) problems.push(`${PACKAGE_JSON}: script ${name} must be "${expected}"`);
    }
    if (!pkg.devDependencies || pkg.devDependencies.playwright !== '^1.61.0') {
      problems.push(`${PACKAGE_JSON}: devDependencies.playwright must be ^1.61.0`);
    }
  }
} else {
  problems.push(`${PACKAGE_JSON}: missing package manifest`);
}

if (existsSync(PACKAGE_LOCK)) {
  const lock = readJsonIfValid(PACKAGE_LOCK);
  if (lock) {
    const packages = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
    const root = packages[''] && typeof packages[''] === 'object' ? packages[''] : {};
    if (root.devDependencies?.playwright !== '^1.61.0') {
      problems.push(`${PACKAGE_LOCK}: root devDependencies.playwright must match package.json`);
    }
    if (!packages['node_modules/playwright']) problems.push(`${PACKAGE_LOCK}: missing node_modules/playwright entry`);
    if (!packages['node_modules/playwright-core']) problems.push(`${PACKAGE_LOCK}: missing node_modules/playwright-core entry`);
  }
} else {
  problems.push(`${PACKAGE_LOCK}: missing npm lockfile`);
}

if (existsSync(CI_WORKFLOW)) {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8');
  for (const key of ['push', 'pull_request', 'workflow_dispatch']) {
    if (!hasYamlKey(workflow, key)) problems.push(`${CI_WORKFLOW}: missing ${key} trigger`);
  }
  if (!hasYamlKey(workflow, 'permissions')) problems.push(`${CI_WORKFLOW}: missing permissions block`);
  if (!/^\s*contents\s*:\s*read\s*$/m.test(workflow)) problems.push(`${CI_WORKFLOW}: missing contents: read permission`);
  if (!hasWorkflowUses(workflow, 'actions/checkout@v4')) problems.push(`${CI_WORKFLOW}: missing actions/checkout@v4`);
  if (!hasWorkflowUses(workflow, 'actions/setup-node@v4')) problems.push(`${CI_WORKFLOW}: missing actions/setup-node@v4`);
  if (!hasWorkflowRun(workflow, 'npm ci')) problems.push(`${CI_WORKFLOW}: missing npm ci install step`);
  if (!hasWorkflowRun(workflow, 'npm run ci')) problems.push(`${CI_WORKFLOW}: missing npm run ci validation step`);
} else {
  problems.push(`${CI_WORKFLOW}: missing GitHub Actions CI workflow`);
}

if (problems.length) {
  console.error('Repository hygiene check failed:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log('Repository hygiene check: OK');
