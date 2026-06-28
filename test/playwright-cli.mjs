// Run the Playwright CLI even when node_modules/.bin shims are unavailable.
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const cliPath = join(dirname(require.resolve('playwright')), 'cli.js');
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
