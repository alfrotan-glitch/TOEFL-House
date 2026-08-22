/**
 * WP-05 — course offering compatibility across the normal configuration order.
 *
 * The regression begins with the real desk sequence: Program → Version → Level
 * → Offering. A level created after its version must be explicitly attached to
 * that version; an offering must never infer or weaken that relationship.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { academicRouter } from '../../../routes/academic.routes.js';
import { catalogRouter } from '../../../routes/catalog.routes.js';
import { offeringsRouter } from '../../../routes/offerings.routes.js';
import { bearerFor, seedUser } from '../../support/identity.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');

interface Context {
  app: express.Express;
  owner: { Authorization: string };
  branchId: string;
  suffix: string;
}

function createContext(): Context {
  initSchema();
  const suffix = `offering_version_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const branchId = `${suffix}_branch`;
  const ownerId = `${suffix}_owner`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(branchId, `${suffix} Branch`);
  seedUser({ id: ownerId, role: 'owner', branchId, fullName: `${suffix} Owner` });

  const app = express();
  app.use(express.json());
  app.use('/api/academic', academicRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/offerings', offeringsRouter);
  app.use(errorHandler);
  return { app, owner: bearerFor(ownerId), branchId, suffix };
}

async function createProgramVersion(context: Context, label = 'v1') {
  const program = await supertest(context.app)
    .post('/api/academic/programs')
    .set(context.owner)
    .send({ name: `${context.suffix} Program ${label}`, branchId: context.branchId });
  expect(program.status).toBe(201);

  const version = await supertest(context.app)
    .post('/api/catalog/program-versions')
    .set(context.owner)
    .send({ programId: program.body.id, versionLabel: label });
  expect(version.status).toBe(201);
  const versionId = version.body.version.id as string;
  expect((await supertest(context.app)
    .post(`/api/catalog/program-versions/${versionId}/publish`)
    .set(context.owner)
    .send({})).status).toBe(200);

  return { programId: program.body.id as string, versionId };
}

async function createTermRoomAndSlot(context: Context) {
  const term = await supertest(context.app)
    .post('/api/academic/terms')
    .set(context.owner)
    .send({ branchId: context.branchId, year: 1405, code: `${context.suffix}_T1`, name: 'Term 1', startDate: '2026-08-01', endDate: '2026-12-01' });
  const room = await supertest(context.app)
    .post('/api/academic/rooms')
    .set(context.owner)
    .send({ branchId: context.branchId, code: `${context.suffix}_R1`, name: 'Room 1', capacity: 20 });
  const slot = await supertest(context.app)
    .post('/api/academic/time-slots')
    .set(context.owner)
    .send({ branchId: context.branchId, code: `${context.suffix}_AM`, label: 'Morning', startTime: '08:00', endTime: '10:00' });
  expect([term.status, room.status, slot.status]).toEqual([201, 201, 201]);
  return { termId: term.body.id as string };
}

let context: Context;
beforeEach(() => { context = createContext(); });

describe('WP-05 · course offering version compatibility', () => {
  it('supports Program → Version → Level → Offering → Generate through the real APIs', async () => {
    const { programId, versionId } = await createProgramVersion(context);
    const level = await supertest(context.app)
      .post('/api/academic/levels')
      .set(context.owner)
      .send({ programId, programVersionId: versionId, name: 'Level created after version', minViableSize: 1 });
    expect(level.status).toBe(201);
    expect(level.body.programVersionId).toBe(versionId);
    expect(
      db.prepare('SELECT program_version_id FROM levels WHERE id = ?').get(level.body.id),
    ).toEqual({ program_version_id: versionId });

    const { termId } = await createTermRoomAndSlot(context);
    const offering = await supertest(context.app)
      .post('/api/offerings')
      .set(context.owner)
      .send({
        name: 'Offering from the normal configuration order',
        branchId: context.branchId,
        programId,
        programVersionId: versionId,
        levelId: level.body.id,
        academicTermId: termId,
        status: 'open',
      });
    expect(offering.status).toBe(201);

    const preview = await supertest(context.app)
      .post('/api/catalog/class-generation/preview')
      .set(context.owner)
      .send({ branchId: context.branchId, offeringId: offering.body.id });
    expect(preview.status).toBe(200);
    expect(preview.body.items).toHaveLength(1);

    const draft = await supertest(context.app)
      .post('/api/catalog/class-generation/drafts')
      .set(context.owner)
      .send({ branchId: context.branchId, offeringId: offering.body.id });
    expect(draft.status).toBe(201);

    const published = await supertest(context.app)
      .post(`/api/catalog/class-generation/${draft.body.run.id}/publish`)
      .set(context.owner)
      .send({});
    expect(published.status).toBe(200);
    expect(published.body.createdClassIds).toHaveLength(1);
    const generated = db.prepare(
      'SELECT offering_id, program_id, level_id, academic_term_id FROM classes WHERE id = ?',
    ).get(published.body.createdClassIds[0]);
    expect(generated).toEqual({
      offering_id: offering.body.id,
      program_id: programId,
      level_id: level.body.id,
      academic_term_id: termId,
    });
  });

  it('attaches an existing unversioned level only through an explicit compatible command', async () => {
    const { programId, versionId } = await createProgramVersion(context);
    const level = await supertest(context.app)
      .post('/api/academic/levels')
      .set(context.owner)
      .send({ programId, name: 'Existing unversioned level' });
    expect(level.status).toBe(201);
    expect(level.body.programVersionId).toBeNull();

    const attached = await supertest(context.app)
      .post(`/api/academic/levels/${level.body.id}/assign-version`)
      .set(context.owner)
      .send({ programVersionId: versionId });
    expect(attached.status).toBe(200);
    expect(attached.body.programVersionId).toBe(versionId);

    const repeat = await supertest(context.app)
      .post(`/api/academic/levels/${level.body.id}/assign-version`)
      .set(context.owner)
      .send({ programVersionId: versionId });
    expect(repeat.status).toBe(409);
  });

  it('rejects cross-program version assignment without mutating the level', async () => {
    const own = await createProgramVersion(context, 'own');
    const foreign = await createProgramVersion(context, 'foreign');
    const level = await supertest(context.app)
      .post('/api/academic/levels')
      .set(context.owner)
      .send({ programId: own.programId, name: 'Own unversioned level' });
    expect(level.status).toBe(201);

    const rejected = await supertest(context.app)
      .post(`/api/academic/levels/${level.body.id}/assign-version`)
      .set(context.owner)
      .send({ programVersionId: foreign.versionId });
    expect(rejected.status).toBe(400);
    expect(
      db.prepare('SELECT program_version_id FROM levels WHERE id = ?').get(level.body.id),
    ).toEqual({ program_version_id: null });
  });

  it('publishes level-version identity and never lists an unversioned level as offering-compatible', () => {
    const academicRoute = fs.readFileSync(path.join(repoRoot, 'server', 'src', 'routes', 'academic.routes.ts'), 'utf8');
    const offeringPanel = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'academic', 'OfferingsPanel.tsx'), 'utf8');
    expect(academicRoute).toContain('programVersionId: row.program_version_id ?? null');
    expect(offeringPanel).toContain('l.programVersionId === form.programVersionId');
    expect(offeringPanel).not.toContain('!l.programVersionId || l.programVersionId === form.programVersionId');
  });
});
