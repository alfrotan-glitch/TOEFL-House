/**
 * WP-11 search contract — permission-scoped, branch-scoped and bounded.
 * ============================================================================
 * Global search is a cross-surface reporting/lookup endpoint. It must never be
 * a disclosure bypass around the entity routes it federates.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import searchRouter from '../../../routes/search.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { seedUser, bearerFor } from '../../support/identity.js';

const CAMPUS = 'wp11_search_campus';
const BRANCH_A = 'wp11_search_a';
const BRANCH_B = 'wp11_search_b';
const TODAY = '2026-08-20';

let app: express.Express;

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run(CAMPUS, FIXED_ORG_ID, 'WP11 Search Campus', 'WP11S');
  for (const branch of [BRANCH_A, BRANCH_B]) {
    db.prepare('INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
      .run(branch, branch, 'Kabul', CAMPUS);
  }

  seedUser({ id: 'wp11_search_owner', role: 'owner', branchId: BRANCH_A });
  seedUser({ id: 'wp11_search_manager_a', role: 'general_manager', branchId: BRANCH_A });

  const insertTeacher = db.prepare(
    `INSERT OR REPLACE INTO teachers (id, full_name, joined_date, status, branch_id, phone, specialization)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  );
  const insertClass = db.prepare(
    `INSERT OR REPLACE INTO classes
       (id, name, teacher_id, level, capacity, status, lifecycle_stage, fee, branch_id, start_date)
     VALUES (?, ?, ?, 'A1', 20, 'active', 'activated', 0, ?, ?)`,
  );
  const insertVisitor = db.prepare(
    `INSERT OR REPLACE INTO visitors
       (id, serial_no, full_name, phone, gender, source, visit_date, status, stage, branch_id)
     VALUES (?, ?, ?, ?, 'male', 'walk_in', ?, 'visited', 'lead', ?)`,
  );
  const insertStudent = db.prepare(
    `INSERT OR REPLACE INTO students
       (id, student_code, full_name, phone, gender, status, registration_date, branch_id, discount_percent)
     VALUES (?, ?, ?, ?, 'male', 'active', ?, ?, 0)`,
  );
  const insertBook = db.prepare(
    `INSERT OR REPLACE INTO books
       (id, title, item_kind, sale_enabled, sale_price, lending_enabled, status, branch_id)
     VALUES (?, ?, 'book', 1, 100, 0, 'active', ?)`,
  );
  const insertReceipt = db.prepare(
    `INSERT OR REPLACE INTO book_stock_receipts
       (id, book_id, quantity, received_on, unit_cost, note, received_by_user_id, received_by_name, branch_id, idempotency_key)
     VALUES (?, ?, 5, ?, 60, 'seed', 'wp11_search_owner', 'WP11 Search Owner', ?, ?)`,
  );

  for (let i = 0; i < 10; i += 1) {
    const suffix = String(i).padStart(2, '0');
    const teacherId = `wp11_search_teacher_${suffix}`;
    insertTeacher.run(teacherId, `Limit Probe Teacher ${suffix}`, TODAY, BRANCH_A, `0700${suffix}0000`, 'English');
    insertClass.run(`wp11_search_class_${suffix}`, `Limit Probe Class ${suffix}`, teacherId, BRANCH_A, TODAY);
    insertVisitor.run(`wp11_search_visitor_${suffix}`, `WP11V-${suffix}`, `Limit Probe Visitor ${suffix}`, `0710${suffix}0000`, TODAY, BRANCH_A);
    insertStudent.run(`wp11_search_student_${suffix}`, `WP11S-${suffix}`, `Limit Probe Student ${suffix}`, `0720${suffix}0000`, TODAY, BRANCH_A);
    insertBook.run(`wp11_search_book_${suffix}`, `Limit Probe Book ${suffix}`, BRANCH_A);
    insertReceipt.run(randomUUID(), `wp11_search_book_${suffix}`, TODAY, BRANCH_A, `wp11-search-receipt-${suffix}`);
  }

  insertStudent.run('wp11_search_scope_a', 'WP11-SCOPE-A', 'Cross Branch Probe A', '0730000000', TODAY, BRANCH_A);
  insertStudent.run('wp11_search_scope_b', 'WP11-SCOPE-B', 'Cross Branch Probe B', '0731000000', TODAY, BRANCH_B);

  app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
});

describe('WP-11 search contract', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await supertest(app).get('/api/search?q=Limit Probe');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a too-short query instead of guessing', async () => {
    const res = await supertest(app)
      .get('/api/search?q=A')
      .set(bearerFor('wp11_search_manager_a'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('refuses an overlong query', async () => {
    const res = await supertest(app)
      .get(`/api/search?q=${'x'.repeat(81)}`)
      .set(bearerFor('wp11_search_manager_a'));

    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? '')).toMatch(/too long/i);
  });

  it('escapes wildcard characters instead of treating them as LIKE control bytes', async () => {
    const res = await supertest(app)
      .get('/api/search?q=Limit%20Probe%25')
      .set(bearerFor('wp11_search_owner'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('silently re-scopes a forged branchId to the caller\'s authorized branch', async () => {
    const res = await supertest(app)
      .get(`/api/search?q=${encodeURIComponent('Cross Branch Probe')}&branchId=${BRANCH_B}`)
      .set(bearerFor('wp11_search_manager_a'));

    expect(res.status).toBe(200);
    const titles = (res.body as Array<{ title: string }>).map((row) => row.title);
    const studentRows = res.body.filter((row: { entity: string }) => row.entity === 'Student');
    expect(titles).toContain('Cross Branch Probe A');
    expect(titles).not.toContain('Cross Branch Probe B');
    expect(studentRows.every((row: { meta?: string }) => row.meta === BRANCH_A)).toBe(true);
  });

  it('lets an organization-wide principal intentionally widen to all branches', async () => {
    const res = await supertest(app)
      .get('/api/search?q=Cross%20Branch%20Probe&branchId=all')
      .set(bearerFor('wp11_search_owner'));

    expect(res.status).toBe(200);
    const titles = (res.body as Array<{ title: string }>).map((row) => row.title);
    expect(titles).toContain('Cross Branch Probe A');
    expect(titles).toContain('Cross Branch Probe B');
  });

  it('caps the aggregate result set and each entity slice', async () => {
    const res = await supertest(app)
      .get('/api/search?q=Limit%20Probe')
      .set(bearerFor('wp11_search_owner'));

    expect(res.status).toBe(200);
    const rows = res.body as Array<{ entity: string }>;
    expect(rows).toHaveLength(32);

    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.entity] = (acc[row.entity] ?? 0) + 1;
      return acc;
    }, {});
    for (const count of Object.values(counts)) expect(count).toBeLessThanOrEqual(8);
  });
});
