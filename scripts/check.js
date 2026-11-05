import { readFileSync, existsSync } from 'node:fs';
import { compileFunction } from 'node:vm';

const targetFiles = [
  'src/FontPrepender.user.js',
  'tests/parser.test.js',
  'tests/dom.test.js',
  'tests/benchmark.perf.js'
];

let hasErrors = false;

for (const file of targetFiles) {
  if (!existsSync(file)) continue;
  try {
    const code = readFileSync(file, 'utf8');
    compileFunction(code, [], { parsingContext: undefined });
    console.log(`[check] OK: ${file}`);
  } catch (err) {
    console.error(`[check] Syntax Error in ${file}:`, err);
    hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
} else {
  console.log('[check] All checked files passed syntax check.');
}
