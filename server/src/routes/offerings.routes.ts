/**
 * Course Offering Engine
 * Program Version + Level + Branch + Term → delivery instance; Class is a section under it.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import {
  hasPermissionForBranchWithActionScopes,
} from '../core/rbac/rbac-service.js';

export const offeringsRouter = Router();
offeringsRouter.use(authenticate);

const SELECT_BASE = `
  SELECT o.*,
    p.name AS program_name,
    pv.version_label AS version_label,
    l.name AS level_name,
    t.name AS term_name,
    (SELECT COUNT(*) FROM classes c WHERE c.offering_id = o.id) AS class_count,
    (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e
       JOIN classes c2 ON c2.id = e.class_id
       WHERE c2.offering_id = o.id AND e.status = 'active') AS enrolled_count
  FROM course_offerings o
  LEFT JOIN programs p ON p.id = o.program_id
  LEFT JOIN program_versions pv ON pv.id = o.program_version_id
  LEFT JOIN levels l ON l.id = o.level_id
  LEFT JOIN academic_terms t ON t.id = o.academic_term_id
`;

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetAllOfferings = db.prepare(`${SELECT_BASE} ORDER BY o.created_at DESC`);
const stmtGetOfferingsByBranch = db.prepare(`${SELECT_BASE} WHERE o.branch_id = ? ORDER BY o.created_at DESC`);
const stmtGetOfferingById = db.prepare(`${SELECT_BASE} WHERE o.id = ?`);
const stmtGetClassesByOffering = db.prepare(
  `SELECT id, name, status, capacity, teacher_id, time_slot_id, room_id, branch_id FROM classes WHERE offering_id = ? ORDER BY name`
);
const stmtGetLinkedTeacher = db.prepare('SELECT linked_teacher_id AS teacherId FROM users WHERE id = ?');
const stmtTeacherOwnsOffering = db.prepare('SELECT 1 FROM classes WHERE offering_id = ? AND teacher_id = ? LIMIT 1');
const stmtGetTeacherOfferingCounts = db.prepare(`
  SELECT COUNT(*) AS classCount,
         COUNT(DISTINCT CASE WHEN e.status = 'active' THEN e.student_id END) AS enrolledCount
    FROM classes c
    LEFT JOIN enrollments e ON e.class_id = c.id
   WHERE c.offering_id = ? AND c.teacher_id = ?
`);
const stmtInsertOffering = db.prepare(
  `INSERT INTO course_offerings (id, program_id, program_version_id, level_id, branch_id, academic_term_id, code, name, status, capacity_total, fee_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetOfferingForUpdate = db.prepare('SELECT * FROM course_offerings WHERE id = ?');
const stmtUpdateOffering = db.prepare(
  `UPDATE course_offerings SET program_id = ?, program_version_id = ?, level_id = ?, academic_term_id = ?, code = ?, name = ?, status = ?, capacity_total = ?, fee_snapshot = ? WHERE id = ?`
);
const stmtGetClassForLink = db.prepare('SELECT * FROM classes WHERE id = ?');
const stmtLinkClass = db.prepare('UPDATE classes SET offering_id = ? WHERE id = ?');
const stmtCountLinkedClasses = db.prepare('SELECT COUNT(*) AS c FROM classes WHERE offering_id = ?');
const stmtDeleteOffering = db.prepare('DELETE FROM course_offerings WHERE id = ?');
const stmtGetProgramScope = db.prepare(`SELECT p.id, p.branch_id, pv.id AS program_version_id, pv.status AS version_status, pv.version_label, l.id AS level_id, l.program_id AS level_program_id, l.program_version_id AS level_version_id, l.default_fee, (SELECT fee FROM level_branch_fees WHERE level_id = l.id AND branch_id = p.branch_id LIMIT 1) AS branch_fee FROM programs p LEFT JOIN program_versions pv ON pv.id = ? LEFT JOIN levels l ON l.id = ? WHERE p.id = ?`);
const stmtGetTermScope = db.prepare('SELECT id, branch_id FROM academic_terms WHERE id = ?');

function requireOfferingBranchAccess(req: import('express').Request, row: any): void {
  if (!row?.branch_id || !canAccessBranchResource(req, String(row.branch_id))) {
    throw new HttpError(403, 'Course offering is outside your authorized branch scope.');
  }
}

function classViewScopeForOffering(req: import('express').Request, row: any): { broad: boolean; teacherId: string | null } {
  if (!req.rbac || !row?.branch_id) return { broad: false, teacherId: null };
  const broad = hasPermissionForBranchWithActionScopes(
    db, req.rbac, String(row.branch_id), ['Class.View'], ['organization', 'campus', 'branch', 'department'],
  );
  if (broad) return { broad: true, teacherId: null };
  const narrow = hasPermissionForBranchWithActionScopes(
    db, req.rbac, String(row.branch_id), ['Class.View'], ['class', 'own'],
  );
  if (!narrow) return { broad: false, teacherId: null };
  const linked = stmtGetLinkedTeacher.get(req.user?.userId) as { teacherId: string | null } | undefined;
  const teacherId = linked?.teacherId ?? null;
  const ownsOffering = teacherId && stmtTeacherOwnsOffering.get(row.id, teacherId);
  return { broad: false, teacherId: ownsOffering ? teacherId : null };
}

function requireRelatedBranchMatch(offering: any, related: any, label: string): void {
  if (offering.branch_id !== related.branch_id) {
    throw new HttpError(400, `${label} belongs to another branch.`);
  }
}

function mapOffering(row: any, teacherId: string | null = null) {
  if (!row) return null;
  const narrowCounts = teacherId
    ? stmtGetTeacherOfferingCounts.get(row.id, teacherId) as { classCount: number; enrolledCount: number }
    : null;
  return {
    id: row.id,
    programId: row.program_id,
    programName: row.program_name ?? null,
    programVersionId: row.program_version_id,
    versionLabel: row.version_label ?? null,
    levelId: row.level_id,
    levelName: row.level_name ?? null,
    branchId: row.branch_id,
    academicTermId: row.academic_term_id,
    termName: row.term_name ?? null,
    code: row.code,
    name: row.name,
    status: row.status,
    capacityTotal: row.capacity_total ?? 0,
    feeSnapshot: row.fee_snapshot ?? 0,
    classCount: narrowCounts?.classCount ?? row.class_count ?? 0,
    enrolledCount: narrowCounts?.enrolledCount ?? row.enrolled_count ?? 0,
    createdAt: row.created_at,
  };
}

offeringsRouter.get(
  '/',
  requirePermission('Class.View'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req, { ignoreAccessRequirement: true });
    const { status } = req.query as { status?: string };
    let rows = (isAll ? stmtGetAllOfferings.all() : stmtGetOfferingsByBranch.all(branchId)) as any[];
    rows = rows.filter((row) => {
      const scope = classViewScopeForOffering(req, row);
      return scope.broad || !!scope.teacherId;
    });

    if (status) {
      rows = rows.filter(r => r.status === status);
    }
    
    res.json(rows.map((row) => {
      const scope = classViewScopeForOffering(req, row);
      return mapOffering(row, scope.broad ? null : scope.teacherId);
    }));
  })
);

offeringsRouter.get(
  '/:id',
  requirePermission('Class.View'),
  ah(async (req, res) => {
    const row = stmtGetOfferingById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Course offering not found.');
    const scope = classViewScopeForOffering(req, row);
    if (!scope.broad && !scope.teacherId) {
      throw new HttpError(403, 'Course offering is outside your authorized class scope.');
    }
    let classes = stmtGetClassesByOffering.all(req.params.id) as any[];
    if (!scope.broad) classes = classes.filter((cls) => cls.teacher_id === scope.teacherId);
    res.json({ ...mapOffering(row, scope.broad ? null : scope.teacherId), classes });
  })
);

offeringsRouter.post(
  '/',
  authorize('general_manager', 'head_of_department', 'receptionist', 'owner'),
  ah(async (req, res) => {
    const userBranchId = req.user?.branchId;
    const { programId, programVersionId, levelId, branchId, academicTermId, code, name, status = 'draft' } = req.body || {};
    const resolvedBranchId = branchId || userBranchId;
    if (!name || !resolvedBranchId || !programId || !programVersionId || !levelId || !academicTermId) throw new HttpError(400, 'name, program, program version, level, term and branch are required.');
    if (!canAccessBranchResource(req, resolvedBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
    if (!['draft', 'open', 'closed', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status.');
    const scope = stmtGetProgramScope.get(programVersionId, levelId, programId) as any;
    if (!scope || scope.id !== programId || scope.program_version_id !== programVersionId || scope.level_id !== levelId) throw new HttpError(400, 'Program, version and level must form one consistent curriculum path.');
    if (String(scope.branch_id) !== String(resolvedBranchId)) throw new HttpError(400, 'Program belongs to another branch.');
    if (scope.version_status === 'archived') throw new HttpError(400, 'Archived program versions cannot be offered.');
    if (scope.level_program_id !== programId || (scope.level_version_id && scope.level_version_id !== programVersionId)) throw new HttpError(400, 'Selected level does not belong to the selected program version.');
    const term = stmtGetTermScope.get(academicTermId) as any;
    if (!term || String(term.branch_id) !== String(resolvedBranchId)) throw new HttpError(400, 'Academic term belongs to another branch or does not exist.');
    const resolvedFee = Number(scope.branch_fee ?? scope.default_fee ?? 0);

    const newId = id('off');
    stmtInsertOffering.run(
      newId, programId, programVersionId, levelId, resolvedBranchId,
      academicTermId, code || null, name, status, 0, resolvedFee
    );

    writeAudit(req, `Created course offering "${name}"`);
    const row = stmtGetOfferingById.get(newId) as any;
    res.status(201).json(mapOffering(row));
  })
);

offeringsRouter.patch(
  '/:id',
  authorize('general_manager', 'head_of_department', 'receptionist', 'owner'),
  ah(async (req, res) => {
    const existing = stmtGetOfferingForUpdate.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Course offering not found.');
    requireOfferingBranchAccess(req, existing);

    const { programId, programVersionId, levelId, academicTermId, code, name, status } = req.body || {};
    if (status && !['draft', 'open', 'closed', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status.');
    const curriculumChanged = programId !== undefined || programVersionId !== undefined || levelId !== undefined || academicTermId !== undefined;
    const nextProgramId = programId !== undefined ? programId : existing.program_id;
    const nextVersionId = programVersionId !== undefined ? programVersionId : existing.program_version_id;
    const nextLevelId = levelId !== undefined ? levelId : existing.level_id;
    const nextTermId = academicTermId !== undefined ? academicTermId : existing.academic_term_id;
    let resolvedFee = Number(existing.fee_snapshot ?? 0);
    if (curriculumChanged) {
      if (!nextProgramId || !nextVersionId || !nextLevelId || !nextTermId) throw new HttpError(400, 'Program, version, level and term are required when changing curriculum scope.');
      const scope = stmtGetProgramScope.get(nextVersionId, nextLevelId, nextProgramId) as any;
      if (!scope || scope.id !== nextProgramId || scope.program_version_id !== nextVersionId || scope.level_id !== nextLevelId) throw new HttpError(400, 'Program, version and level must remain consistent.');
      if (String(scope.branch_id) !== String(existing.branch_id)) throw new HttpError(400, 'Program belongs to another branch.');
      const term = stmtGetTermScope.get(nextTermId) as any;
      if (!term || String(term.branch_id) !== String(existing.branch_id)) throw new HttpError(400, 'Academic term belongs to another branch.');
      resolvedFee = Number(scope.branch_fee ?? scope.default_fee ?? existing.fee_snapshot ?? 0);
    }
    stmtUpdateOffering.run(nextProgramId, nextVersionId, nextLevelId, nextTermId, code !== undefined ? code : existing.code, name !== undefined ? name : existing.name, status !== undefined ? status : existing.status, existing.capacity_total, resolvedFee, req.params.id);

    writeAudit(req, `Updated course offering ${req.params.id}`);
    const row = stmtGetOfferingById.get(req.params.id) as any;
    res.json(mapOffering(row));
  })
);

offeringsRouter.post(
  '/:id/link-class',
  authorize('general_manager', 'head_of_department', 'receptionist', 'owner'),
  ah(async (req, res) => {
    const { classId } = req.body || {};
    if (!classId) throw new HttpError(400, 'classId is required.');
    
    const offering = stmtGetOfferingForUpdate.get(req.params.id) as any;
    if (!offering) throw new HttpError(404, 'Course offering not found.');
    requireOfferingBranchAccess(req, offering);
    
    const cls = stmtGetClassForLink.get(classId) as any;
    if (!cls) throw new HttpError(404, 'Class not found.');
    requireRelatedBranchMatch(offering, cls, 'Class');

    stmtLinkClass.run(req.params.id, classId);
    writeAudit(req, `Linked class ${classId} to offering ${req.params.id}`);
    res.json({ ok: true });
  })
);

offeringsRouter.delete(
  '/:id',
  authorize('general_manager', 'owner'),
  ah(async (req, res) => {
    const existing = stmtGetOfferingForUpdate.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Course offering not found.');
    requireOfferingBranchAccess(req, existing);
    const linked = (stmtCountLinkedClasses.get(req.params.id) as { c: number }).c;
    if (linked > 0) {
      throw new HttpError(409, 'Cannot delete offering with linked classes. Unlink or archive instead.');
    }
    
    stmtDeleteOffering.run(req.params.id);
    writeAudit(req, `Deleted course offering ${req.params.id}`);
    res.json({ ok: true });
  })
);

export default offeringsRouter;