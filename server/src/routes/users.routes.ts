import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { hashPassword } from '../utils/auth.js';
import { assignPrimaryRole } from '../core/rbac/rbac-service.js';
import { ROLE_CODES, type RoleCode } from '../core/rbac/permission-catalog.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

/**
 * Positions this endpoint may assign, named by canonical role code. `data_entry`
 * is deliberately absent: it exists in the catalog but is not offered as an
 * account type here.
 */
const ALLOWED_ROLES: RoleCode[] = ['owner', 'general_manager', 'finance_manager', 'receptionist', 'teacher', 'head_of_department', 'counselor', 'donor_manager', 'student'];

/**
 * A user's position is read from their primary assignment, because that is
 * where it lives. There is no role column to read it from.
 */
const stmtGetAllUsers = db.prepare(
  `SELECT u.id, u.username, u.full_name, u.email, u.branch_id, u.is_active, u.must_change_password,
          u.created_at, u.last_login_at, r.code AS role
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.is_primary = 1
     LEFT JOIN roles r ON r.id = ur.role_id
    ORDER BY u.created_at DESC`
);

const stmtGetUserById = db.prepare(
  `SELECT u.id, u.full_name, u.branch_id, u.is_active, r.code AS role
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.is_primary = 1
     LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.id = ?`
);
const stmtCheckUsernameExists = db.prepare('SELECT id FROM users WHERE username = ?');

