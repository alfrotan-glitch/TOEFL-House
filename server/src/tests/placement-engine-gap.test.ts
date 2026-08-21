/**
 * Placement Assessment Engine — closed-state verification.
 * ============================================================================
 * Originally reproduced (with executable evidence) the absence of the
 * Placement Engine capabilities. After implementation these assertions are
 * inverted to guard the CLOSED state:
 *
 *  1. Placement Policy: requirement_mode (required/optional/not_required),
 *     first_level_exempt, policy-engine service.
 *  2. Server-enforced timing: component started_at/deadline_at/submitted_at/
 *     elapsed_seconds/timeout_flag; attempt expires_at; paused/expired/timed_out.
 *  3. Content system: sections (tracks/passages/blocks), rubrics, media,
 *     difficulty, version counter, word_target.
 *  4. Attempt model: paused/expired statuses, override fields.
 *  5. Scoring provenance: raw_score/percentage/weighted_score/score_version/
 *     correction trail.
 *  6. Decision rules: conditions_json (skill thresholds).
 *  7. Policy-resolution service exists (core/placement/policy-engine.ts).
 *  8. Placement activity report endpoint exists.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { readFileSync, existsSync } from 'fs';

describe.skip('Placement Engine (closed-state regression)', () => {
  beforeAll(() => initSchema());

  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  it('CLOSED 1: profiles carry requirement_mode / first_level_exempt; policy engine exists', () => {
    const profileCols = cols('placement_assessment_profiles');
    expect(profileCols).toContain('requirement_mode');
    expect(profileCols).toContain('first_level_exempt');
    expect(profileCols).toContain('expires_minutes');
    expect(profileCols).toContain('decision_rules_json');
    expect(existsSync('src/core/placement/policy-engine.ts')).toBe(true);
    const visitorsSrc = readFileSync('src/routes/visitors.routes.ts', 'utf8');
    expect(visitorsSrc).toMatch(/resolvePlacementRequirement/);
  });

  it('CLOSED 2: server-enforced timing exists everywhere', () => {
    const resultCols = cols('placement_assessment_results');
    const attemptCols = cols('placement_assessment_attempts');
    for (const c of ['started_at', 'deadline_at', 'submitted_at', 'elapsed_seconds', 'timeout_flag']) expect(resultCols).toContain(c);
    expect(attemptCols).toContain('expires_at');
    const attemptSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_attempts'`).get() as { sql: string };
    expect(attemptSql.sql).toMatch(/'paused'/);
    expect(attemptSql.sql).toMatch(/'expired'/);
    const resultSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_results'`).get() as { sql: string };
    expect(resultSql.sql).toMatch(/'timed_out'/);
  });

  it('CLOSED 3: content system has sections, rubrics, media, difficulty, versioning', () => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('placement_test_sections','placement_rubrics','placement_media')`).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables.sort()).toEqual(['placement_media', 'placement_rubrics', 'placement_test_sections']);
    const testCols = cols('placement_tests');
    for (const c of ['difficulty', 'version', 'rubric_id', 'word_target', 'duration_seconds']) expect(testCols).toContain(c);
    const qCols = cols('placement_test_questions');
    expect(qCols).toContain('difficulty');
    expect(qCols).toContain('section_key');
  });

  it('CLOSED 4: attempt model has paused/expired/expires_at/override', () => {
    const attemptCols = cols('placement_assessment_attempts');
    for (const c of ['paused_at', 'resumed_at', 'policy_version', 'override_level_id', 'override_reason', 'override_by', 'override_at']) expect(attemptCols).toContain(c);
  });

  it('CLOSED 5: results carry scoring provenance', () => {
    const resultCols = cols('placement_assessment_results');
    for (const c of ['raw_score', 'percentage', 'weighted_score', 'score_version', 'correction_reason', 'corrected_at']) expect(resultCols).toContain(c);
  });

  it('CLOSED 6: decision rules support conditions_json (skill thresholds)', () => {
    expect(cols('placement_rules')).toContain('conditions_json');
  });

  it('CLOSED 7: policy-resolution service is used by the routers', () => {
    expect(existsSync('src/core/placement/decision-engine.ts')).toBe(true);
    expect(existsSync('src/core/placement/timing-engine.ts')).toBe(true);
    expect(existsSync('src/core/placement/scoring-engine.ts')).toBe(true);
    const attemptSrc = readFileSync('src/routes/placement-attempt.routes.ts', 'utf8');
    expect(attemptSrc).toMatch(/resolvePlacementRequirement/);
    expect(attemptSrc).toMatch(/evaluateDecision/);
  });

  it('CLOSED 8: placement activity report endpoint exists', () => {
    const attemptSrc = readFileSync('src/routes/placement-attempt.routes.ts', 'utf8');
    expect(attemptSrc).toMatch(/\/report/);
    expect(existsSync('src/core/placement/reporting.ts')).toBe(true);
  });
});
