#!/usr/bin/env node
/**
 * CLASS SUBSYSTEM — MUTATION TESTING HARNESS
 * ============================================================================
 * Green tests prove nothing on their own: they prove the code passes, not that
 * the tests would notice if the code stopped guarding. This harness deletes or
 * weakens each critical Class invariant one at a time and requires the suite to
 * FAIL. A surviving mutant means the invariant is unprotected by tests.
 *
 * Usage: node scripts/class-mutation-test.mjs
 * Exit 0 = every mutant KILLED. Exit 1 = at least one SURVIVED.
 *
 * The harness restores every file from the on-disk original after each run,
 * including on crash/interrupt, so it can never leave a mutated tree behind.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');

const F = {
  lifecycle: 'src/core/academic/class-lifecycle-service.ts',
  classes: 'src/routes/classes.routes.ts',
  students: 'src/routes/students.routes.ts',
  capacity: 'src/core/academic/class-capacity.ts',
  admission: 'src/core/academic/class-admission.ts',
  money: 'src/utils/money.ts',
};

/**
 * Each mutant removes ONE guard. `find` must match exactly once so a mutation
 * can never silently no-op (a no-op mutation would look "killed" for the wrong
 * reason, or "survive" while having changed nothing).
 */
const MUTANTS = [
  {
    id: 'M1',
    invariant: 'C-1 roster-drain guard on cancellation',
    file: F.lifecycle,
    find: 'if (ROSTER_DRAIN_GUARDED_STAGES.includes(to)) {',
    replace: 'if (false && ROSTER_DRAIN_GUARDED_STAGES.includes(to)) {',
  },
  {
    id: 'M2',
    invariant: 'C-1 guard counts seat-consuming statuses (not just active)',
    file: F.lifecycle,
    find: "        WHERE class_id = ? AND status IN (${SEAT_STATUS_SQL})`,",
    replace: "        WHERE class_id = ? AND status = 'nonexistent_status'`,",
  },
  {
    id: 'M3',
    invariant: 'C-2 merge gender admission gate',
    file: F.classes,
    find: '        assertClassGenderAllows({ gender_policy: target.gender_policy, name: target.name }, student.gender);',
    replace: '        void assertClassGenderAllows; void student;',
  },
  {
    id: 'M4',
    invariant: 'C-3 fee validation on PUT /classes/:id',
    file: F.classes,
    find: "    const nextFee = hasLevelRule ? existing.fee : (fee == null ? existing.fee : assertMoney(fee, 'class fee'));",
    replace: '    const nextFee = hasLevelRule ? existing.fee : (fee ?? existing.fee);',
  },
  {
    id: 'M5',
    invariant: 'C-3 capacity validation on PUT /classes/:id',
    file: F.classes,
    find: "    const nextCapacity = hasRoomRule ? existing.capacity : (capacity == null ? existing.capacity : assertSeatCount(capacity, 'Class capacity'));",
    replace: '    const nextCapacity = hasRoomRule ? existing.capacity : (capacity ?? existing.capacity);',
  },
  {
    id: 'M6',
    invariant: 'C-3 seat counts must be whole numbers',
    file: F.money,
    find: "  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number of seats.`);",
    replace: '  // mutant: integrality check removed',
  },
  {
    id: 'M7',
    invariant: 'C-5 merge preserves operator notes',
    file: F.classes,
    find: `      notes = CASE
                    WHEN notes IS NULL OR TRIM(notes) = '' THEN ?
                    ELSE notes || char(10) || ?
                  END`,
    replace: '      notes = CASE WHEN 1=1 THEN ? ELSE ? END',
  },
  {
    id: 'M8',
    invariant: 'C-6 extra-class payment idempotency key',
    file: F.students,
    find: "student.branch_id, null, null, null, `extra-class:${enrollId}`);",
    replace: "student.branch_id, null, null, null, `extra-class:${enrollId}:${Math.random()}`);",
  },
  {
    id: 'M9',
    invariant: 'C-7 pagination window is applied',
    file: F.classes,
    find: '    const page = mapped.slice(offset, offset + limit);',
    replace: '    const page = mapped; void offset; void limit;',
  },
  {
    id: 'M10',
    invariant: 'capacity gate on enrollment (pre-existing, must stay protected)',
    file: F.students,
    find: "  if (classCapacity > 0 && classEnrollmentCount >= classCapacity) throw new HttpError(409, 'Class is full.');",
    replace: '  void classCapacity; void classEnrollmentCount;',
  },
  {
    id: 'M11',
    invariant: 'duplicate-seat guard on extra-class enrollment',
    file: F.students,
    find: '  assertNotAlreadySeatedInClass(db, student.id, classId);',
    replace: '  void assertNotAlreadySeatedInClass;',
  },
  {
    id: 'M12',
    invariant: 'branch isolation on class access',
    file: F.classes,
    find: "    if (!cross) throw new HttpError(403, 'Class belongs to another branch.');",
    replace: '    void cross;',
  },
  {
    id: 'M13',
    invariant: 'teacher object-level authorization on classes',
    file: F.classes,
    find: '  if (isClassTeacherScoped(req)) assertClassAccess(req, classId);',
    replace: '  void isClassTeacherScoped; void assertClassAccess;',
  },
  {
    id: 'M14',
    invariant: 'merge capacity check',
    file: F.classes,
    find: '    if (enrolled > free) {',
    replace: '    if (false && enrolled > free) {',
  },
  {
    id: 'M15',
    invariant: 'merge transaction boundary (atomicity)',
    file: F.classes,
    find: '    const mergeTx = db.transaction(() => {',
    replace: '    const mergeTx = ((fn) => fn)(() => {',
  },
  {
    id: 'M16',
    invariant: 'canonical seat predicate (capacity single source of truth)',
    file: F.capacity,
    find: "export const ACTIVE_ENROLLMENT_STATUSES = ['active', 'confirmed', 'pending'] as const;",
    replace: "export const ACTIVE_ENROLLMENT_STATUSES = ['active'] as const;",
  },
  {
    id: 'M17',
    invariant: 'delete guard blocks classes holding live enrollments',
    file: F.classes,
    find: '    if (enrolled > 0) {',
    replace: '    if (false && enrolled > 0) {',
  },
  {
    id: 'M18',
    invariant: 'gender admission rule itself (shared domain authority)',
    file: F.admission,
    find: "  if (policy === 'female' && g !== 'female') {",
    replace: "  if (false && policy === 'female' && g !== 'female') {",
  },
];

