/**
 * Placement engine — canonical V1 closed-state regression.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { readRepo } from './support/repo-read.js';

describe('Placement Engine (closed-state regression)', () => {
  beforeAll(() => initSchema());

  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);

  it('keeps canonical placement policy facts and removes legacy profile columns', () => {
    const profileCols = cols('placement_assessment_profiles');
    expect(profileCols).toEqual(expect.arrayContaining([
      'requirement_mode',
      'components_json',
      'decision_rules_json',
      'scoring_model',
      'pass_score',
      'first_level_exempt',
      'expires_minutes',
    ]));
    expect(profileCols).not.toEqual(expect.arrayContaining(['enabled', 'required', 'method', 'max_score', 'sections_json']));
    expect(readRepo('server/src/core/placement/policy-engine.ts')).toContain('Placement Test V1 requires exactly five canonical components');
  });

  it('keeps attempt delivery, timing, and immutable snapshot fields in the schema', () => {
    const attemptCols = cols('placement_assessment_attempts');
    const resultCols = cols('placement_assessment_results');
    expect(attemptCols).toEqual(expect.arrayContaining([
      'delivery_mode',
      'expires_at',
      'paused_at',
      'resumed_at',
      'policy_version',
      'decision_rule_id',
      'override_level_id',
      'override_reason',
      'override_by',
      'override_at',
      'snapshot_json',
    ]));
    expect(resultCols).toEqual(expect.arrayContaining([
      'started_at',
      'deadline_at',
      'submitted_at',
      'elapsed_seconds',
      'timeout_flag',
      'raw_score',
      'percentage',
      'weighted_score',
      'score_version',
      'cefr_level',
      'cefr_evidence_json',
      'correction_reason',
      'corrected_at',
    ]));
  });

  it('keeps the canonical placement authorities wired into the attempt route', () => {
    const source = readRepo('server/src/routes/placement-attempt.routes.ts');
    expect(source).toContain('../core/placement/policy-engine.js');
    expect(source).toContain('../core/placement/timing-engine.js');
    expect(source).toContain('../core/placement/scoring-engine.js');
    expect(source).toContain('../core/placement/decision-engine.js');
    expect(source).toContain('../core/placement/reporting.js');
    expect(source).toContain('evaluateDecision');
    expect(source).toContain('persistComponentCefrEvidence');
  });

  it('keeps the canonical placement report endpoint and CEFR ladder authority', () => {
    const attemptRoute = readRepo('server/src/routes/placement-attempt.routes.ts');
    const decisionEngine = readRepo('server/src/core/placement/decision-engine.ts');
    const v1 = readRepo('server/src/core/placement/v1.ts');
    expect(attemptRoute).toContain('/report');
    expect(decisionEngine).toContain('No CEFR placement rule set is configured for this placement profile.');
    expect(v1).toContain("export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;");
  });
});
