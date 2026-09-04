#!/usr/bin/env node
/**
 * WP-10 mutation harness — Book quantity, availability and capability guards.
 *
 * Each mutation restores a defect that the WP-10 attack suite must detect. The
 * harness modifies one authoritative source, runs the package attack authority,
 * and restores the exact original source before the next mutation.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SERVICE = 'src/core/books/books-service.ts';
const SCHEMA = 'src/db/schema.sql';
const TEST = 'src/tests/work-packages/wp10/books-authority.attack.test.ts';

// K2 is execution-proven equivalent: negative values are rejected by
// assertSeatCount before this branch; zero reaches the existing gross/discount
// boundary (`0 >= 0`) and still receives HTTP 400 before any write. The explicit
// branch remains for the clearer quantity-specific error and defence in depth.
const EQUIVALENT = new Set(['K2']);

const MUTANTS = [
  ['K1', 'coerce arbitrary sale quantities instead of using the canonical whole-copy parser', SERVICE,
    'quantity = assertSeatCount(value, field);', 'quantity = Number(value);'],
  ['K2', 'accept zero and negative physical quantities', SERVICE,
    "if (quantity <= 0) throw new HttpError(400, `${field} must be a positive whole number.`);",
    "if (false) throw new HttpError(400, `${field} must be a positive whole number.`);"],
  ['K3', 'remove the sale availability capacity condition from the database trigger', SCHEMA,
    '    < NEW.quantity\n  )\nBEGIN SELECT RAISE(ABORT, \'Book sale is invalid, unavailable, cross-branch, archived, or unkeyed\'); END;',
    '    < 0\n  )\nBEGIN SELECT RAISE(ABORT, \'Book sale is invalid, unavailable, cross-branch, archived, or unkeyed\'); END;'],
  ['K4', 'permit sale of a lending-only catalog item', SCHEMA,
    "  OR (SELECT sale_enabled FROM books WHERE id = NEW.book_id) IS NOT 1\n  OR (SELECT sale_price FROM books WHERE id = NEW.book_id) IS NOT NEW.unit_price",
    "  OR false\n  OR false"],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const originals = new Map([[SERVICE, readFileSync(SERVICE, 'utf8')], [SCHEMA, readFileSync(SCHEMA, 'utf8')]]);
const backups = new Map();
for (const [file] of originals) {
  const backup = `/tmp/${file.replace(/\W/g, '_')}.bak`;
  copyFileSync(file, backup);
  backups.set(file, backup);
}
const restore = () => { for (const [file, source] of originals) writeFileSync(file, source); };

const results = [];
try {
  for (const [id, description, file, find, replacement] of MUTANTS) {
    if (only && id !== only) continue;
    const source = originals.get(file);
    if (!source?.includes(find)) {
      results.push([id, description, 'INVALID']);
      console.log(`${id.padEnd(4)} ${description.padEnd(64)} INVALID (anchor)`);
      continue;
    }
    writeFileSync(file, source.replace(find, replacement));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-cache --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch {
      verdict = 'KILLED';
    }
    results.push([id, description, verdict]);
    console.log(`${id.padEnd(4)} ${description.padEnd(64)} ${verdict}`);
    restore();
  }
} finally {
  restore();
  for (const backup of backups.values()) if (existsSync(backup)) unlinkSync(backup);
}

const survivors = results.filter((result) => result[2].includes('SURVIVED') && !EQUIVALENT.has(result[0]));
const equivalent = results.filter((result) => result[2].includes('SURVIVED') && EQUIVALENT.has(result[0]));
const invalid = results.filter((result) => result[2] === 'INVALID');
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((result) => result[0]).join(', ')}`);
console.log(`\n${results.filter((result) => result[2] === 'KILLED').length}/${results.length} killed, ${survivors.length} non-equivalent survivors, ${invalid.length} invalid`);
process.exit(survivors.length || invalid.length ? 1 : 0);
