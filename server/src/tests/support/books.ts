import express from 'express';
import type BetterSqlite3 from 'better-sqlite3';
import { errorHandler } from '../../middleware/errorHandler.js';
import { booksRouter } from '../../routes/books.routes.js';
import studentsRouter from '../../routes/students.routes.js';
import { FIXED_ORG_ID } from '../../db/organizationHierarchy.js';

export function createBooksTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/books', booksRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

export function ensureBookBranch(db: BetterSqlite3.Database, input: { campusId: string; branchId: string }): void {
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run(input.campusId, FIXED_ORG_ID, input.campusId, input.campusId.slice(0, 8));
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(input.branchId, input.branchId, 'Kabul', input.campusId);
}

export function ensureBookStudent(db: BetterSqlite3.Database, input: { id: string; branchId: string; fullName?: string }): void {
  const numericSuffix = Array.from(input.id).reduce((value, character) => (value * 31 + character.codePointAt(0)!) % 100_000_000, 0);
  const suffix = String(numericSuffix).padStart(8, '0');
  db.prepare(`
    INSERT OR IGNORE INTO students
      (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
    VALUES (?, ?, ?, 'active', '2026-08-23', ?, 'male', ?)
  `).run(input.id, `TH-BK-${suffix}`, input.fullName ?? input.id, input.branchId, `07${suffix}`);
}
