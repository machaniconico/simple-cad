import { execFileSync } from 'node:child_process';
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

function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))].sort();
}

function isTextFile(file) {
  const base = path.basename(file);
  return TEXT_NAMES.has(base) || TEXT_EXTS.has(path.extname(file).toLowerCase());
}

function isJsonLike(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.json' || ext === '.webmanifest';
}

function hasConflictMarker(line) {
  return /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)(?:[ \t]|$)/.test(line);
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

function quotedListValues(source, constName) {
  const m = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]) : [];
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
for (const file of repoFiles().filter(isTextFile)) {
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
      const linkAssets = [...html.matchAll(/<link\b[^>]*\b(?:href)=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
      const localLinks = linkAssets.map(href => checkLocalAsset(href, 'index.html link')).filter(Boolean);
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
        for (const asset of assets) checkLocalAsset(asset, 'sw.js ASSETS');
      }
    }
  }
}

if (problems.length) {
  console.error('Repository hygiene check failed:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log('Repository hygiene check: OK');
