/**
 * Placement content-driven gap — CLOSED state verification.
 * ============================================================================
 * Originally reproduced (with executable evidence) the gap in the staff-scored
 * placement subsystem: no test-bank tables, no content component types, no
 * candidate-response API, and attempt snapshots without test content.
 *
 * After the content-driven implementation (migration 057 + placement routes +
 * test bank), these assertions are inverted to guard the CLOSED state:
 *
 *  1. The test-bank tables exist (placement_tests / placement_test_questions /
 *     placement_assessment_responses).
 *  2. The results component_type CHECK admits content_test.
 *  3. The placement router exposes test-bank + response submission paths.
 *  4. Attempt snapshots capture the full test content (questions + answer
 *     keys) so historical attempts are immutable and auto-scoring is possible.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { readFileSync } from 'fs';

describe('Placement content-driven gap (closed-state regression)', () => {
  beforeAll(() => {
    initSchema();
  });

  it('FACT 1 (closed): test-bank tables exist in the schema', () => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('placement_tests','placement_test_questions','placement_assessment_responses')`
    ).all() as Array<{ name: string }>;
    console.log('[EVIDENCE] content tables found:', JSON.stringify(tables.map((t) => t.name)));
    expect(tables.map((t) => t.name).sort()).toEqual(['placement_assessment_responses', 'placement_test_questions', 'placement_tests']);
  });

  it('FACT 2 (closed): component-type allow-list admits content_test', () => {
    const schema = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_results'`
    ).get() as { sql: string };
    const check = schema.sql.match(/component_type TEXT NOT NULL CHECK \(component_type IN \(([^)]+)\)\)/)?.[1] || '';
    console.log('[EVIDENCE] results component_type CHECK:', check);
    expect(check).toMatch(/content_test/);
  });

  it('FACT 3 (closed): candidate-response and test-bank paths exist in the routes', () => {
    const attemptSrc = readFileSync('src/routes/placement-attempt.routes.ts', 'utf8');
    const bankSrc = readFileSync('src/routes/placement-test-bank.routes.ts', 'utf8');
    const hasResponsesRoute = attemptSrc.includes('/responses');
    const hasTestBank = bankSrc.includes('/test-bank');
    console.log('[EVIDENCE] responses route:', hasResponsesRoute, '| test-bank routes:', hasTestBank);
    expect(hasResponsesRoute).toBe(true);
    expect(hasTestBank).toBe(true);
  });

  it('FACT 4 (closed): attempt snapshot carries test content via snapshot_json', () => {
    const profileCols = db.prepare(`PRAGMA table_info(placement_assessment_attempts)`).all() as Array<{ name: string }>;
    const names = profileCols.map((c) => c.name).join(',');
    console.log('[EVIDENCE] attempt columns:', names);
    // Content lives in the JSON snapshot column (immutable per attempt); the
    // lifecycle suite proves it contains tests + questions + answer keys.
    expect(names).toContain('snapshot_json');
    const responsesTable = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_responses'`).get() as { sql: string };
    expect(responsesTable.sql).toMatch(/UNIQUE\s*\(attempt_id,\s*question_id\)/i);
    console.log('[EVIDENCE] responses UNIQUE(attempt_id, question_id) replay-guard present.');
  });
});
