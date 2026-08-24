/**
 * Placement engine extensions — canonical V1 closed-state regression.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initSchema } from '../db/connection.js';
import { readRepo } from './support/repo-read.js';

describe('Placement Engine extensions (closed-state regression)', () => {
  beforeAll(() => initSchema());

  it('supports validated speaking audio media references', () => {
    const attemptRoute = readRepo('server/src/routes/placement-attempt.routes.ts');
    expect(attemptRoute).toContain('audioMediaId');
    expect(attemptRoute).toContain('placement_media');
    expect(attemptRoute).toContain('Audio media belongs to another branch');
  });

  it('supports rubric criteria scoring for productive skills', () => {
    const engine = readRepo('server/src/core/placement/scoring-engine.ts');
    expect(engine).toContain('criteriaScores');
    expect(engine).toContain('manualScoreFromRubric');
    expect(engine).toContain('rubric has no criteria');
  });

  it('keeps the expiry maintenance endpoint on the canonical attempt route', () => {
    const attemptRoute = readRepo('server/src/routes/placement-attempt.routes.ts');
    expect(attemptRoute).toContain('/maintenance/expire');
    expect(attemptRoute).toContain("authorize('owner', 'general_manager')");
  });
});
