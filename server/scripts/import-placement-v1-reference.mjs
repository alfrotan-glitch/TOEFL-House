#!/usr/bin/env node
/**
 * Placement V1 reference-configuration importer.
 * ============================================================================
 * Recreates the complete Placement Test V1 reference configuration from the
 * tracked, machine-readable fixtures in `server/fixtures/placement-v1/`.
 *
 * DESIGN RULES
 * ------------
 * 1. No parallel configuration system: every write goes through the real
 *    canonical HTTP routers (academic, catalog, placement) mounted in-process,
 *    so the canonical validators, RBAC checks (`Curriculum.PlacementPolicy`,
 *    `Curriculum.TestBank`, `FeeStructure.Edit`, …), persistence, versioning
 *    and audit trail all apply exactly as they do for an Owner using the UI.
 * 2. Authentication is a real owner login (`POST /api/auth/login`); the token
 *    is used as a Bearer credential for every subsequent call.
 * 3. Idempotent and NON-DESTRUCTIVE: each object is matched by natural key and
 *    created only when absent. Existing objects — including an Owner-edited
 *    placement profile — are never overwritten. Rerunning is always safe.
 * 4. Fixture references (bankKeys, rubric keys, level codes, audio keys) are
 *    remapped to the fresh database's real ids, so the import works on any
 *    install regardless of generated identifiers.
 *
 * USAGE
 * -----
 *   PLACEMENT_IMPORT_USERNAME=owner \
 *   PLACEMENT_IMPORT_PASSWORD=<current owner password> \
 *   npm --prefix server run import:placement-reference
 *
 * CREDENTIAL CONTRACT — PLACEMENT_IMPORT_USERNAME / PLACEMENT_IMPORT_PASSWORD
 * hold the owner account's CURRENT credentials. When they are not set the
 * importer falls back to SEED_OWNER_USERNAME / SEED_OWNER_PASSWORD (normally
 * loaded from server/.env), but that value is the ONE-TIME bootstrap
 * credential: it is API-quarantined until the mandatory first-login password
 * change and permanently rejected (HTTP 401) after it, so on any install past
 * first login the explicit variables are required. Authentication is always
 * canonical — no bypass, no password storage.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { errorHandler } from '../src/middleware/errorHandler.js';
import authRouter from '../src/routes/auth.routes.js';
import academicRouter from '../src/routes/academic.routes.js';
import { catalogRouter } from '../src/routes/catalog.routes.js';
import placementRouter from '../src/routes/placement.routes.js';
import visitorsRouter from '../src/routes/visitors.routes.js';
import studentsRouter from '../src/routes/students.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_DIR = path.resolve(here, '../fixtures/placement-v1');

/** The real routers, mounted exactly as the server mounts them. */
export function createImporterApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/academic', academicRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/placement', placementRouter);
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

class Api {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async call(method, pathname, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (body !== undefined && !(body instanceof Uint8Array)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    } else if (body instanceof Uint8Array) {
      payload = body;
    }
    const response = await fetch(`${this.baseUrl}${pathname}`, { method, headers, body: payload });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  get(pathname) {
    return this.call('GET', pathname);
  }

  post(pathname, body) {
    return this.call('POST', pathname, body);
  }

  put(pathname, body) {
    return this.call('PUT', pathname, body);
  }
}

/**
 * Runs `fn(api)` with an authenticated session against the real routers.
 * One ephemeral listener serves the whole exchange and is always closed.
 */
async function withSession(app, username, password, fn) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    // Parse the body for every status so the server's own error message is
    // surfaced instead of being discarded on failures.
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* non-JSON error body; fall through to the generic message */
    }
    if (!response.ok) {
      const message = body?.error || `Login failed (HTTP ${response.status}).`;
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }
    if (body?.user?.mustChangePassword) {
      throw new Error(
        'The owner account is still under first-login password quarantine. ' +
          'Log in once through the UI (or POST /api/auth/change-password) to set a permanent password, then rerun the import.',
      );
    }
    return await fn(new Api(base, body.token), body.user);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fail(step, detail) {
  throw new Error(`[placement-v1-import] ${step}: ${detail}`);
}

