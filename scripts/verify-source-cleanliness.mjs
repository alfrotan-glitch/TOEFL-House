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

/**
 * Characters after which a `/` opens a regular expression rather than dividing.
 * An empty string covers the start of the file.
 */
const REGEX_ALLOWED_AFTER = /^$|[(,=:[!&|?{};+\-*%~^<>/]/;

/**
 * Keywords after which a `/` also opens a regex — `return /re/`, `case /re/`.
 * The character test alone is not enough: the last character of `return` is a
 * letter, which reads as "after a value", i.e. division. Missing this left the
 * very first file I tested still desynchronized.
 */
const REGEX_ALLOWED_AFTER_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await|throw)\s*$/;

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
  let prevSignificant = '';
  while (i < n) {
    const c = src[i];

    // A regex literal must be consumed as a unit. `/["]/` contains a quote
    // character, and treating that quote as the start of a string leaves the
    // scanner inside a phantom string for the rest of the file — every comment
    // after it silently unscanned. That blind spot was real: it hid nine
    // narrative comments in students.routes.ts while this audit reported PASS.
    //
    // Whether `/` opens a regex or divides depends on what came before it;
    // after a value (identifier, literal, closing bracket) it is division,
    // otherwise it is a regex. That is the standard disambiguation and it is
    // sufficient here.
    const regexPosition =
      REGEX_ALLOWED_AFTER.test(prevSignificant) ||
      REGEX_ALLOWED_AFTER_KEYWORD.test(src.slice(Math.max(0, i - 12), i));
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && regexPosition) {
      i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        else if (r === '\n') break; // unterminated: not a regex after all
        i++;
      }
      prevSignificant = '/';
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      prevSignificant = quote;
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
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return mask;
}

function activeSourceFiles() {
  // Tracked AND new-but-not-ignored files. `git ls-files` alone lists only
  // tracked paths, so a brand-new file could introduce narrative and the audit
  // would report PASS until the commit that added it had already landed —
  // which is precisely when a gate is supposed to speak.
  const out = execSync(
    "git ls-files --cached --others --exclude-standard 'server/src/**/*.ts' 'src/**/*.ts' 'src/**/*.tsx'",
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
