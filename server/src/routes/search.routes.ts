import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';

export const searchRouter = Router();
searchRouter.use(authenticate);

const MAX_RESULTS = 8;
const sanitizeLike = (value: string) => value.replace(/[%_\\]/g, '\\$&');

function like(value: string): string {
  return `%${sanitizeLike(value.trim())}%`;
}

searchRouter.get('/', requirePermission('Student.View', 'Lead.View', 'Teacher.View', 'Class.View', 'Invoice.View', 'Book.View'), ah(async (req, res) => {
  const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (raw.length < 2) {
    res.json([]);
    return;
  }
  if (raw.length > 80) throw new HttpError(400, 'Search query is too long.');

  const { branchId } = resolveBranchScope(req);
  const q = like(raw);
  const limit = 8;
  const results: Array<{ id: string; entity: string; title: string; subtitle: string; tab: string; meta?: string }> = [];

  const push = (rows: Array<{ id: string; title: string; subtitle: string; tab: string; meta?: string }>, entity: string) => {
    for (const row of rows) {
      results.push({ ...row, entity });
      if (results.length >= MAX_RESULTS * 6) break;
    }
  };

  const students = branchId
    ? db.prepare(`SELECT id, full_name AS title, COALESCE(student_code,'') AS subtitle, branch_id FROM students WHERE branch_id = ? AND (full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(branchId, q, q, q, limit)
    : db.prepare(`SELECT id, full_name AS title, COALESCE(student_code,'') AS subtitle, branch_id FROM students WHERE (full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(q, q, q, limit);
  push((students as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'students', meta: r.branch_id })), 'Student');

  const visitors = branchId
    ? db.prepare(`SELECT id, full_name AS title, COALESCE(serial_no,'') AS subtitle, stage FROM visitors WHERE branch_id = ? AND (full_name LIKE ? ESCAPE '\\' OR serial_no LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(branchId, q, q, q, limit)
    : db.prepare(`SELECT id, full_name AS title, COALESCE(serial_no,'') AS subtitle, stage FROM visitors WHERE full_name LIKE ? ESCAPE '\\' OR serial_no LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`).all(q, q, q, limit);
  push((visitors as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'visitors', meta: r.stage })), 'Visitor');

  const teachers = branchId
    ? db.prepare(`SELECT id, full_name AS title, COALESCE(phone,'') AS subtitle FROM teachers WHERE branch_id = ? AND (full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR specialization LIKE ? ESCAPE '\\') ORDER BY full_name LIMIT ?`).all(branchId, q, q, q, limit)
    : db.prepare(`SELECT id, full_name AS title, COALESCE(phone,'') AS subtitle FROM teachers WHERE full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR specialization LIKE ? ESCAPE '\\' ORDER BY full_name LIMIT ?`).all(q, q, q, limit);
  push((teachers as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'teachers' })), 'Teacher');

  // classes has no `code` column (schema.sql defines only name/level/status);
  // search by name and show the level as the subtitle.
  const classes = branchId
    ? db.prepare(`SELECT id, name AS title, COALESCE(level,'') AS subtitle, status FROM classes WHERE branch_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY start_date DESC LIMIT ?`).all(branchId, q, limit)
    : db.prepare(`SELECT id, name AS title, COALESCE(level,'') AS subtitle, status FROM classes WHERE name LIKE ? ESCAPE '\\' ORDER BY start_date DESC LIMIT ?`).all(q, limit);
  push((classes as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'classes', meta: r.status })), 'Class');

  const invoices = branchId
    ? db.prepare(`SELECT id, invoice_number AS title, COALESCE(student_name,'') AS subtitle, status FROM invoices WHERE branch_id = ? AND (invoice_number LIKE ? ESCAPE '\\' OR student_name LIKE ? ESCAPE '\\') ORDER BY issue_date DESC LIMIT ?`).all(branchId, q, q, limit)
    : db.prepare(`SELECT id, invoice_number AS title, COALESCE(student_name,'') AS subtitle, status FROM invoices WHERE invoice_number LIKE ? ESCAPE '\\' OR student_name LIKE ? ESCAPE '\\' ORDER BY issue_date DESC LIMIT ?`).all(q, q, limit);
  push((invoices as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'finance', meta: r.status })), 'Invoice');

  const books = branchId
    ? db.prepare(`SELECT id, title, title AS subtitle, stock, branch_id FROM books WHERE branch_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?`).all(branchId, q, limit)
    : db.prepare(`SELECT id, title, title AS subtitle, stock FROM books WHERE title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?`).all(q, limit);
  push((books as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'books', meta: `${r.stock ?? 0} in stock` })), 'Book');

  res.json(results.slice(0, MAX_RESULTS * 4));
}));

export default searchRouter;
