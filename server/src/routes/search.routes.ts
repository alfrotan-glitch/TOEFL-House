import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import {
  canAccessAllBranchesForRequirement,
  canAccessBranchForRequirement,
  hasPermissionForBranchWithActionScopes,
} from '../core/rbac/rbac-service.js';
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

  // Search is an aggregate endpoint: resolve the caller's assignment envelope
  // here, then authorize every result category against its own permission below.
  const { branchId } = resolveBranchScope(req, { ignoreAccessRequirement: true });

  // AUTHORIZATION (audit V-5).
  //
  // The route guard is an OR across six permissions, which is correct for
  // reaching the endpoint but was silently treated as authorization for all six
  // ENTITY TYPES. A teacher holding only Class.View received lead records —
  // name, serial and stage — from an endpoint whose own /api/visitors list
  // correctly returns 403, and could confirm whether any phone number belonged
  // to a lead. Each category is now gated on its own permission, correlated
  // assignment boundary, and branch-capable action scope. Narrow own/class
  // grants fail closed because this endpoint has no object ownership filter.
  const may = (code: string) => Boolean(req.rbac && (branchId
    ? canAccessBranchForRequirement(db, req.rbac, branchId, { permissionCodes: [code] })
    : canAccessAllBranchesForRequirement(req.rbac, { permissionCodes: [code] })));
  const linked = db.prepare('SELECT linked_teacher_id AS teacherId FROM users WHERE id = ?')
    .get(req.user?.userId) as { teacherId: string | null } | undefined;
  const teacherId = linked?.teacherId ?? null;
  const mayNarrow = (code: string, scopes: Array<'class' | 'own'>) => Boolean(
    req.rbac && branchId && teacherId && hasPermissionForBranchWithActionScopes(
      db, req.rbac, branchId, [code], scopes,
    ),
  );
  const broadStudents = may('Student.View');
  const narrowStudents = mayNarrow('Student.View', ['class']);
  const broadClasses = may('Class.View');
  const narrowClasses = mayNarrow('Class.View', ['class', 'own']);
  const mayStudents = broadStudents || narrowStudents;
  const mayLeads = may('Lead.View');
  const mayTeachers = may('Teacher.View');
  const mayClasses = broadClasses || narrowClasses;
  const mayInvoices = may('Invoice.View');
  const mayBooks = may('Book.View');
  const q = like(raw);
  const limit = 8;
  const results: Array<{ id: string; entity: string; title: string; subtitle: string; tab: string; meta?: string }> = [];

  const push = (rows: Array<{ id: string; title: string; subtitle: string; tab: string; meta?: string }>, entity: string) => {
    for (const row of rows) {
      results.push({ ...row, entity });
      if (results.length >= MAX_RESULTS * 6) break;
    }
  };

  const students = !mayStudents ? [] : narrowStudents && !broadStudents && branchId && teacherId
    ? db.prepare(`SELECT s.id, s.full_name AS title, COALESCE(s.student_code,'') AS subtitle, s.branch_id
        FROM students s
       WHERE s.branch_id = ?
         AND (s.full_name LIKE ? ESCAPE '\\' OR s.student_code LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\')
         AND EXISTS (
           SELECT 1 FROM classes c WHERE c.teacher_id = ?
             AND (EXISTS (SELECT 1 FROM student_semesters ss WHERE ss.student_id = s.id AND ss.class_id = c.id AND ss.status IN ('active','deferred'))
               OR EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.class_id = c.id AND e.status IN ('active','confirmed','pending')))
         ) ORDER BY s.created_at DESC LIMIT ?`).all(branchId, q, q, q, teacherId, limit)
    : branchId
      ? db.prepare(`SELECT id, full_name AS title, COALESCE(student_code,'') AS subtitle, branch_id FROM students WHERE branch_id = ? AND (full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(branchId, q, q, q, limit)
      : db.prepare(`SELECT id, full_name AS title, COALESCE(student_code,'') AS subtitle, branch_id FROM students WHERE (full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(q, q, q, limit);
  push((students as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'students', meta: r.branch_id })), 'Student');

  const visitors = !mayLeads ? [] : branchId
    ? db.prepare(`SELECT id, full_name AS title, COALESCE(serial_no,'') AS subtitle, stage FROM visitors WHERE branch_id = ? AND (full_name LIKE ? ESCAPE '\\' OR serial_no LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(branchId, q, q, q, limit)
    : db.prepare(`SELECT id, full_name AS title, COALESCE(serial_no,'') AS subtitle, stage FROM visitors WHERE full_name LIKE ? ESCAPE '\\' OR serial_no LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`).all(q, q, q, limit);
  push((visitors as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'visitors', meta: r.stage })), 'Visitor');

  const teachers = !mayTeachers ? [] : branchId
    ? db.prepare(`SELECT id, full_name AS title, COALESCE(phone,'') AS subtitle FROM teachers WHERE branch_id = ? AND (full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR specialization LIKE ? ESCAPE '\\') ORDER BY full_name LIMIT ?`).all(branchId, q, q, q, limit)
    : db.prepare(`SELECT id, full_name AS title, COALESCE(phone,'') AS subtitle FROM teachers WHERE full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR specialization LIKE ? ESCAPE '\\' ORDER BY full_name LIMIT ?`).all(q, q, q, limit);
  push((teachers as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'teachers' })), 'Teacher');

  // classes has no `code` column (schema.sql defines only name/level/status);
  // search by name and show the level as the subtitle.
  const classes = !mayClasses ? [] : narrowClasses && !broadClasses && branchId && teacherId
    ? db.prepare(`SELECT id, name AS title, COALESCE(level,'') AS subtitle, status FROM classes
        WHERE branch_id = ? AND teacher_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY start_date DESC LIMIT ?`).all(branchId, teacherId, q, limit)
    : branchId
      ? db.prepare(`SELECT id, name AS title, COALESCE(level,'') AS subtitle, status FROM classes WHERE branch_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY start_date DESC LIMIT ?`).all(branchId, q, limit)
      : db.prepare(`SELECT id, name AS title, COALESCE(level,'') AS subtitle, status FROM classes WHERE name LIKE ? ESCAPE '\\' ORDER BY start_date DESC LIMIT ?`).all(q, limit);
  push((classes as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'classes', meta: r.status })), 'Class');

  const invoices = !mayInvoices ? [] : branchId
    ? db.prepare(`SELECT id, invoice_number AS title, COALESCE(student_name,'') AS subtitle, status FROM invoices WHERE branch_id = ? AND (invoice_number LIKE ? ESCAPE '\\' OR student_name LIKE ? ESCAPE '\\') ORDER BY issue_date DESC LIMIT ?`).all(branchId, q, q, limit)
    : db.prepare(`SELECT id, invoice_number AS title, COALESCE(student_name,'') AS subtitle, status FROM invoices WHERE invoice_number LIKE ? ESCAPE '\\' OR student_name LIKE ? ESCAPE '\\' ORDER BY issue_date DESC LIMIT ?`).all(q, q, limit);
  push((invoices as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'finance', meta: r.status })), 'Invoice');

  const books = !mayBooks ? [] : branchId
    ? db.prepare(`SELECT b.id, b.title, b.title AS subtitle, p.available_quantity, b.branch_id
                    FROM books b JOIN book_inventory_positions p ON p.book_id = b.id
                   WHERE b.branch_id = ? AND b.title LIKE ? ESCAPE '\\' ORDER BY b.title LIMIT ?`).all(branchId, q, limit)
    : db.prepare(`SELECT b.id, b.title, b.title AS subtitle, p.available_quantity
                    FROM books b JOIN book_inventory_positions p ON p.book_id = b.id
                   WHERE b.title LIKE ? ESCAPE '\\' ORDER BY b.title LIMIT ?`).all(q, limit);
  push((books as any[]).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle, tab: 'books', meta: `${r.available_quantity ?? 0} available` })), 'Book');

  res.json(results.slice(0, MAX_RESULTS * 4));
}));

export default searchRouter;