function expectOk(step, response) {
  if (!response.ok) {
    fail(step, `HTTP ${response.status} — ${JSON.stringify(response.body).slice(0, 400)}`);
  }
  return response.body;
}

/**
 * Runs the full idempotent import. Returns a structured report:
 * every entry is { status: 'created' | 'reused' | 'activated', ... }.
 */
export async function importPlacementReference(options) {
  const { app, username, password, fixtureDir = DEFAULT_FIXTURE_DIR } = options;
  return withSession(app, username, password, (sessionApi, sessionUser) =>
    runImport(sessionApi, sessionUser, { fixtureDir, log: options.log ?? (() => {}) }),
  );
}

async function runImport(api, user, { fixtureDir, log }) {
  const report = { steps: [] };
  const note = (step, status, detail) => {
    report.steps.push({ step, status, detail });
    log(`  ${status.padEnd(8)} ${step}${detail ? ` — ${detail}` : ''}`);
  };

  const readFixture = async (file) => JSON.parse(await readFile(path.join(fixtureDir, file), 'utf8'));
  const [manifest, academic, feeRules, rubrics, banks, profile] = await Promise.all([
    readFixture('manifest.json'),
    readFixture('academic.json'),
    readFixture('fee-rules.json'),
    readFixture('rubrics.json'),
    readFixture('banks.json'),
    readFixture('placement-profile.json'),
  ]);
  if (manifest.schemaVersion !== 1) fail('fixtures', `unsupported schemaVersion ${manifest.schemaVersion}`);

  // ── Session context ─────────────────────────────────────────────────────
  const branchId = user.branchId;
  if (!branchId) fail('login', 'the owner account has no home branch; cannot scope the import.');
  log(`authenticated as ${user.fullName} (${user.role}), branch ${branchId}`);

  // ── Academic: program → levels → published version ───────────────────────
  const programs = expectOk('list programs', await api.get(`/api/academic/programs`));
  let program = programs.find((row) => row.code === academic.program.code && row.branchId === branchId)
    || programs.find((row) => row.name === academic.program.name && row.branchId === branchId);
  if (!program) {
    program = expectOk(
      'create program',
      await api.post('/api/academic/programs', { ...academic.program, branchId }),
    );
    note('program', 'created', `${program.name} (${program.code})`);
  } else {
    note('program', 'reused', `${program.name} (${program.code})`);
  }

  const levels = expectOk('list levels', await api.get(`/api/academic/levels?programId=${program.id}`));
  const levelIdByCode = new Map();
  for (const level of academic.levels) {
    let row = levels.find((entry) => entry.code === level.code);
    if (!row) {
      row = expectOk(
        `create level ${level.code}`,
        await api.post('/api/academic/levels', { ...level, programId: program.id, isActive: true }),
      );
      note(`level ${level.code}`, 'created', row.name);
    } else {
      note(`level ${level.code}`, 'reused', row.name);
    }
    levelIdByCode.set(level.code, row.id);
  }

  const versions = expectOk('list versions', await api.get(`/api/catalog/program-versions?programId=${program.id}`));
  let version = versions.find((row) => row.version_label === academic.programVersion.versionLabel)
    || versions.find((row) => row.versionLabel === academic.programVersion.versionLabel);
  if (!version) {
    version = expectOk(
      'create program version',
      await api.post('/api/catalog/program-versions', {
        programId: program.id,
        versionLabel: academic.programVersion.versionLabel,
        versionNumber: academic.programVersion.versionNumber,
        durationMonths: academic.programVersion.durationMonths,
        description: academic.programVersion.description,
      }),
    );
    version = version.version ?? version;
    note('program version', 'created', version.version_label ?? version.versionLabel);
  } else {
    note('program version', 'reused', `${version.version_label ?? version.versionLabel} (${version.status})`);
  }
  const versionId = version.id;
  if (String(version.status) !== 'published') {
    expectOk('publish program version', await api.post(`/api/catalog/program-versions/${versionId}/publish`, {}));
    note('program version', 'created', 'published');
  }

  // ── Fee rules (create-only; never touch existing pricing) ────────────────
  const existingFees = expectOk('list fee rules', await api.get(`/api/catalog/fee-rules?branchId=${branchId}`));
  for (const rule of feeRules) {
    const existing = existingFees.find(
      (row) => row.feeType === rule.feeType && row.name === rule.name && !row.programVersionId && !row.levelId,
    );
    if (existing) {
      note(`fee ${rule.feeType}`, 'reused', `${existing.name} (${existing.amount} AFN)`);
    } else {
      expectOk(
        `create fee ${rule.feeType}`,
        await api.post('/api/catalog/fee-rules', { ...rule, branchId }),
      );
      note(`fee ${rule.feeType}`, 'created', `${rule.name} (${rule.amount} AFN)`);
    }
  }

  // ── Rubrics ──────────────────────────────────────────────────────────────
  const existingRubrics = expectOk('list rubrics', await api.get('/api/placement/rubrics'));
  const rubricIdByKey = new Map();
  for (const rubric of rubrics) {
    let row = existingRubrics.find((entry) => entry.title === rubric.title && entry.kind === rubric.kind)
      || existingRubrics.find((entry) => entry.title === rubric.title);
    if (!row) {
      row = expectOk(
        `create rubric ${rubric.key}`,
        await api.post('/api/placement/rubrics', {
          title: rubric.title,
          kind: rubric.kind,
          criteria: rubric.criteria,
        }),
      );
      note(`rubric ${rubric.key}`, 'created', row.title);
    } else {
      note(`rubric ${rubric.key}`, 'reused', row.title);
    }
    rubricIdByKey.set(rubric.key, row.id);
  }

  // ── Media assets (sha-256 match within this branch) ──────────────────────
  const mediaUrlByKey = new Map();
  const existingMedia = expectOk('list media', await api.get('/api/placement/media'));
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(fixtureDir, asset.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const row = existingMedia.find(
      (entry) => entry.sha256 === sha256 && (entry.branchId == null || entry.branchId === branchId),
    );
    if (row) {
      mediaUrlByKey.set(asset.key, row.url);
      note(`media ${asset.key}`, 'reused', row.filename);
    } else {
      const created = expectOk(
        `upload media ${asset.key}`,
        await api.call('POST', '/api/placement/media/upload', bytes, { 'Content-Type': asset.mime }),
      );
      mediaUrlByKey.set(asset.key, created.url);
      note(`media ${asset.key}`, 'created', created.filename);
    }
  }

  // ── Question banks ───────────────────────────────────────────────────────
  const existingBanks = expectOk('list test bank', await api.get('/api/placement/test-bank'));
  const bankIdByKey = new Map();
  for (const bank of banks) {
    let row = existingBanks.find(
      (entry) => entry.title === bank.title && entry.testType === bank.testType && entry.branchId === branchId,
    );
    if (!row) {
      const rubricId = bank.rubricKey ? rubricIdByKey.get(bank.rubricKey) : null;
      if (bank.rubricKey && !rubricId) fail(`bank ${bank.fixtureKey}`, `rubric ${bank.rubricKey} missing`);
      const payload = {
        title: bank.title,
        testType: bank.testType,
        instructions: bank.instructions,
        difficulty: bank.difficulty,
        durationSeconds: bank.durationSeconds,
        rubricId,
        wordTarget: bank.wordTarget,
        branchId,
        sections: bank.sections.map((section) => ({
          key: section.key,
          kind: section.kind,
          title: section.title,
          audioUrl: section.audioKey ? mediaUrlByKey.get(section.audioKey) ?? null : null,
          transcript: section.transcript,
          body: section.body,
          durationSeconds: section.durationSeconds,
        })),
        questions: bank.questions.map((question) => ({
          key: question.key,
          qtype: question.qtype,
          prompt: question.prompt,
          options: question.options,
          answerKey: question.answerKey,
          points: question.points,
          difficulty: question.difficulty,
          sectionKey: question.sectionKey,
          cefrLevel: question.cefrLevel,
          topic: question.topic,
          subskill: question.subskill,
          lifecycleStatus: question.lifecycleStatus,
        })),
      };
      row = expectOk(`create bank ${bank.fixtureKey}`, await api.post('/api/placement/test-bank', payload));
      note(`bank ${bank.fixtureKey}`, 'created', `${row.title} (${bank.questions.length} questions)`);
    } else {
      note(`bank ${bank.fixtureKey}`, 'reused', `${row.title} (v${row.version}, ${row.status})`);
    }
    if (row.status !== 'active') {
      expectOk(
        `activate bank ${bank.fixtureKey}`,
        await api.post(`/api/placement/test-bank/${row.id}/activate`, { version: row.version }),
      );
      note(`bank ${bank.fixtureKey}`, 'activated', 'bank was draft');
    }
    bankIdByKey.set(bank.fixtureKey, row.id);
  }

  // ── Placement profile (create-only; Owner edits are authoritative) ───────
  const current = expectOk(
    'read placement profile',
    await api.get(`/api/academic/program-versions/${versionId}/placement-profile`),
  );
  if (current.configured) {
    note('placement profile', 'reused', `policy v${current.version}, mode ${current.requirementMode} (existing policy kept)`);
  } else {
    const body = {
      requirementMode: profile.requirementMode,
      firstLevelExempt: profile.firstLevelExempt,
      expiresMinutes: profile.expiresMinutes,
      passScore: profile.passScore,
      allowRetake: profile.allowRetake,
      maxAttempts: profile.maxAttempts,
      firstAttemptBillable: profile.firstAttemptBillable,
      retakeBillable: profile.retakeBillable,
      retakeFeeAmount: profile.retakeFeeAmount,
      scoringModel: profile.scoringModel,
      instructions: profile.instructions,
      components: profile.components.map((component) => ({
        key: component.key,
        type: component.type,
        label: component.label,
        required: component.required,
        durationMinutes: component.durationMinutes,
        timeLimitSeconds: component.timeLimitSeconds,
        instructions: component.instructions,
        bankIds: component.bankKeys.map((fixtureKey) => {
          const id = bankIdByKey.get(fixtureKey);
          if (!id) fail('placement profile', `unknown bank fixture key ${fixtureKey}`);
          return id;
        }),
        blueprintBuckets: component.blueprintBuckets,
      })),
      decisionRules: profile.decisionRules.map((rule) => {
        const recommendedLevelId = levelIdByCode.get(rule.levelCode);
        if (!recommendedLevelId) fail('placement profile', `unknown level code ${rule.levelCode}`);
        return {
          cefrLevel: rule.cefrLevel,
          recommendedLevelId,
          minimumScores: rule.minimumScores,
          label: rule.label,
        };
      }),
    };
    const saved = expectOk(
      'save placement profile',
      await api.put(`/api/academic/program-versions/${versionId}/placement-profile`, body),
    );
    note('placement profile', 'created', `policy v${saved.version}, ${saved.components.length} components, ${saved.decisionRules.length} CEFR rules`);
  }

  report.levelIdByCode = Object.fromEntries(levelIdByCode);
  report.bankIdByFixtureKey = Object.fromEntries(bankIdByKey);
  report.rubricIdByKey = Object.fromEntries(rubricIdByKey);
  report.mediaUrlByKey = Object.fromEntries(mediaUrlByKey);
  report.programId = program.id;
  report.programVersionId = versionId;
  report.branchId = branchId;
  return report;
}

