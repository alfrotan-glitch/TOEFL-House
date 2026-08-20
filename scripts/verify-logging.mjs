/**
 * Runtime logging goes through the logger, and never leaks a credential.
 *
 * Two properties, both mechanical:
 *
 *   1. NO RAW console.* IN SERVICE CODE. Fifty-three calls across fourteen
 *      modules produced output with no level and no shape; boot progress,
 *      recoverable warnings and genuine failures all landed on one stream.
 *      A logger only stays authoritative if nothing bypasses it.
 *
 *   2. CLI TOOLS ARE NOT SERVICES. `scripts/` and the seeder exist to talk to
 *      an operator at a terminal — console output IS their interface, not a
 *      diagnostic side-channel. They are named explicitly rather than matched
 *      by a pattern, so the exemption cannot quietly widen.
 *
 * Run: npm run audit:logging
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const SERVER_SRC = path.join(root, 'server', 'src');
const LOGGER = path.join(SERVER_SRC, 'core', 'observability', 'logger.ts');

/**
 * Modules whose console output is a user interface.
 *
 * The seeder prints a bootstrap summary an operator reads at the terminal;
 * routing it through a structured logger would make it worse, not better.
 */
const CLI_MODULES = new Set([path.join(SERVER_SRC, 'db', 'seed.ts')]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'tests') continue; // test output is for the developer
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const failures = [];
const files = sourceFiles(SERVER_SRC);

for (const file of files) {
  if (file === LOGGER || CLI_MODULES.has(file)) continue;
  const rel = path.relative(root, file);
  const text = stripComments(fs.readFileSync(file, 'utf8'));

  const calls = /\bconsole\.(log|info|debug|warn|error|trace|dir)\s*\(/g;
  let m;
  while ((m = calls.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(
      `${rel}:${line} calls console.${m[1]}(). Use createLogger() from ` +
        `server/src/core/observability/logger.ts so the line carries a level, a source ` +
        `and a machine-readable shape.`,
    );
  }
}

// The logger must keep its redaction guard: it is the single point where a
// credential can be kept out of a log line.
const loggerSource = fs.readFileSync(LOGGER, 'utf8');
for (const needle of ['SENSITIVE_KEY', '[redacted]']) {
  if (!loggerSource.includes(needle)) {
    failures.push(`logger.ts no longer contains ${needle} — redaction has been removed.`);
  }
}

if (failures.length) {
  console.log('LOGGING AUDIT: FAIL');
  for (const f of failures.slice(0, 40)) console.log(' -', f);
  if (failures.length > 40) console.log(`   …and ${failures.length - 40} more`);
  process.exit(1);
}

console.log(
  `LOGGING AUDIT: PASS (${files.length} runtime modules log through the authority; redaction in place)`,
);
