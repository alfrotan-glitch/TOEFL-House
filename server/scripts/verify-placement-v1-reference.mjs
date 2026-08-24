#!/usr/bin/env node
/**
 * Fresh-database verification for the Placement V1 reference configuration.
 * ============================================================================
 * Proves the contract the repository promises: a clone of this repo, an empty
 * database, and the canonical bootstrap reproduce the COMPLETE reference
 * Placement Test V1 configuration from tracked fixtures alone.
 *
 * Pipeline (fully automated, entirely inside a throwaway temp directory):
 *
 *   1. Create an empty temp directory + fresh SQLite database path.
 *   2. Run the canonical bootstrap (`npm run seed`) against it — schema,
 *      organization hierarchy, owner account. Nothing else.
 *   3. Rotate the initial owner password through the real auth router (the
 *      initial credential is API-quarantined by design).
 *   4. Run the canonical importer (`importPlacementReference`) in-process.
 *   5. Assert the complete configuration against the fixtures: academic tree,
 *      fees, rubrics, media, banks (94 questions), placement profile with the
 *      canonical blueprint and CEFR ladder — including a replay of every
 *      blueprint bucket's satisfiability against the imported banks.
 *   6. ATTACK: delete the placement profile and one bank, rerun the importer,
 *      and assert it repairs exactly the missing objects without duplicating
 *      anything (idempotent self-healing on partial state).
 *   7. Functional smoke: synthetic candidate → admission → DIGITAL attempt
 *      assembles the blueprint snapshot (30/20/20/1/1 items, rubrics present,
 *      no answer keys leaked) → attempt cancelled. Lives only in the throwaway
 *      database; no candidates, attempts, payments, audit history or PII ship
 *      in the fixtures or the repository.
 *   8. Remove the temp directory and exit 0 (PASS) or 1 (FAIL).
 *
 * Usage: npm --prefix server run verify:placement-reference
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const fixtureDir = path.resolve(serverDir, 'fixtures/placement-v1');

const failures = [];
const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'toefl-placement-verify-'));
const dbPath = path.join(tempDir, 'erp.sqlite');
const ownerUsername = 'owner';
const initialPassword = `Verify!Initial-${randomUUID().slice(0, 8)}`;
const finalPassword = `Verify!Final-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  DB_PATH: dbPath,
  JWT_SECRET: `verify-secret-${randomUUID()}`,
  SEED_OWNER_USERNAME: ownerUsername,
  SEED_OWNER_PASSWORD: initialPassword,
  SEED_OWNER_NAME: 'Verification Owner',
  SEED_OWNER_EMAIL: 'verify@toeflhouse.local',
  BACKUP_LOCAL_DIR: path.join(tempDir, 'backups'),
  BACKUP_EXTERNAL_DIR: path.join(tempDir, 'external-backups'),
};

// Shared SQLite connection handle; assigned once the importer's module graph
// opens the database (step [2/6]), so the exit handler can close it before the
// temp directory is removed — Windows refuses to delete files that are open.
let sqlite = null;

process.on('exit', () => {
  try {
    sqlite?.db.close();
  } catch {
    /* best effort; the process is exiting anyway */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort; temp dir lives in os.tmpdir() */
  }
});

function die(message) {
  console.error(`\nverify:placement-reference FAILED: ${message}`);
  process.exit(1);
}

// ── 1–2. Canonical bootstrap against the empty database ────────────────────
console.log('\n[1/6] Canonical bootstrap on a fresh database (tsx src/db/seed.ts)');
// Spawn the seed script through the local tsx CLI with the current Node
// executable. This is deliberately shell-free: on Windows `spawnSync('npm')`
// cannot execute `npm.cmd` without a shell, which failed with a silent ENOENT
// (stdout/stderr undefined). `process.execPath` plus the tsx `bin` entry is
// identical on every platform and adds no shell-quoting surface.
const tsxCli = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) {
  die(
    `tsx CLI not found at ${tsxCli}. Install server dependencies first: npm --prefix server ci`,
  );
}
const seed = spawnSync(process.execPath, [tsxCli, 'src/db/seed.ts'], {
  cwd: serverDir,
  env,
  encoding: 'utf8',
});
if (seed.status !== 0) {
  die(
    `bootstrap failed — exit code ${seed.status ?? 'null'}` +
      (seed.error ? `, spawn error ${seed.error.code ?? ''} ${seed.error.message}` : ', no spawn error') +
      `\n--- seed stdout ---\n${seed.stdout ?? '(no stdout)'}` +
      `\n--- seed stderr ---\n${seed.stderr ?? '(no stderr)'}`,
  );
}
console.log('  PASS   schema + hierarchy + owner account created');