const invokedDirectly = (() => {
  try {
    return pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const explicitUsername = process.env.PLACEMENT_IMPORT_USERNAME?.trim();
  const explicitPassword = process.env.PLACEMENT_IMPORT_PASSWORD?.trim();
  const seedUsername = process.env.SEED_OWNER_USERNAME?.trim();
  const seedPassword = process.env.SEED_OWNER_PASSWORD?.trim();
  // Credential source tracking: PLACEMENT_IMPORT_* is the contract for this
  // tool. The SEED_OWNER_* fallback is the one-time bootstrap credential from
  // server/.env — it is API-quarantined until the mandatory first-login
  // password change and permanently invalid after it, so on any real install
  // the explicit variables (current owner credentials) are required.
  const usingSeedFallback = !(explicitUsername && explicitPassword);
  const username = explicitUsername || seedUsername;
  const password = explicitPassword || seedPassword;
  const credentialSource = usingSeedFallback
    ? 'SEED_OWNER_USERNAME / SEED_OWNER_PASSWORD (the one-time bootstrap credential from server/.env)'
    : 'PLACEMENT_IMPORT_USERNAME / PLACEMENT_IMPORT_PASSWORD (environment variables)';
  if (!username || !password) {
    console.error(
      'No credentials found. Set PLACEMENT_IMPORT_USERNAME / PLACEMENT_IMPORT_PASSWORD to the ' +
        'owner account\u2019s CURRENT username and password (the SEED_OWNER_* values in server/.env ' +
        'are one-time bootstrap credentials and stop working after the mandatory first-login ' +
        'password change).' +
        '\n  PowerShell:  $env:PLACEMENT_IMPORT_USERNAME=\'owner\'; $env:PLACEMENT_IMPORT_PASSWORD=\'<current owner password>\'' +
        '\n  CMD:         set PLACEMENT_IMPORT_USERNAME=owner && set PLACEMENT_IMPORT_PASSWORD=<current owner password>' +
        '\n  bash:        PLACEMENT_IMPORT_USERNAME=owner PLACEMENT_IMPORT_PASSWORD=\'...\' npm --prefix server run import:placement-reference',
    );
    process.exit(2);
  }
  if (usingSeedFallback) {
    console.log(
      'NOTE: using the SEED_OWNER_* fallback credential. This is the one-time bootstrap ' +
        'password; it is rejected with HTTP 401 once the mandatory first-login password change ' +
        'has happened. If login fails, rerun with PLACEMENT_IMPORT_USERNAME / ' +
        'PLACEMENT_IMPORT_PASSWORD set to the owner account\u2019s current credentials.',
    );
  }
  const app = createImporterApp();
  importPlacementReference({ app, username, password, log: (line) => console.log(line) })
    .then((report) => {
      const created = report.steps.filter((step) => step.status === 'created' || step.status === 'activated').length;
      console.log(
        `\nPlacement V1 reference configuration present — ${report.steps.length} checks, ${created} object(s) written.` +
          '\nEverything is editable through the Academic Control Center and Test Bank admin UI.',
      );
    })
    .catch((error) => {
      console.error(`\n${error.message}`);
      if (error.statusCode === 401) {
        console.error(
          `\nLogin was rejected for username "${username}" using credentials from:\n  ${credentialSource}` +
            '\nThis means the password does not match the account\u2019s CURRENT password. Common causes:' +
            '\n  1. The owner already completed the mandatory first-login password change, so the' +
            '\n     bootstrap password in server/.env is no longer valid (by design — accounts never' +
            '\n     keep bootstrap credentials).'
        );
        if (usingSeedFallback) {
          console.error(
            '  2. This run used the SEED_OWNER_* fallback, which only works before that change.'
          );
        }
        console.error(
          '\nFix — rerun with the current owner credentials (never the bootstrap password):' +
            '\n  PowerShell:  $env:PLACEMENT_IMPORT_USERNAME=\'owner\'; $env:PLACEMENT_IMPORT_PASSWORD=\'<current owner password>\'' +
            '\n  CMD:         set PLACEMENT_IMPORT_USERNAME=owner && set PLACEMENT_IMPORT_PASSWORD=<current owner password>' +
            '\n  bash:        PLACEMENT_IMPORT_USERNAME=owner PLACEMENT_IMPORT_PASSWORD=\'...\' npm --prefix server run import:placement-reference' +
            '\nAuthentication is canonical and was not bypassed; the importer only reads/writes reference data.'
        );
      }
      process.exit(1);
    });
}
