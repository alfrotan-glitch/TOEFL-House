#!/usr/bin/env node
/**
 * Registry validation.
 * ============================================================================
 * The Engineering Protocol (docs/ENGINEERING_PROTOCOL.md §6) says the registries
 * are "the proof, not the prose". A registry that is only prose decays silently:
 * a file gets renamed, a test gets deleted, an endpoint moves, and the table
 * keeps asserting something that stopped being true months ago — which is
 * exactly the class of failure the protocol exists to prevent.
 *
 * So the registries are checked mechanically. Every source path, endpoint and
 * test file named in a registry must exist. Every invariant must name a real
 * enforcement point. A stale registry fails the release gate.
 *
 * This deliberately does NOT try to verify that a claim is *semantically* true —
 * that is what INDEPENDENT REVIEW is for. It verifies that every reference is
 * live, which is the part a machine can do perfectly and a human reliably
 * cannot.
 *
 *   node scripts/verify-registries.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryDir = path.join(root, 'docs', 'registries');

const REQUIRED = ['canonical-authority.md', 'invariants.md', 'metrics.md', 'decisions.md', 'protocol-conflicts.md', 'assumptions.md'];

const failures = [];
const stats = { files: 0, rows: 0, paths: 0, endpoints: 0 };

const fail = (msg) => failures.push(msg);

// ── 0. The registries exist at all ──────────────────────────────────────────
if (!fs.existsSync(registryDir)) {
  console.error('REGISTRY AUDIT: FAIL\n - docs/registries/ is missing entirely.');
  process.exit(1);
}
for (const name of REQUIRED) {
  if (!fs.existsSync(path.join(registryDir, name))) fail(`docs/registries/${name} is missing.`);
}
if (!fs.existsSync(path.join(root, 'docs', 'MASTER_ENGINEERING_PROTOCOL.md'))) {
  fail('docs/MASTER_ENGINEERING_PROTOCOL.md is missing — the registries have no governing document.');
}
if (failures.length) {
  console.error('REGISTRY AUDIT: FAIL');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

/** Markdown table rows, minus the header and the `|---|` separator. */
function tableRows(markdown) {
  return markdown
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s|:-]+\|\s*$/.test(l))
    .map((l) => l.trim().slice(1, -1).split('|').map((c) => c.trim()))
    .filter((cells) => cells.length > 1 && !/^(Concept|Invariant|Metric|Date|#)$/.test(cells[0]));
}

/**
 * Every backtick-quoted token that looks like a repository path.
 * Anything with a slash and a known source extension is treated as a claim that
 * the file exists.
 */
const PATH_RE = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|sql|md))`/g;
const ENDPOINT_RE = /`((?:GET|POST|PUT|PATCH|DELETE)(?:\/[A-Za-z]+)?\s+\/[A-Za-z0-9/:_-]+)`/g;

// Route files, so an endpoint claim can be checked against something real.
const routeSources = fs
  .readdirSync(path.join(root, 'server', 'src', 'routes'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => fs.readFileSync(path.join(root, 'server', 'src', 'routes', f), 'utf8'))
  .join('\n');

/**
 * Every source file in the repo, indexed by basename.
 *
 * A registry cell reads better as `ledger-classification.ts` than as the full
 * path, and a human checking the table would simply go and find that file. The
 * validator does the same, so readability does not cost verifiability.
 */
const byBasename = new Map();
(function index(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'data', 'backups', '.arena'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) index(abs);
    else if (/\.(ts|tsx|mjs|sql|md)$/.test(entry.name)) {
      if (!byBasename.has(entry.name)) byBasename.set(entry.name, []);
      byBasename.get(entry.name).push(path.relative(root, abs));
    }
  }
})(root);

for (const name of REQUIRED) {
  const file = path.join(registryDir, name);
  const text = fs.readFileSync(file, 'utf8');
  stats.files += 1;

  const rows = tableRows(text);
  stats.rows += rows.length;
  if (rows.length === 0) fail(`${name}: contains no data rows — an empty registry is not a registry.`);

  // ── 1. Every referenced source path must exist ────────────────────────────
  for (const [, claimed] of text.matchAll(PATH_RE)) {
    const resolved = claimed.includes('/')
      ? fs.existsSync(path.join(root, claimed))
      : byBasename.has(path.basename(claimed));
    if (!resolved) {
      fail(`${name}: references \`${claimed}\`, which does not exist anywhere in the repository.`);
    }
    stats.paths += 1;
  }

  // ── 2. Every referenced endpoint must be registered by some router ────────
  for (const [, claimed] of text.matchAll(ENDPOINT_RE)) {
    const routePath = claimed.split(/\s+/)[1];
    // A router is mounted under a prefix, so it declares only the tail:
    // `/api/finance/pnl` and `/finance/pnl` both reach `financeRouter.get('/pnl')`.
    // Strip an optional `/api` and then the mount segment.
    const tail = routePath.replace(/^\/api\b/, '').replace(/^\/[a-z-]+/, '');
    const needle = tail === '' ? '/' : tail;
    if (!routeSources.includes(`'${needle}'`)) {
      fail(`${name}: references endpoint \`${claimed}\`, but no router declares '${needle}'.`);
    }
    stats.endpoints += 1;
  }
}

// ── 3. Registry-specific shape rules ────────────────────────────────────────
const invariants = tableRows(fs.readFileSync(path.join(registryDir, 'invariants.md'), 'utf8'));
for (const row of invariants) {
  const [invariant, ownerLayer, enforcement, test, behaviour] = row;
  if (!ownerLayer || !enforcement || !test || !behaviour) {
    fail(`invariants.md: "${invariant}" has an empty column — an invariant with no enforcement point or no test is a wish.`);
  }
  if (/^\s*(TBD|-|—|\?)\s*$/i.test(enforcement) || /^\s*(TBD|-|—|\?)\s*$/i.test(test)) {
    fail(`invariants.md: "${invariant}" still has a placeholder in its enforcement point or test.`);
  }
}

const authority = tableRows(fs.readFileSync(path.join(registryDir, 'canonical-authority.md'), 'utf8'));
for (const row of authority) {
  if (/TBD/i.test(row.join(' '))) fail(`canonical-authority.md: "${row[0]}" still contains TBD.`);
  if (row[row.length - 1] !== 'AUTHORITATIVE') {
    fail(`canonical-authority.md: "${row[0]}" is not marked AUTHORITATIVE — every concept needs one settled owner.`);
  }
}

const metrics = tableRows(fs.readFileSync(path.join(registryDir, 'metrics.md'), 'utf8'));
for (const row of metrics) {
  if (/TBD/i.test(row.join(' '))) fail(`metrics.md: "${row[0]}" still contains TBD.`);
}

// The clean-slate exception must stay explicitly scoped and spent. If somebody
// widens it into a standing licence, the protocol's default has silently flipped.
const decisions = fs.readFileSync(path.join(registryDir, 'decisions.md'), 'utf8');
if (decisions.includes('Clean-slate exception') && !/Spent/i.test(decisions)) {
  fail('decisions.md: the clean-slate exception is recorded but no longer marked as spent/scoped.');
}
if (!/Tracked risks/i.test(decisions)) {
  fail('decisions.md: the tracked-risk section is missing — READY WITH TRACKED RISK has nowhere to land.');
}

// ── verdict ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error('REGISTRY AUDIT: FAIL');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log(
  `REGISTRY AUDIT: PASS (${stats.files} registries, ${stats.rows} rows, ` +
  `${stats.paths} path references, ${stats.endpoints} endpoint references, all live)`,
);
