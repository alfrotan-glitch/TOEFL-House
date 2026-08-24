import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';

const root = path.basename(process.cwd()) === 'server' ? path.resolve(process.cwd(), '..') : path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('WP-04 placement canonical architecture', () => {
  it('keeps the authenticated placement boundary as the attempt and test-bank route aggregator', () => {
    const source = read('server/src/routes/placement.routes.ts');
    expect(source).toContain("router.use(authenticate)");
    expect(source).toContain('router.use(placementAttemptRouter)');
    expect(source).toContain('router.use(placementTestBankRouter)');
    expect(source).not.toContain('assessmentRouter');
  });

  it('stores no duplicate profile enabled/required/method/sections/overall-maximum facts', () => {
    initSchema();
    const columns = (db.prepare("PRAGMA table_info('placement_assessment_profiles')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).not.toEqual(expect.arrayContaining(['enabled', 'required', 'method', 'sections_json', 'max_score']));
    expect(columns).toEqual(expect.arrayContaining(['requirement_mode', 'components_json', 'scoring_model', 'pass_score', 'version']));
  });

  it('keeps immutable placement scope and snapshot correlation in database triggers', () => {
    initSchema();
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_placement_%'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(triggers).toEqual(expect.arrayContaining([
      'trg_placement_attempt_scope_insert',
      'trg_placement_attempt_scope_update',
      'trg_placement_response_snapshot_insert',
      'trg_placement_response_snapshot_update',
      'trg_placement_result_snapshot_insert',
      'trg_placement_result_snapshot_update',
      'trg_placement_result_level_scope_insert',
      'trg_placement_result_level_scope_update',
      'trg_placement_attempt_level_scope_update',
      'trg_placement_test_rubric_scope_insert',
      'trg_placement_test_rubric_scope_update',
      'trg_placement_rubric_kind_scope_update',
    ]));
  });

  it('routes attempt decisions through the canonical policy, timing, scoring, decision, and reporting modules', () => {
    const source = read('server/src/routes/placement-attempt.routes.ts');
    for (const authority of [
      "../core/placement/placement-policy.js",
      "../core/placement/timing-engine.js",
      "../core/placement/scoring-engine.js",
      "../core/placement/decision-engine.js",
      "../core/placement/reporting.js",
    ]) expect(source).toContain(authority);
    expect(source).toContain('evaluateStartEligibility');
    expect(source).toContain('evaluateBilling');
    expect(source).toContain('evaluateOutcome');
  });

  it('keeps placement gating centralized while admission-only writers do not bypass it', () => {
    const service = read('server/src/core/academic/enrollment-service.ts');
    const directRoute = read('server/src/routes/students.routes.ts');
    const conversion = read('server/src/routes/visitors.routes.ts');
    expect(service).toContain('evaluateEnrollmentEligibility');
    expect(directRoute).toContain('assertPlacementEligibleForClass');
    expect(directRoute).toContain('getEnrollmentService(db).enroll');
    expect(conversion).toContain('Visitor admission no longer collects payment or creates enrollment directly');
    expect(conversion).not.toContain('getEnrollmentService(db).enroll');
  });

  it('keeps overall scoring percentage-based in the academic configuration UI', () => {
    const source = read('src/components/academic/ProgramVersionsPanel.tsx');
    expect(source).not.toContain('placementConfig.maxScore');
    expect(source).not.toMatch(/Overall[^\n]{0,80}max(?:imum)?\s*score/i);
    expect(source).toContain('passScore');
    expect(source).toContain('maxScore: spec.maxScore');
    expect(source).toContain('version: raw?.version ?? null');
    expect(source).toContain("const COMPONENT_ORDER: ComponentKey[] = ['grammar', 'reading', 'listening', 'writing', 'speaking']");
  });

  it('uses explicit CAS lifecycle calls in the test-bank UI instead of mutating status fields', () => {
    const source = read('src/components/academic/TestBankAdminView.tsx');
    expect(source).toMatch(/version\s*:\s*(?:editing|test|selected|row|t)\.?version|\{\s*version\s*\}/);
    expect(source).toContain("status === 'active' ? 'activate' : 'archive'");
    expect(source).toContain('{ version: t.version }');
    expect(source).not.toContain('status: editing.status');
  });

  it('keeps scoring normalization centralized while retaining the canonical manual-entry contract', () => {
    const scorer = read('server/src/core/placement/scoring-engine.ts');
    const store = read('server/src/core/placement/store.ts');
    expect(scorer).toContain('body?.score ?? body?.manualScore');
    expect(store).toContain('body?.score');
    expect(store).not.toContain("type: 'custom_score'");
  });
});
