import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcademicCatalogService } from '../../../core/academic/catalog-service.js';
import { db } from '../../../db/connection.js';
import { seedContext, type Wp05Context } from './fixtures.js';

let context: Wp05Context;

beforeEach(() => {
  context = seedContext();
});

describe('WP-05 level prerequisite graph', () => {
  it('rejects foreign, missing, self and cyclic prerequisite edges through the API', async () => {
    const original = db.prepare('SELECT prerequisites FROM levels WHERE id = ?').get(context.levelA) as { prerequisites: string };

    for (const prerequisites of [[context.levelB], [`${context.key}_missing`], [context.levelA]]) {
      const response = await supertest(context.app)
        .put(`/api/academic/levels/${context.levelA}`)
        .set(context.owner)
        .send({ prerequisites });
      expect(response.status).toBe(400);
      expect((db.prepare('SELECT prerequisites FROM levels WHERE id = ?').get(context.levelA) as { prerequisites: string }).prerequisites)
        .toBe(original.prerequisites);
    }

    const secondId = `${context.key}_cycle_second`;
    db.prepare(`
      INSERT INTO levels (id, program_id, program_version_id, name, "order", prerequisites)
      VALUES (?, ?, ?, 'Cycle second', 2, ?)
    `).run(secondId, context.programA, context.versionA, JSON.stringify([context.levelA]));

    const duplicate = await supertest(context.app)
      .put(`/api/academic/levels/${context.levelA}`)
      .set(context.owner)
      .send({ prerequisites: [secondId, secondId] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toMatch(/duplicate/i);

    const cycle = await supertest(context.app)
      .put(`/api/academic/levels/${context.levelA}`)
      .set(context.owner)
      .send({ prerequisites: [secondId] });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toMatch(/cycle/i);
  });

  it('enforces graph ownership, identity, uniqueness and acyclicity for direct writers', () => {
    const insert = db.prepare(`
      INSERT INTO levels (id, program_id, program_version_id, name, "order", prerequisites)
      VALUES (?, ?, ?, ?, 2, ?)
    `);

    expect(() => insert.run(`${context.key}_foreign`, context.programA, context.versionA, 'Foreign', JSON.stringify([context.levelB])))
      .toThrow(/prerequisite ownership/i);
    expect(() => insert.run(`${context.key}_missing`, context.programA, context.versionA, 'Missing', JSON.stringify([`${context.key}_none`])))
      .toThrow(/prerequisite ownership/i);
    expect(() => insert.run(`${context.key}_duplicate`, context.programA, context.versionA, 'Duplicate', JSON.stringify([context.levelA, context.levelA])))
      .toThrow(/prerequisite ownership/i);

    const dependentId = `${context.key}_dependent`;
    insert.run(dependentId, context.programA, context.versionA, 'Dependent', JSON.stringify([context.levelA]));
    expect(() => db.prepare('UPDATE levels SET prerequisites = ? WHERE id = ?')
      .run(JSON.stringify([dependentId]), context.levelA)).toThrow(/cycle/i);
    expect(() => db.prepare('DELETE FROM levels WHERE id = ?').run(context.levelA))
      .toThrow(/required by another level/i);
  });

  it('deactivates a level instead of deleting an endpoint that another level requires', async () => {
    const dependentId = `${context.key}_delete_dependent`;
    db.prepare(`
      INSERT INTO levels (id, program_id, program_version_id, name, "order", prerequisites)
      VALUES (?, ?, ?, 'Delete dependent', 2, ?)
    `).run(dependentId, context.programA, context.versionA, JSON.stringify([context.levelA]));

    const response = await supertest(context.app)
      .delete(`/api/academic/levels/${context.levelA}`)
      .set(context.owner);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, deactivated: true });
    expect((db.prepare('SELECT is_active FROM levels WHERE id = ?').get(context.levelA) as { is_active: number }).is_active).toBe(0);
  });

  it('remaps prerequisite ids when a program version is copied', () => {
    const sourceDependent = `${context.key}_source_dependent`;
    db.prepare(`
      INSERT INTO levels (id, program_id, program_version_id, name, "order", prerequisites, code)
      VALUES (?, ?, ?, 'Source dependent', 2, ?, 'DEP')
    `).run(sourceDependent, context.programA, context.versionA, JSON.stringify([context.levelA]));

    const copied = new AcademicCatalogService(db).createVersion({
      programId: context.programA,
      versionLabel: `${context.key} copy`,
      copyFromVersionId: context.versionA,
    }) as { version: { id: string }; levels: Array<{ id: string; name: string; prerequisites: string }> };

    const copiedBase = copied.levels.find((level) => level.name === 'Level A');
    const copiedDependent = copied.levels.find((level) => level.name === 'Source dependent');
    expect(copiedBase).toBeTruthy();
    expect(copiedDependent).toBeTruthy();
    expect(JSON.parse(copiedDependent!.prerequisites)).toEqual([copiedBase!.id]);
    expect(JSON.parse(copiedDependent!.prerequisites)).not.toContain(context.levelA);
    expect(copied.version.id).not.toBe(context.versionA);
  });
});