const TEST_CMD = 'npx vitest run --silent 2>&1';

function read(file) {
  return readFileSync(path.join(SERVER, file), 'utf8');
}
function write(file, content) {
  writeFileSync(path.join(SERVER, file), content);
}

// Snapshot every file we may touch, once, before anything is mutated.
const ORIGINALS = new Map();
for (const file of new Set(MUTANTS.map((m) => m.file))) ORIGINALS.set(file, read(file));
const restoreAll = () => { for (const [file, content] of ORIGINALS) write(file, content); };

// RESTORE ON EVERY EXIT PATH. A mutated tree must never outlive this process.
// `finally` alone is not enough: SIGKILL of a parent shell, an uncaught throw,
// or a killed child can end the run between "write mutant" and "write
// original". During this audit a harness killed mid-mutation left exactly one
// mutant (M7) behind in the source tree, which then surfaced as a mysterious
// failing test. Every one of these hooks restores before exiting, and each
// mutant is additionally verified restored immediately after its own run.
let restored = false;
const restoreOnce = () => { if (!restored) { restored = true; restoreAll(); } };
process.on('exit', restoreOnce);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => { restoreOnce(); process.exit(1); });
}
process.on('uncaughtException', (e) => { restoreOnce(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restoreOnce(); console.error(e); process.exit(1); });

console.log('CLASS SUBSYSTEM — MUTATION TESTING');
console.log('='.repeat(78));
console.log(`${MUTANTS.length} mutants. A mutant must be KILLED (suite fails) to prove coverage.\n`);

// ── GREEN-BASELINE PRECONDITION ────────────────────────────────────────────
// A mutant is "killed" when the suite fails. If the suite ALREADY fails on
// unmutated code, every mutant is reported killed and the whole run is
// meaningless — a false all-green. (This exact trap fired during the audit:
// leftover forensic probe files carried failing tests.) Verify the baseline is
// green before mutating anything, and refuse to run otherwise.
process.stdout.write('Verifying unmutated baseline is GREEN ... ');
try {
  execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
  console.log('OK\n');
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`;
  console.log('FAILED\n');
  console.error('ABORT: the test suite does not pass on unmutated code, so every');
  console.error('mutant would be reported KILLED for the wrong reason. Fix the suite first.\n');
  console.error(out.split('\n').slice(-25).join('\n'));
  process.exit(2);
}

const results = [];
try {
  for (const m of MUTANTS) {
    const original = ORIGINALS.get(m.file);
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      results.push({ ...m, status: 'INVALID', detail: `pattern matched ${occurrences}x (expected exactly 1)` });
      console.log(`${m.id}  INVALID  ${m.invariant} — pattern matched ${occurrences}x`);
      continue;
    }

    write(m.file, original.replace(m.find, m.replace));
    let killed = false;
    let detail = '';
    try {
      execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
      detail = 'suite still passed';
    } catch (err) {
      killed = true;
      const out = `${err.stdout || ''}${err.stderr || ''}`;
      const m2 = out.match(/Tests\s+(\d+)\s+failed/);
      detail = m2 ? `${m2[1]} test(s) failed` : 'suite failed';
    } finally {
      write(m.file, original);
      // Verify the restore actually landed. A silent failure here would leave a
      // mutant in the tree and poison every later result.
      if (read(m.file) !== original) {
        console.error(`\nFATAL: failed to restore ${m.file} after ${m.id}. Aborting.`);
        restoreAll();
        process.exit(3);
      }
    }

    results.push({ ...m, status: killed ? 'KILLED' : 'SURVIVED', detail });
    console.log(`${m.id}  ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.invariant} (${detail})`);
  }
} finally {
  restoreAll();
}

console.log('\n' + '='.repeat(78));
const killed = results.filter((r) => r.status === 'KILLED').length;
const survived = results.filter((r) => r.status === 'SURVIVED');
const invalid = results.filter((r) => r.status === 'INVALID');
console.log(`KILLED: ${killed}/${results.length}   SURVIVED: ${survived.length}   INVALID: ${invalid.length}`);
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing test coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
if (invalid.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalid) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalid.length === 0 ? 0 : 1);
