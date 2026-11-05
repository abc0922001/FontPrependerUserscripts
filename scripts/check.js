import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const targetFiles = [
  'src/FontPrepender.user.js',
  'tests/parser.test.js',
  'tests/dom.test.js',
  'tests/sites.test.js',
  'tests/benchmark.perf.js'
];

let hasErrors = false;

for (const file of targetFiles) {
  if (!existsSync(file)) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`[check] OK: ${file}`);
  } catch (err) {
    console.error(`[check] Syntax Error in ${file}:`, err.stderr?.toString() || err.message);
    hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
} else {
  console.log('[check] All checked files passed syntax check.');
}
