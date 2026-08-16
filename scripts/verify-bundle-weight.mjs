/**
 * Guards the first-paint payload of the built frontend.
 *
 * DEFECT this locks down: the Rolldown `manualChunks` function form did not
 * keep React's CommonJS entry points (react/index.js,
 * react-dom/cjs/react-dom.production.js) in the `react` chunk. They were
 * absorbed by whichever chunk required them first — recharts — so the entry
 * HTML preloaded a 412 KB charting library on every page load even though only
 * the lazily imported Dashboard renders a chart. Users paid for it before the
 * first paint.
 *
 * Run after `npm run build`. Fails if the heavy chart bundle re-enters the
 * critical path, if React is duplicated across chunks, or if the entry payload
 * regresses past its budget.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const assets = path.join(dist, 'assets');
const failures = [];

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('BUNDLE WEIGHT: no dist/index.html — run `npm run build` first.');
  process.exit(1);
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const files = fs.readdirSync(assets);
const sizeOf = (f) => fs.statSync(path.join(assets, f)).size;

/** Assets the browser fetches before it can paint. */
const critical = [
  ...html.matchAll(/(?:href|src)="\/assets\/([^"]+)"/g),
].map((m) => m[1]);

// 1. The chart library must never be in the entry's preload graph.
const chartInCritical = critical.filter((f) => /^charts-/.test(f));
if (chartInCritical.length) {
  failures.push(
    `The chart bundle is preloaded on first paint (${chartInCritical.join(', ')}). ` +
      'It belongs to the lazy Dashboard route only. Check the advancedChunks groups in vite.config.ts.',
  );
}

// 2. The entry chunk must not statically import the chart chunk either.
const entry = critical.find((f) => /^index-.*\.js$/.test(f));
if (entry) {
  const src = fs.readFileSync(path.join(assets, entry), 'utf8');
  if (/(?:from|import)\s*"\.\/charts-[^"]+"/.test(src)) {
    failures.push(`Entry chunk ${entry} statically imports the chart chunk; it must stay a lazy dependency.`);
  }
}

// 3. React must exist exactly once. A duplicated copy silently breaks hooks
//    and doubles the download.
const reactCopies = files.filter(
  (f) => f.endsWith('.js') && /react\.dev\/errors/.test(fs.readFileSync(path.join(assets, f), 'utf8')),
);
if (reactCopies.length !== 1) {
  failures.push(`React internals appear in ${reactCopies.length} chunks (${reactCopies.join(', ')}); expected exactly 1.`);
}

// 4. Budget for the critical path, with headroom for ordinary growth.
const CRITICAL_BUDGET_KB = 560;
const criticalBytes = critical
  .filter((f) => fs.existsSync(path.join(assets, f)))
  .reduce((sum, f) => sum + sizeOf(f), 0);
const criticalKB = Math.round(criticalBytes / 1024);
if (criticalKB > CRITICAL_BUDGET_KB) {
  failures.push(`First-paint payload is ${criticalKB} KB, over the ${CRITICAL_BUDGET_KB} KB budget.`);
}

// 5. Route views must stay code-split rather than collapsing into the entry.
const lazyViews = files.filter((f) => /View-.*\.js$/.test(f));
if (lazyViews.length < 10) {
  failures.push(`Only ${lazyViews.length} lazily split route chunks found; route-level code splitting has regressed.`);
}

if (failures.length) {
  console.error('BUNDLE WEIGHT: FAIL');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log('BUNDLE WEIGHT: PASS');
console.log(` first paint: ${criticalKB} KB across ${critical.length} assets (budget ${CRITICAL_BUDGET_KB} KB)`);
console.log(` lazy route chunks: ${lazyViews.length}`);
