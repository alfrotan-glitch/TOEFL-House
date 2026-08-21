/**
 * Global search must gate EACH entity type on its own permission (audit V-5).
 *
 * The endpoint guard is an OR across six permissions, which is correct for
 * reaching the route but is not authorization for all six entity types. The
 * original defect: a teacher holding only Class.View received lead records —
 * name, serial and stage — from an endpoint whose own /api/visitors list
 * correctly returns 403.
 *
 * This suite exists because mutation testing exposed it as uncovered: replacing
 * `hasPermission()` with `return true` left every existing RBAC suite green,
 * even though the per-entity gate in search.routes.ts is its only production
 * caller. Verified live over HTTP before writing this — with a lead present, an
 * owner receives the `Visitor` entity and a teacher receives nothing.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { hashPassword, signToken, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import searchRouter from '../../../routes/search.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const BR = 'sep_b1';
let app: express.Express;

const bearer = (id: string) => {
  const u = db.prepare('SELECT id, username, full_name, branch_id FROM users WHERE id = ?').get(id) as { id: string; username: string; full_name: string; branch_id: string };
  const payload = {
    userId: u.id, username: u.username, branchId: u.branch_id,
    fullName: u.full_name, sessionVersion: 1,
  } as unknown as TokenPayload;
  return { Authorization: `Bearer ${signToken(payload)}` };
};

const entitiesFor = async (userId: string) => {
  const res = await supertest(app).get('/api/search?q=Confidential').set(bearer(userId));
  expect(res.status).toBe(200);
  const rows = (Array.isArray(res.body) ? res.body : res.body?.results ?? []) as Array<{ entity: string }>;
  return rows.map((r) => r.entity);
};

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BR, 'SEP Branch', 'Kabul');

  const pw = await hashPassword('pw');
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('sep_owner', 'sep_owner', 'SEP Owner', ?, ?, 1, 0)`,
  ).run(BR, pw);
  assignRole('sep_owner', 'owner', BR);
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password, linked_teacher_id )
     VALUES ('sep_teacher', 'sep_teacher', 'SEP Teacher', ?, ?, 1, 0, NULL)`,
  ).run(BR, pw);
  assignRole('sep_teacher', 'teacher', BR);

  // A lead only a Lead.View holder may see.
  db.prepare(
    `INSERT OR REPLACE INTO visitors (id, full_name, phone, branch_id, stage, status, serial_no, visit_date, gender, source)
     VALUES ('sep_v1', 'Confidential Lead', '0700888999', ?, 'lead', 'visited', 'V-SEP1', date('now'), 'male', 'walk_in')`,
  ).run(BR);

  app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
});

describe('V-5 · global search gates each entity on its own permission', () => {
  it('a teacher (no Lead.View) receives no Lead/Visitor rows', async () => {
    const entities = await entitiesFor('sep_teacher');
    expect(entities).not.toContain('Visitor');
    expect(entities).not.toContain('Lead');
  });

  it('an owner (holds Lead.View) does receive the lead', async () => {
    // Positive control: without this, the test above would also pass if search
    // simply returned nothing for everyone.
    const entities = await entitiesFor('sep_owner');
    expect(entities).toContain('Visitor');
  });
});
