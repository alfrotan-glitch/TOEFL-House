#!/usr/bin/env node
/**
 * CFG-1 mutation harness for the discount authorization boundary.
 *
 * Each mutant is a targeted weakening of an invariant in discount-authority.ts.
 * A mutant is KILLED when the regression suite fails. A SURVIVOR means the
 * suite cannot detect that weakening and the coverage claim is false.
 * Survivors may only be called equivalent by execution, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = 'src/core/configuration/discount-authority.ts';
const BAK = '/tmp/discount-authority.bak.ts';
const TEST = 'src/tests/discount-authorization-boundary.test.ts';

const MUTANTS = [
  ['M1',  'ordinary ceiling 20 -> 100',            'export const ORDINARY_MAX = 20;', 'export const ORDINARY_MAX = 100;'],
  ['M2',  'ambassador max 15 -> 100',              'COURSE_AMBASSADOR: 15,', 'COURSE_AMBASSADOR: 100,'],
  ['M3',  '2nd-degree max 50 -> 100',              'SECOND_DEGREE_RELATIVE: 50,', 'SECOND_DEGREE_RELATIVE: 100,'],
  ['M4',  'family max 50 -> 100',                  'FAMILY_OF_FOUR_PLUS: 50,', 'FAMILY_OF_FOUR_PLUS: 100,'],
  ['M5',  'family minimum 4 -> 1',                 'export const FAMILY_MIN_MEMBERS = 4;', 'export const FAMILY_MIN_MEMBERS = 1;'],
  ['M6',  'status check removed (revoked works)',  "if (row.status !== 'active') return false;", "if (false) return false;"],
  ['M7',  'effective_from ignored',                'if (row.effective_from && row.effective_from > today) return false;', 'if (false) return false;'],
  ['M8',  'effective_to ignored (expired works)',  'if (row.effective_to && row.effective_to < today) return false;', 'if (false) return false;'],
  ['M9',  'branch scope ignored',                  'if (studentBranchId && row.branch_id !== studentBranchId) return false;', 'if (false) return false;'],
  ['M10', 'eligibility check always passes',       'const degree = row.category ===', 'return true; const degree = row.category ==='],
  ['M11', 'family member count comparison flipped','>= FAMILY_MIN_MEMBERS', '>= 0'],
  ['M12', 'category max not applied to grant',     'const categoryMax = CATEGORY_MAX[row.category] ?? ORDINARY_MAX;', 'const categoryMax = 100;'],
  ['M13', 'ordinary clamp removed',                'const percent = Math.min(requested, ORDINARY_MAX);', 'const percent = requested;'],
  ['M14', 'relation degree ignored',               'AND degree = ? LIMIT 1', 'AND degree >= 0 LIMIT 1'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
copyFileSync(SRC, BAK);
const original = readFileSync(SRC, 'utf8');
const results = [];
try {
  for (const [id, desc, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    if (!original.includes(find)) { results.push([id, desc, 'INVALID (anchor not found)']); continue; }
    writeFileSync(SRC, original.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(5)} ${desc.padEnd(42)} ${verdict}`);
    writeFileSync(SRC, original);
  }
} finally {
  writeFileSync(SRC, original);
  if (existsSync(BAK)) unlinkSync(BAK);
}
const survived = results.filter(r => r[2].includes('SURVIVED'));
console.log(`\n${results.filter(r => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
