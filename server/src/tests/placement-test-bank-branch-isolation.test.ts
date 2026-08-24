import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import { createActiveTest, seedContext } from './work-packages/wp04/fixtures.js';

describe('Placement test bank branch isolation', () => {
  it('blocks another branch from previewing or archiving a branch-scoped bank', async () => {
    const context = seedContext();
    const created = await createActiveTest(context, { testType: 'grammar' }, context.managerA);

    const previewDenied = await supertest(context.app)
      .get(`/api/placement/test-bank/${created.id}/preview`)
      .set(context.managerB);
    expect(previewDenied.status).toBe(403);

    const archiveDenied = await supertest(context.app)
      .post(`/api/placement/test-bank/${created.id}/archive`)
      .set(context.managerB)
      .send({ version: created.version });
    expect(archiveDenied.status).toBe(403);
  });

  it('allows same-branch management to preview and archive a branch bank', async () => {
    const context = seedContext();
    const created = await createActiveTest(context, { testType: 'reading' }, context.managerA);

    const preview = await supertest(context.app)
      .get(`/api/placement/test-bank/${created.id}/preview`)
      .set(context.managerA);
    expect(preview.status).toBe(200);
    expect(preview.body.id).toBe(created.id);
    expect(preview.body.questions[0].answerKey).toBe('A');

    const archived = await supertest(context.app)
      .post(`/api/placement/test-bank/${created.id}/archive`)
      .set(context.managerA)
      .send({ version: created.version });
    expect(archived.status).toBe(200);
    expect(archived.body.ok).toBe(true);
  });

  it('lets only the organization owner mutate global placement assets', async () => {
    const context = seedContext();
    const globalId = `${context.key}_global_grammar`;
    db.prepare(`
      INSERT INTO placement_tests (id, title, test_type, instructions, status, branch_id, created_by, version)
      VALUES (?, ?, 'grammar', 'Global grammar bank', 'active', NULL, ?, 1)
    `).run(globalId, `${context.key} global grammar`, context.ownerId);

    const managerArchive = await supertest(context.app)
      .post(`/api/placement/test-bank/${globalId}/archive`)
      .set(context.managerA)
      .send({ version: 1 });
    expect(managerArchive.status).toBe(403);

    const ownerArchive = await supertest(context.app)
      .post(`/api/placement/test-bank/${globalId}/archive`)
      .set(context.owner)
      .send({ version: 1 });
    expect(ownerArchive.status).toBe(200);
  });
});
