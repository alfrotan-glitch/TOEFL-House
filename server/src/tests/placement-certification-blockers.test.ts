import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { readRepo } from './support/repo-read.js';

describe('Placement certification blockers', () => {
  beforeAll(() => initSchema());

  it('keeps one attempt table and one result table for both DIGITAL and PHYSICAL delivery modes', () => {
    const attemptsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_attempts'`).get() as { sql: string };
    const resultsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='placement_assessment_results'`).get() as { sql: string };
    expect(attemptsSql.sql).toContain("delivery_mode TEXT NOT NULL DEFAULT 'DIGITAL' CHECK (delivery_mode IN ('DIGITAL','PHYSICAL'))");
    expect(resultsSql.sql).toContain("component_type TEXT NOT NULL CHECK (component_type IN ('grammar','reading','listening','writing','speaking'))");
  });

  it('keeps placement attempt creation on the visitor workflow instead of a duplicate student/self-service architecture', () => {
    const placementRoutes = readRepo('server/src/routes/placement.routes.ts');
    const studentRoutes = readRepo('server/src/routes/students.routes.ts');
    expect(placementRoutes).toContain('placementAttemptRouter');
    expect(studentRoutes).not.toContain('/placement/attempts');
  });

  it('keeps one scoring and CEFR authority on the canonical placement route surface', () => {
    const attemptRoute = readRepo('server/src/routes/placement-attempt.routes.ts');
    const scoring = readRepo('server/src/core/placement/scoring-engine.ts');
    const decision = readRepo('server/src/core/placement/decision-engine.ts');
    expect(attemptRoute).toContain('../core/placement/scoring-engine.js');
    expect(attemptRoute).toContain('../core/placement/decision-engine.js');
    expect(scoring).not.toContain('skill_scores');
    expect(scoring).not.toContain('weighted_average');
    expect(decision).not.toContain('placement_rules');
  });
});