const stmtInsertUser = db.prepare(
  `INSERT INTO users (id, username, password_hash, full_name, email, branch_id, campus_id, linked_teacher_id, linked_employee_id, linked_partner_id, linked_student_id, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
);

const stmtUpdateUser = db.prepare(
  `UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), branch_id = COALESCE(?, branch_id), is_active = COALESCE(?, is_active) WHERE id = ?`
);
// campus_id follows the branch whenever it changes (set inside the PATCH handler).

const stmtResetPassword = db.prepare(
  'UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = ?'
);

usersRouter.get(
  '/',
  authorize('owner'),
  ah(async (req, res) => {
    res.json(stmtGetAllUsers.all());
  })
);

usersRouter.post(
  '/',
  authorize('owner'),
  ah(async (req, res) => {
    const { username, tempPassword, fullName, email, role, branchId, linkedTeacherId, linkedEmployeeId, linkedPartnerId, linkedStudentId } = req.body;
    
    if (!username || !tempPassword || !fullName || !role || !branchId) {
      throw new HttpError(400, 'Username, temporary password, full name, role, and branch are required.');
    }
    
    if (!ALLOWED_ROLES.includes(role)) {
      throw new HttpError(400, 'Invalid role specified.');
    }
    // SPA-3 (approved policy): a student's initial password is their NAME, and
    // real names are routinely shorter than the 12-character staff minimum
    // ("Sara Noori" is 10). Applying the staff rule to portal accounts would
    // make the approved policy unimplementable. Staff keep the 12-character
    // floor unchanged; student accounts require a non-empty credential.
    const minCredentialLength = role === 'student' ? 1 : 12;
    if (String(tempPassword).length < minCredentialLength) {
      throw new HttpError(
        400,
        role === 'student'
          ? 'A student portal password is required.'
          : 'Temporary password must be at least 12 characters.',
      );
    }
    if (!canAccessBranchResource(req, String(branchId))) throw new HttpError(403, 'Target branch is outside your authorized scope.');

    const exists = stmtCheckUsernameExists.get(username);
    if (exists) throw new HttpError(409, 'This username is already in use.');

    const passwordHash = await hashPassword(tempPassword);

    const campusId = (db.prepare('SELECT campus_id FROM branches WHERE id = ?').get(String(branchId)) as { campus_id?: string | null } | undefined)?.campus_id ?? null;
    if (role === 'student' && linkedStudentId) {
      const st = db.prepare('SELECT id, branch_id FROM students WHERE id = ?').get(String(linkedStudentId)) as { id: string; branch_id: string } | undefined;
      if (!st) throw new HttpError(404, 'Linked student not found.');
      if (String(st.branch_id) !== String(branchId)) throw new HttpError(400, 'Linked student must belong to the same branch.');
      if (db.prepare('SELECT id FROM users WHERE linked_student_id = ?').get(st.id)) throw new HttpError(409, 'This student already has a portal account.');
    }
    const newId = id('usr');
    // SPA-3 (approved policy): a student portal account is issued with the
    // student's NAME as the initial password and is NOT forced to rotate it —
    // rotation stays optional and user-initiated via
    // POST /api/auth/change-password. Staff accounts keep the mandatory
    // first-use rotation.
    //
    // SPA-1 remains in force underneath: the credential is still verified with
    // bcrypt against users.password_hash, so the name is never compared as
    // plaintext and there is still exactly one authentication authority.
    const mustChangePassword = role === 'student' ? 0 : 1;
    const createTx = db.transaction(() => {
      stmtInsertUser.run(newId, username, passwordHash, fullName, email || null, branchId, campusId, linkedTeacherId || null, linkedEmployeeId || null, linkedPartnerId || null, linkedStudentId || null, mustChangePassword);
      assignPrimaryRole(db, newId, role as RoleCode, String(branchId), req.user!.userId);
    });
    createTx();
    
    writeAudit(req, `Created new user account: ${fullName} (${username})`);
    res.status(201).json({ id: newId });
  })
);

usersRouter.patch(
  '/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const target = stmtGetUserById.get(req.params.id) as { id: string; full_name: string; role: RoleCode | null; branch_id: string; is_active: number } | undefined;
    if (!target) throw new HttpError(404, 'User not found.');

    const { fullName, email, role, branchId, isActive } = req.body;
    if (target.id === req.user!.userId && ((role && role !== 'owner') || isActive === false)) throw new HttpError(409, 'You cannot deactivate or demote your own administrative account.');
    
    if (role && !ALLOWED_ROLES.includes(role)) {
      throw new HttpError(400, 'Invalid role specified.');
    }
    if (branchId != null && !canAccessBranchResource(req, String(branchId))) throw new HttpError(403, 'Target branch is outside your authorized scope.');

    const nextRole = (role ?? target.role) as RoleCode | null;
    const nextBranchId = String(branchId ?? target.branch_id);
    if (!canAccessBranchResource(req, nextBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
    const updateTx = db.transaction(() => {
      const result = stmtUpdateUser.run(fullName ?? null, email ?? null, branchId ?? null, typeof isActive === 'boolean' ? (isActive ? 1 : 0) : null, req.params.id);
      if (result.changes !== 1) throw new HttpError(409, 'User update was not applied.');
      // Keep campus_id in sync with the branch.
      if (branchId != null) {
        const campus = (db.prepare('SELECT campus_id FROM branches WHERE id = ?').get(String(branchId)) as { campus_id?: string | null } | undefined)?.campus_id ?? null;
        db.prepare('UPDATE users SET campus_id = ? WHERE id = ?').run(campus, req.params.id);
      }
      if ((role || branchId) && nextRole) assignPrimaryRole(db, req.params.id, nextRole, nextBranchId, req.user!.userId);
      // SPA-1: portal accounts now have a real password flow, so the
      // must_change_password quarantine applies to them exactly as it does to
      // staff. Clearing it here would silently cancel a forced rotation
      // requested via reset-password.
      if (role || branchId || isActive === false) db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(req.params.id);
    });
    updateTx();
    
    writeAudit(req, `Updated user account: ${target.full_name}`);
    res.json({ ok: true });
  })
);

usersRouter.post(
  '/:id/reset-password',
  authorize('owner'),
  ah(async (req, res) => {
    const { tempPassword } = req.body;
    if (!tempPassword || tempPassword.length < 12) {
      throw new HttpError(400, 'Temporary password must be at least 12 characters.');
    }
    
    const target = stmtGetUserById.get(req.params.id) as { id: string; full_name: string } | undefined;
    if (!target) throw new HttpError(404, 'User not found.');
    
    const passwordHash = await hashPassword(tempPassword);
    stmtResetPassword.run(passwordHash, req.params.id);
    
    writeAudit(req, `Reset password for: ${target.full_name}`);
    res.json({ ok: true });
  })
);

export default usersRouter;