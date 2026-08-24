/**
 * Placement content-driven gap — canonical V1 closed-state regression.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { readRepo } from './support/repo-read.js';

describe('Placement content-driven gap (closed-state regression)', () => {
  beforeAll(() => {
    initSchema();
  });

  it('keeps the canonical placement content tables in the schema', () => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (
        'placement_tests',
        'placement_test_sections',
        'placement_test_questions',
        'placement_rubrics',
        'placement_media',
        'placement_assessment_responses'
      ) ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'placement_assessment_responses',
      'placement_media',
      'placement_rubrics',
      'placement_test_questions',
      'placement_test_sections',
      'placement_tests',
    ]);
  });

  it('locks result component types to the five canonical V1 components', () => {
    const schema = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_results'`,
    ).get() as { sql: string };
    expect(schema.sql).toContain("component_type TEXT NOT NULL CHECK (component_type IN ('grammar','reading','listening','writing','speaking'))");
    expect(schema.sql).not.toContain('skill_scores');
    expect(schema.sql).not.toContain('written_test');
    expect(schema.sql).not.toContain('interview');
    expect(schema.sql).not.toContain('content_test');
  });

  it('exposes one canonical placement bank and response-capture surface', () => {
    const attemptSrc = readRepo('server/src/routes/placement-attempt.routes.ts');
    const bankSrc = readRepo('server/src/routes/placement-test-bank.routes.ts');
    expect(attemptSrc).toContain('/tests/:componentKey/responses');
    expect(attemptSrc).toContain("deliveryMode must be DIGITAL or PHYSICAL");
    expect(bankSrc).toContain('/test-bank');
    expect(bankSrc).toContain("const VALID_TEST_TYPES = ['grammar', 'listening', 'reading', 'writing', 'speaking']");
  });

  it('keeps immutable attempt snapshots and replay-safe response uniqueness', () => {
    const attemptCols = (db.prepare(`PRAGMA table_info(placement_assessment_attempts)`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(attemptCols).toContain('snapshot_json');
    expect(attemptCols).toContain('delivery_mode');
    const responsesSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_responses'`).get() as { sql: string };
    expect(responsesSql.sql).toMatch(/UNIQUE\s*\(attempt_id,\s*question_id\)/i);
  });
});
