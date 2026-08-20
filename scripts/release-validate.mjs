#!/usr/bin/env node
/**
 * Reproducible release validation.
 * ============================================================================
 * One command that runs every release gate in order and fails loudly on the
 * first problem. Before this existed, "the gates pass" meant a human had
 * remembered to run eight separate commands in two directories — and the only
 * scripted release step, `release:clean`, was a PowerShell file that exits 127
 * on Linux, so CI would have reported success for a step that never ran.
 *
 *   node scripts/release-validate.mjs            # full gate
 *   node scripts/release-validate.mjs --quick    # skip builds and the suite
 *
 * Every check is a real command with a real exit code. Nothing here reports a
 * result it did not actually observe.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const results = [];
let failed = 0;

function run(name, cmd, opts = {}) {
  if (quick && opts.slow) {
    results.push({ name, status: 'SKIP', detail: '--quick' });
    return true;
  }
  process.stdout.write(`  ${name.padEnd(38)} `);
  try {
    // maxBuffer must exceed the noisiest command's output. The server suite
    // prints ~1.5 MB (every migration, for 80 files), which silently blew past
    // execSync's 1 MB default: the child was killed with SIGTERM and reported
    // FAIL even when all 799 tests passed. A gate that fails for a reason
    // unrelated to what it measures is not a gate, so cap generously and treat
    // a buffer overflow as an error about the harness, never about the code.
    execSync(cmd, {
      cwd: opts.cwd ?? root,
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...opts.env },
    });
    process.stdout.write('PASS\n');
    results.push({ name, status: 'PASS' });
    return true;
  } catch (err) {
    // A signal kill means the command never reported a verdict of its own.
    // Say so explicitly rather than blaming the code under test.
    const killed = err.signal ? `killed by ${err.signal} (harness limit, not a test result)` : '';
    const out = killed || `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n      ');
    process.stdout.write('FAIL\n');
    if (out) console.log(`      ${out}`);
    results.push({ name, status: 'FAIL', detail: out });
    failed++;
    return false;
  }
}

function check(name, fn) {
  process.stdout.write(`  ${name.padEnd(38)} `);
  try {
    const detail = fn();
    process.stdout.write(`PASS${detail ? `  (${detail})` : ''}\n`);
    results.push({ name, status: 'PASS', detail });
    return true;
  } catch (err) {
    process.stdout.write(`FAIL\n      ${err.message}\n`);
    results.push({ name, status: 'FAIL', detail: err.message });
    failed++;
    return false;
  }
}

console.log(`\nTOEFL House ERP — release validation${quick ? ' (quick)' : ''}\n`);

console.log('Static analysis');
run('frontend typecheck', 'npm run typecheck');
run('frontend lint', 'npm run lint');
run('server lint (eslint + tsc)', 'npm run lint', { cwd: path.join(root, 'server') });
run('product integrity audit', 'npm run audit:product');
run('high-assurance static audit', 'npm run audit:static');
// The Master Engineering Protocol is registered as immutable project policy.
// A policy that can be edited silently is not policy.
run('protocol integrity', 'npm run audit:protocol');
// Engineering Protocol §6: the registries are the proof, not the prose. A stale
// registry — a renamed module, a deleted test, an invariant with no enforcement
// point — fails the release, exactly as a broken test would.
run('registry audit', 'npm run audit:registries');
run('design system audit', 'npm run audit:design-system');

console.log('\nBuild');
run('frontend production build', 'npm run build', { slow: true });
run('server production build', 'npm run build', { cwd: path.join(root, 'server'), slow: true });
run('bundle weight', 'npm run audit:bundle', { slow: true });

console.log('\nTests');
run('server test suite', 'npm test', { cwd: path.join(root, 'server'), slow: true });

console.log('\nDatabase');
run('canonical schema preflight', 'npm run preflight:fresh-schema', { cwd: path.join(root, 'server'), slow: true });

check('fresh install from canonical schema', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-release-'));
  const dbPath = path.join(tmp, 'fresh.sqlite');
  const probe = path.join(tmp, 'probe.mjs');
  fs.writeFileSync(probe, `
    import { db, initSchema } from ${JSON.stringify(path.join(root, 'server', 'src', 'db', 'connection.ts'))};
    initSchema();
    // Boot twice: the canonical schema is applied on every start, so a
    // non-idempotent statement would break the second run of every install.
    initSchema();
    const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
    const legacy = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='schema_migrations'").get().c;
    const integrity = db.pragma('integrity_check')[0].integrity_check;
    const fk = db.pragma('foreign_key_check').length;
    console.log('RESULT ' + JSON.stringify({ tables, legacy, integrity, fk }));
  `);
  const out = execSync(`npx tsx ${JSON.stringify(probe)}`, {
    cwd: path.join(root, 'server'), stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test' },
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error('fresh-install probe produced no result');
  const r = JSON.parse(line.slice('RESULT '.length));
  if (r.integrity !== 'ok') throw new Error(`integrity_check = ${r.integrity}`);
  if (r.fk !== 0) throw new Error(`${r.fk} foreign-key violations`);
  if (r.tables < 1) throw new Error('canonical schema created no tables');
  if (r.legacy !== 0) throw new Error('a schema_migrations table reappeared');
  fs.rmSync(tmp, { recursive: true, force: true });
  return `${r.tables} tables, idempotent re-init, integrity ok`;
});

check('financial invariants reconcile', () => {
  // Runs the real reconciliation against a freshly bootstrapped database, so
  // the gate proves the invariants hold on a clean install rather than trusting
  // whatever state a developer's DB happens to be in.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-recon-'));
  const dbPath = path.join(tmp, 'recon.sqlite');
  const probe = path.join(tmp, 'probe.mjs');
  fs.writeFileSync(probe, `
    import { db, initSchema } from ${JSON.stringify(path.join(root, 'server', 'src', 'db', 'connection.ts'))};
    import { computeReconciliation } from ${JSON.stringify(path.join(root, 'server', 'src', 'utils', 'reconciliation.ts'))};
    initSchema();
    db.prepare("INSERT OR IGNORE INTO branches (id,name,location) VALUES ('rg','rg','L')").run();
    const r = computeReconciliation({ branchId: null, isAll: true });
    console.log('RESULT ' + JSON.stringify({
      amount: r.amountVariance, cash: r.cashVariance,
      saving: r.savingVariance, budget: r.budgetVariance, healthy: r.healthy,
    }));
  `);
  const out = execSync(`npx tsx ${JSON.stringify(probe)}`, {
    cwd: path.join(root, 'server'), stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test' },
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error('reconciliation probe produced no result');
  const r = JSON.parse(line.slice('RESULT '.length));
  const bad = ['amount', 'cash', 'saving', 'budget'].filter((k) => Math.abs(r[k]) >= 0.01);
  if (bad.length) throw new Error(`non-zero variance: ${bad.map((k) => `${k}=${r[k]}`).join(', ')}`);
  if (!r.healthy) throw new Error('reconciliation reports unhealthy');
  fs.rmSync(tmp, { recursive: true, force: true });
  return 'amount/cash/saving/budget all 0';
});

console.log('\nBranding');
check('official logo asset present', () => {
  const branding = fs.readFileSync(path.join(root, 'src', 'config', 'branding.ts'), 'utf8');
  const url = /BRAND_LOGO_URL = '([^']+)'/.exec(branding)?.[1];
  if (!url) throw new Error('BRAND_LOGO_URL is not defined in src/config/branding.ts');
  const asset = path.join(root, 'public', url.replace(/^\//, ''));
  if (!fs.existsSync(asset)) {
    throw new Error(`missing ${path.relative(root, asset)} — copy the official PNG there (see public/brand/README.md)`);
  }
  if (fs.statSync(asset).size < 1024) throw new Error('logo asset is suspiciously small; is it a placeholder?');
  return `${(fs.statSync(asset).size / 1024).toFixed(1)} KB`;
});
check('official slogan is exact', () => {
  const branding = fs.readFileSync(path.join(root, 'src', 'config', 'branding.ts'), 'utf8');
  if (!branding.includes("BRAND_SLOGAN = 'Unlock the world with TOEFL'")) {
    throw new Error('BRAND_SLOGAN does not match the official wording');
  }
  return 'Unlock the world with TOEFL';
});

console.log('\nRelease hygiene');
check('no build output or secrets tracked', () => {
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n');
  const forbidden = tracked.filter((f) =>
    /^(dist|server\/dist|server\/data)\//.test(f) || /(^|\/)\.env$/.test(f) || /\.sqlite(-wal|-shm)?$/.test(f));
  if (forbidden.length) throw new Error(`tracked build output/secrets: ${forbidden.slice(0, 5).join(', ')}`);
  return `${tracked.length - 1} files tracked`;
});
check('CI workflow is active', () => {
  // Existence is not activation. An empty `ci.yml`, one that never triggers, or
  // one whose steps call npm scripts that no longer exist would all satisfy a
  // file-exists check while catching nothing — so this asserts the workflow is
  // actually wired: it triggers on push/PR, it invokes the real gate, and every
  // command it will run resolves to a script that exists today.
  const active = path.join(root, '.github', 'workflows');
  const files = fs.existsSync(active) ? fs.readdirSync(active).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (files.length === 0) {
    throw new Error('.github/workflows is empty — ci/github-actions-ci.yml has not been activated, so NO gate runs automatically');
  }

  const scriptsIn = (pkgDir) => {
    const p = path.join(pkgDir, 'package.json');
    return fs.existsSync(p) ? Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).scripts ?? {}) : [];
  };
  const rootScripts = scriptsIn(root);
  const serverScripts = scriptsIn(path.join(root, 'server'));

  let triggers = false;
  let invokesGate = false;
  let commands = 0;
  const missing = [];

  for (const file of files) {
    const lines = fs.readFileSync(path.join(active, file), 'utf8').split('\n');
    const body = lines.join('\n');
    if (/^on:/m.test(body) && /^\s+(push|pull_request):/m.test(body)) triggers = true;

    // Track the nearest `working-directory:` so `npm run x` is resolved against
    // the package that will actually execute it.
    let cwd = 'root';
    for (const line of lines) {
      const wd = line.match(/working-directory:\s*\.?\/?(\S+)/);
      if (wd) cwd = wd[1].replace(/\/$/, '') === 'server' ? 'server' : 'root';
      if (/^\s*(- )?(name|uses|jobs|[a-z-]+):\s*$/.test(line) && !/run:/.test(line)) {
        if (/^\s{2,4}[a-z-]+:\s*$/.test(line)) cwd = 'root'; // new job resets context
      }
      const run = line.match(/run:\s*(.+)$/);
      if (!run) continue;
      const cmd = run[1].trim().replace(/^["']|["']$/g, '');
      if (cmd === '|' || cmd.startsWith('#')) continue;
      commands++;
      if (/npm run release:validate/.test(cmd)) invokesGate = true;
      const named = cmd.match(/npm run ([a-z0-9:_-]+)/i);
      if (named) {
        const script = named[1];
        const pool = cwd === 'server' ? serverScripts : rootScripts;
        // A script may legitimately live in either package; only fail when it
        // exists in neither, which is unambiguously a broken workflow.
        if (!pool.includes(script) && !rootScripts.includes(script) && !serverScripts.includes(script)) {
          missing.push(`${file}: npm run ${script}`);
        }
      }
    }
  }

  if (!triggers) throw new Error('no workflow triggers on push or pull_request — it would never run');
  if (!invokesGate) throw new Error('no workflow step runs `npm run release:validate` — CI would not execute the real gate');
  if (missing.length) throw new Error(`workflow calls scripts that do not exist: ${missing.slice(0, 4).join(', ')}`);
  return `${files.length} workflow(s), ${commands} commands, all resolve, runs release:validate`;
});

const pass = results.filter((r) => r.status === 'PASS').length;
const skip = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${'─'.repeat(58)}`);
console.log(`  ${pass} passed · ${failed} failed · ${skip} skipped`);
if (failed) {
  console.log('\n  RELEASE BLOCKED:');
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`    · ${r.name}`);
  console.log();
  process.exit(1);
}
console.log('\n  RELEASE VALIDATION PASSED\n');
