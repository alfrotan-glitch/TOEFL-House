#!/usr/bin/env node
/**
 * Protocol integrity.
 * ============================================================================
 * The Master Engineering Protocol is registered as immutable project policy. A
 * policy that can be edited silently is not policy — so the normative body
 * (§0–§108) is checksummed, and any change to it fails the release gate until
 * an authorized revision is recorded in the §R table.
 *
 * The subordinate sections below "END OF NORMATIVE BODY" are deliberately NOT
 * checksummed: they hold derived evidence and the Work Package map, which are
 * expected to change as evidence changes.
 *
 *   node scripts/verify-protocol.mjs           verify
 *   node scripts/verify-protocol.mjs --seal    re-seal after an authorized revision
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protocolPath = path.join(root, 'docs', 'MASTER_ENGINEERING_PROTOCOL.md');
const sealPath = path.join(root, 'docs', '.protocol-seal.json');

const NORMATIVE_START = '## NORMATIVE BODY';
const NORMATIVE_END = '## END OF NORMATIVE BODY';

const failures = [];

if (!fs.existsSync(protocolPath)) {
  console.error('PROTOCOL AUDIT: FAIL\n - docs/MASTER_ENGINEERING_PROTOCOL.md is missing. The project has no registered engineering authority.');
  process.exit(1);
}

const text = fs.readFileSync(protocolPath, 'utf8');
const start = text.indexOf(NORMATIVE_START);
const end = text.indexOf(NORMATIVE_END);
if (start === -1 || end === -1 || end < start) {
  console.error('PROTOCOL AUDIT: FAIL\n - the normative body markers are missing or out of order; the protocol cannot be sealed.');
  process.exit(1);
}

const normative = text.slice(start, end);
const digest = crypto.createHash('sha256').update(normative, 'utf8').digest('hex');

// ── Structural completeness: every section the protocol declares must exist ──
const declared = [...normative.matchAll(/^### §(\d+)\b/gm)].map((m) => Number(m[1]));
const missing = [];
for (let n = 0; n <= 108; n += 1) if (!declared.includes(n)) missing.push(n);
if (missing.length) {
  failures.push(`the normative body is incomplete — missing §${missing.join(', §')}.`);
}

// ── The ten Laws must all be present ────────────────────────────────────────
for (let n = 1; n <= 10; n += 1) {
  if (!normative.includes(`**LAW ${n} —`)) failures.push(`LAW ${n} is missing from §2.`);
}

// ── No competing protocol document may exist (LAW 1) ────────────────────────
const superseded = path.join(root, 'docs', 'ENGINEERING_PROTOCOL.md');
if (fs.existsSync(superseded)) {
  failures.push('docs/ENGINEERING_PROTOCOL.md still exists — two engineering authorities violate LAW 1. It is superseded and must be removed.');
}

// ── Seal ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--seal')) {
  const revisions = (text.slice(end).match(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/gm) || []).length;
  fs.writeFileSync(
    sealPath,
    `${JSON.stringify({ sha256: digest, sections: declared.length, revisions, sealedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
  console.log(`PROTOCOL SEALED: ${digest.slice(0, 16)}… (${declared.length} sections)`);
  process.exit(0);
}

if (!fs.existsSync(sealPath)) {
  failures.push('docs/.protocol-seal.json is missing — the protocol has never been sealed. Run `node scripts/verify-protocol.mjs --seal`.');
} else {
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  if (seal.sha256 !== digest) {
    const revisionRows = (text.slice(end).match(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/gm) || []).length;
    failures.push(
      'the NORMATIVE BODY has been modified.\n' +
      `     sealed: ${seal.sha256}\n` +
      `     actual: ${digest}\n` +
      '     The protocol is immutable project policy. If the owner authorized this\n' +
      '     revision, record it in the §R table and re-seal; otherwise revert it.' +
      (revisionRows > (seal.revisions ?? 0) ? '' : '\n     (No new §R revision row was found.)'),
    );
  }
}

if (failures.length) {
  console.error('PROTOCOL AUDIT: FAIL');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log(`PROTOCOL AUDIT: PASS (${declared.length} sections, 10 laws, sealed ${digest.slice(0, 16)}…)`);