// ── 3–4. Import through the canonical routers, in-process ──────────────────
console.log('\n[2/6] Import reference configuration through the canonical importer');
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = env.JWT_SECRET;
const { createImporterApp, importPlacementReference, DEFAULT_FIXTURE_DIR } = await import(
  './import-placement-v1-reference.mjs'
);
sqlite = await import('../src/db/connection.js');
check('fixture directory resolves inside the repository', DEFAULT_FIXTURE_DIR.startsWith(serverDir));

const app = createImporterApp();
// Rotate the quarantined initial credential through the real auth surface.
const rotate = await (async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login1 = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ownerUsername, password: initialPassword }),
    }).then((r) => r.json());
    const changed = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
      body: JSON.stringify({ currentPassword: initialPassword, newPassword: finalPassword }),
    });
    return changed.status === 200;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})();
check('initial owner credential rotated through /api/auth/change-password', rotate);

const first = await importPlacementReference({
  app,
  username: ownerUsername,
  password: finalPassword,
  log: (line) => console.log(line),
});
const firstWrites = first.steps.filter((s) => s.status === 'created' || s.status === 'activated').length;
check('first import writes the full configuration', firstWrites > 0, `${firstWrites} object(s) written`);

// ── 5. Assert the complete configuration against the fixtures ─────────────
console.log('\n[3/6] Verify the imported configuration against the fixtures');
const fixtures = {
  academic: JSON.parse(readFileSync(path.join(fixtureDir, 'academic.json'), 'utf8')),
  feeRules: JSON.parse(readFileSync(path.join(fixtureDir, 'fee-rules.json'), 'utf8')),
  rubrics: JSON.parse(readFileSync(path.join(fixtureDir, 'rubrics.json'), 'utf8')),
  banks: JSON.parse(readFileSync(path.join(fixtureDir, 'banks.json'), 'utf8')),
  profile: JSON.parse(readFileSync(path.join(fixtureDir, 'placement-profile.json'), 'utf8')),
  manifest: JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8')),
};

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const token = (
  await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ownerUsername, password: finalPassword }),
  }).then((r) => r.json())
).token;
async function api(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const get = (pathname) => api('GET', pathname);

const programs = (await get('/api/academic/programs')).body;
const program = programs.find((row) => row.code === fixtures.academic.program.code);
check('program exists', Boolean(program), fixtures.academic.program.name);

const levels = (await get(`/api/academic/levels?programId=${program.id}`)).body;
eq('five CEFR levels A1–C1 in order', levels.map((l) => l.code).sort(), ['A1', 'A2', 'B1', 'B2', 'C1']);
eq(
  'level names match fixture',
  ['A1', 'A2', 'B1', 'B2', 'C1'].map((code) => levels.find((l) => l.code === code)?.name),
  fixtures.academic.levels.map((l) => l.name),
);
const levelIdByCode = new Map(levels.map((l) => [l.code, l.id]));

const versions = (await get(`/api/catalog/program-versions?programId=${program.id}`)).body;
const version = versions.find((row) => (row.version_label ?? row.versionLabel) === fixtures.academic.programVersion.versionLabel);
check('program version published', version?.status === 'published', `${version?.status}`);

const fees = (await get(`/api/catalog/fee-rules?branchId=${first.branchId}`)).body;
for (const rule of fixtures.feeRules) {
  const row = fees.find((f) => f.feeType === rule.feeType && f.name === rule.name);
  check(`fee rule ${rule.feeType}`, Boolean(row) && row.amount === rule.amount && row.isActive === true);
}

const rubrics = (await get('/api/placement/rubrics')).body;
for (const rubric of fixtures.rubrics) {
  const row = rubrics.find((r) => r.title === rubric.title);
  check(`rubric ${rubric.kind}`, Boolean(row));
  if (row) {
    eq(`${rubric.kind} criteria`, row.criteria, rubric.criteria);
    const total = row.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    eq(`${rubric.kind} rubric weights total 100`, total, 100);
  }
}

const mediaList = (await get('/api/placement/media')).body;
const asset = fixtures.manifest.assets[0];
const assetSha = createHash('sha256').update(readFileSync(path.join(fixtureDir, asset.file))).digest('hex');
const media = mediaList.find((m) => m.sha256 === assetSha);
check('listening audio asset present (sha-256 match)', Boolean(media));
if (media) {
  const mediaFetch = await fetch(`${base}${media.url}`, { headers: { Authorization: `Bearer ${token}` } });
  check('listening audio asset downloadable', mediaFetch.status === 200, `${media.mime}`);
}

const banks = (await get('/api/placement/test-bank')).body;
eq('five banks active', banks.filter((b) => b.status === 'active').length, 5);
let questionTotal = 0;
const bankIdByFixtureKey = new Map();
for (const bank of fixtures.banks) {
  const row = banks.find((b) => b.title === bank.title && b.testType === bank.testType);
  check(`bank ${bank.fixtureKey} active`, row?.status === 'active');
  if (!row) continue;
  bankIdByFixtureKey.set(bank.fixtureKey, row.id);
  questionTotal += (row.questions ?? []).length;
  eq(`bank ${bank.fixtureKey} question count`, (row.questions ?? []).length, bank.questions.length);
  const fixtureKeys = new Set(bank.questions.map((q) => q.key));
  const importedKeys = new Set((row.questions ?? []).map((q) => q.key));
  eq(`bank ${bank.fixtureKey} question keys identical`, [...importedKeys].sort(), [...fixtureKeys].sort());
  if (bank.rubricKey) {
    const rubric = rubrics.find((r) => r.id === row.rubricId);
    check(`bank ${bank.fixtureKey} rubric attached`, Boolean(rubric), rubric?.title);
  }
  for (const section of bank.sections.filter((s) => s.audioKey)) {
    const imported = (row.sections ?? []).find((s) => s.key === section.key);
    check(`section ${section.key} audio URL resolved`, Boolean(imported?.audioUrl));
  }
}
eq('total questions across banks', questionTotal, 94);

const profile = (await get(`/api/academic/program-versions/${first.programVersionId}/placement-profile`)).body;
check('placement profile configured', profile.configured === true, `policy v${profile.version}`);
eq('requirement mode', profile.requirementMode, fixtures.profile.requirementMode);
eq('delivery modes', profile.deliveryModes ?? profile.delivery_modes, ['DIGITAL', 'PHYSICAL']);
eq('scoring model', profile.scoringModel, 'canonical');
eq('pass score', profile.passScore, fixtures.profile.passScore);
eq('retake policy', [profile.allowRetake, profile.maxAttempts, profile.firstAttemptBillable, profile.retakeBillable, profile.retakeFeeAmount], [true, 3, true, true, 300]);
eq('component keys', profile.components.map((c) => c.key), ['grammar', 'reading', 'listening', 'writing', 'speaking']);
eq('component maxima', profile.components.map((c) => c.maxScore), [30, 20, 20, 25, 25]);
eq('component weights', profile.components.map((c) => c.weight), [25, 16.67, 16.67, 20.83, 20.83]);
eq('component bank wiring', profile.components.map((c) => c.bankIds), fixtures.profile.components.map((c) => c.bankKeys.map((k) => bankIdByFixtureKey.get(k))));
eq('blueprint bucket totals', profile.components.map((c) => c.blueprintBuckets.reduce((n, b) => n + b.count, 0)), [30, 20, 20, 1, 1]);
eq('CEFR ladder levels', profile.decisionRules.map((r) => r.cefrLevel), ['A1', 'A2', 'B1', 'B2', 'C1']);
eq(
  'CEFR ladder recommended levels resolve to A1–C1 codes',
  profile.decisionRules.map((r) => [...levelIdByCode.entries()].find(([, id]) => id === r.recommendedLevelId)?.[0]),
  ['A1', 'A2', 'B1', 'B2', 'C1'],
);
eq(
  'CEFR ladder thresholds match fixture',
  profile.decisionRules.map((r) => r.minimumScores),
  fixtures.profile.decisionRules.map((r) => r.minimumScores),
);

// Blueprint satisfiability replay: every bucket must be fillable from the
// imported active questions — the precondition for assembling a real attempt.
const banksByFixtureKey = new Map(
  fixtures.banks.map((bank) => {
    const row = banks.find((b) => b.title === bank.title && b.testType === bank.testType);
    return [bank.fixtureKey, { fixture: bank, row }];
  }),
);
for (const component of fixtures.profile.components) {
  for (const bucket of component.blueprintBuckets) {
    const pool = [];
    for (const fixtureKey of component.bankKeys) {
      const entry = banksByFixtureKey.get(fixtureKey);
      for (const question of entry?.fixture.questions ?? []) {
        if (question.lifecycleStatus !== 'active') continue;
        if (bucket.cefrLevel !== 'ANY' && question.cefrLevel !== bucket.cefrLevel) continue;
        if (bucket.difficulty !== 'ANY' && question.difficulty !== bucket.difficulty) continue;
        if (!bucket.qtypes.includes(question.qtype)) continue;
        pool.push(question.key);
      }
    }
    check(
      `bucket ${component.key}/${bucket.cefrLevel}/${bucket.difficulty} satisfiable`,
      pool.length >= bucket.count,
      `${pool.length} ≥ ${bucket.count}`,
    );
  }
}

// ── 6. ATTACK: partial destruction must self-heal without duplication ─────
console.log('\n[4/6] ATTACK — delete profile + one bank, rerun import, expect exact repair');
const Database = (await import('better-sqlite3')).default;
const directDb = new Database(dbPath);
directDb
  .prepare(
    'DELETE FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id = ?',
  )
  .run(first.programVersionId, first.branchId);
const destroyedBankId = bankIdByFixtureKey.get('grammar-bank-v1');
directDb.prepare('DELETE FROM placement_tests WHERE id = ?').run(destroyedBankId);
directDb.close();
const second = await importPlacementReference({
  app,
  username: ownerUsername,
  password: finalPassword,
  log: (line) => console.log(line),
});
const recreated = second.steps.filter((s) => s.status === 'created' || s.status === 'activated');
eq('attack rerun recreates exactly the bank and the profile', [...new Set(recreated.map((s) => s.step))].sort(), ['bank grammar-bank-v1', 'placement profile']);
const banksAfterAttack = (await get('/api/placement/test-bank')).body;
eq('no duplicate banks after repair', banksAfterAttack.filter((b) => b.testType === 'grammar').length, 1);
const profileAfterAttack = (await get(`/api/academic/program-versions/${first.programVersionId}/placement-profile`)).body;
check('profile repaired and configured', profileAfterAttack.configured === true);
eq('repaired profile wires the recreated bank', profileAfterAttack.components[0].bankIds[0], second.bankIdByFixtureKey['grammar-bank-v1']);

// ── 7. Functional smoke: DIGITAL attempt assembles from the fresh import ──
console.log('\n[5/6] Functional smoke — synthetic candidate, DIGITAL attempt assembly');
const visitorName = `Verify Candidate ${randomUUID().slice(0, 8)}`;
const visitor = (await api('POST', '/api/visitors', {
  fullName: visitorName,
  phone: '+93700000099',
  gender: 'female',
  programVersionId: first.programVersionId,
  source: 'walk_in',
  notes: 'Automated fresh-database verification (throwaway database).',
})).body;
check('synthetic lead created', Boolean(visitor?.id), visitor?.serialNo);
const converted = await api('POST', `/api/visitors/${visitor.id}/convert`, { programVersionId: first.programVersionId });
check('candidate admitted to a student record (fees enforced)', converted.status === 201, converted.body?.studentCode);
const attemptResponse = await api('POST', `/api/placement/visitors/${visitor.id}/placement/attempts`, { deliveryMode: 'DIGITAL' });
check('DIGITAL attempt starts from imported configuration', attemptResponse.status === 201);
const attempt = attemptResponse.body;
const snapshotTests = attempt?.snapshot?.tests ?? [];
eq('assembled snapshot item counts (blueprint)', snapshotTests.map((t) => t.questions.length).sort(), [1, 1, 20, 20, 30]);
const writingTest = snapshotTests.find((t) => (t.component_key ?? t.componentKey) === 'writing');
const speakingTest = snapshotTests.find((t) => (t.component_key ?? t.componentKey) === 'speaking');
check('writing snapshot carries rubric', Boolean(writingTest?.rubric?.criteria?.length));
check('speaking snapshot carries rubric', Boolean(speakingTest?.rubric?.criteria?.length));
check('answer keys never leaked to candidate', !snapshotTests.some((t) => t.questions.some((q) => q.answer_key != null || q.answerKey != null)));
const cancel = await api('POST', `/api/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/cancel`, { reason: 'verification smoke complete' });
check('smoke attempt cancelled', cancel.status === 200);

// ── 8. Summary ─────────────────────────────────────────────────────────────
console.log('\n[6/6] Summary');
const passed = checks.filter((c) => c.ok).length;
console.log(`  ${passed}/${checks.length} checks passed`);
await new Promise((resolve) => server.close(resolve));
if (failures.length > 0) {
  console.error('\nFAILURES:');
  for (const failure of failures) console.error(`  - ${failure}`);
  die(`${failures.length} check(s) failed`);
}
console.log(
  '\nPASS — a fresh clone + bootstrap + import reproduces the complete Placement V1 reference configuration.' +
    '\nThe configuration is live policy data and remains editable through the Owner/Admin UI.',
);
process.exit(0);
