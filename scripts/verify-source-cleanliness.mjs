#!/usr/bin/env node
/**
 * SOURCE CLEANLINESS AUDIT — Master Engineering Protocol §3, §4
 * ============================================================================
 * §4: "Active source contains no historical narrative. Remove obsolete
 * comments ... unless genuinely required to understand the current
 * architecture. Comments explain current intent, not historical suffering."
 *
 * WHAT THIS CHECKS, AND WHY IT IS NARROW
 *
 * Comments are prose, and prose cannot be graded mechanically. A regex cannot
 * tell whether an explanation is load-bearing. So this audit does not attempt
 * to judge quality. It bans a short list of PHRASES that can only be talking
 * about the past, and it says nothing about anything else:
 *
 *   legacy, deprecated, backward(s) compatible, workaround, old
 *   implementation, temporary/temp fix, TODO, FIXME, HACK, XXX,
 *   previously, used to, formerly
 *
 * Deliberately NOT banned, after measuring them:
 *
 *   "historical" / "historically" — a completed enrollment IS a historical
 *     record and a Shamsi month IS a historical period. Banning the word
 *     would force domain prose to be reworded into something worse.
 *   "no longer" — "a term the student is no longer attending" describes the
 *     present, not the repository's past.
 *   "be used to <verb>" — "this cannot be used to enumerate another branch's
 *     leads" is the verb "use". Only the past-tense sense is banned.
 *
 * The list errs toward silence. A comment can still narrate history without
 * using any of these words, and this audit will not catch it — that is a
 * reviewer's job. What it guarantees is that the specific vocabulary of
 * historical suffering cannot return unnoticed.
 *
 * SCOPE: active runtime source only — server/src (excluding tests) and src.
 * Tests are excluded because a regression test's whole purpose is to describe
 * the defect it pins, and `scripts/` is excluded because console output and
 * migration-era tooling notes are its subject matter.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BANNED = [
  { name: 'legacy', re: /\blegac(?:y|ies)\b/i },
  { name: 'deprecated', re: /\bdeprecat\w*/i },
  { name: 'backward-compatibility', re: /\bbackwards?[-\s]compat\w*/i },
  { name: 'workaround', re: /\bwork[-\s]?around\b/i },
  { name: 'old implementation', re: /\bold implementation\b/i },
  { name: 'temporary fix', re: /\btemp(?:orary)? fix\b/i },
  { name: 'TODO/FIXME/HACK/XXX', re: /\b(?:TODO|FIXME|HACK|XXX)\b/ },
  { name: 'previously', re: /\bpreviously\b/i },
  // Negative lookbehind for "be ": "cannot be used to enumerate" is the verb
  // "use", not the past tense. Without it the audit rewrites correct prose.
  { name: 'used to', re: /(?<!\bbe )\bused to\b/i },
  { name: 'formerly', re: /\bformerly\b/i },
];

/**
 * Marks every character that lies inside a comment.
 *
 * String literals are skipped first, so an error message that legitimately
 * contains one of these words — `'Fee rules are legacy data'` — is not read as
 * a comment. Getting this wrong in the other direction (grepping whole lines)
 * is what produced the original, badly inflated counts for this conflict.
 */
function commentMask(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') mask[i++] = 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      mask[i] = 1;
      mask[i + 1] = 1;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) mask[i++] = 1;
      if (i < n) {
        mask[i] = 1;
        mask[i + 1] = 1;
      }
      i += 2;
      continue;
    }
    i++;
  }
  return mask;
}

function activeSourceFiles() {
  const out = execSync(
    "git ls-files 'server/src/**/*.ts' 'src/**/*.ts' 'src/**/*.tsx'",
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('server/src/tests/'));
}

const findings = [];
let scanned = 0;
let commentLines = 0;

for (const file of activeSourceFiles()) {
  const src = readFileSync(file, 'utf8');
  const mask = commentMask(src);
  const lines = src.split('\n');
  let offset = 0;
  scanned++;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let comment = '';
    for (let k = 0; k < line.length; k++) if (mask[offset + k]) comment += line[k];
    if (comment.trim()) {
      commentLines++;
      for (const { name, re } of BANNED) {
        if (re.test(comment)) {
          findings.push({ file, line: i + 1, term: name, text: line.trim().slice(0, 120) });
        }
      }
    }
    offset += line.length + 1;
  }
}

if (findings.length > 0) {
  console.error('SOURCE CLEANLINESS AUDIT: FAIL\n');
  console.error(`${findings.length} historical-narrative comment(s) in active source:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.term}]`);
    console.error(`      ${f.text}`);
  }
  console.error(
    '\n§4 — comments explain current intent, not historical suffering.',
  );
  console.error(
    'State what the code does and why it must be that way. If the reason is a',
  );
  console.error(
    'defect that was fixed, the test that pins it is where that story belongs.',
  );
  process.exit(1);
}

console.log(
  `SOURCE CLEANLINESS AUDIT: PASS (${scanned} files, ${commentLines} comment lines, ${BANNED.length} banned phrases)`,
);
