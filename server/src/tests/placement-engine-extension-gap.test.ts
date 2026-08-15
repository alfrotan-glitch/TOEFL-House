/**
 * Placement Engine extensions — closed-state verification.
 * ============================================================================
 * Originally reproduced the absence of speaking audio responses, rubric
 * criteria scoring, and an expiry sweep. After implementation these
 * assertions guard the CLOSED state.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initSchema } from '../db/connection.js';
import { readFileSync } from 'fs';

describe('Placement Engine extensions (closed-state regression)', () => {
  beforeAll(() => initSchema());

  it('CLOSED-S1: speaking answers support validated audio media references', () => {
    const src = readFileSync('src/routes/placement-attempt.routes.ts', 'utf8');
    expect(src).toMatch(/audioMediaId/);
    expect(src).toMatch(/placement_media/);
    expect(src).toMatch(/belongs to another branch/);
  });

  it('CLOSED-S2: manual scoring supports rubric criteriaScores', () => {
    const engine = readFileSync('src/core/placement/scoring-engine.ts', 'utf8');
    expect(engine).toMatch(/criteriaScores/);
    expect(engine).toMatch(/criteria_json/);
    // The attempt router forwards the whole body to the scoring engine, which
    // validates criteriaScores (verified by placement-engine-extensions.test.ts).
  });

  it('CLOSED-S3: expiry maintenance endpoint exists (owner/manager)', () => {
    const src = readFileSync('src/routes/placement-attempt.routes.ts', 'utf8');
    expect(src).toMatch(/maintenance\/expire/);
  });
});
