import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../db/connection.js';
import { hashPassword, verifyPassword, signToken, verifyToken, resolveJwtExpiresInSeconds } from '../utils/auth.js';
import { id } from '../utils/ids.js';
import { syncPrimaryUserRole } from '../core/rbac/rbac-service.js';
import { authenticate, readSessionCookie } from '../middleware/auth.js';
import { hasRole } from '../core/rbac/rbac-service.js';
import { buildRbacContext, type RbacUserContext } from '../core/rbac/rbac-service.js';
import { TAB_PERMISSION_MAP } from '../core/rbac/permission-catalog.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';

export const authRouter = Router();

const SESSION_COOKIE = 'erp_session';
function setSessionCookie(res: import('express').Response, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${resolveJwtExpiresInSeconds()}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}
function clearSessionCookie(res: import('express').Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

/**
 * Login rate limiting — two layers, deliberately.
 *
 * The previous single limiter was keyed on IP alone at 10 attempts / 15 min.
 * Every member of staff at a branch shares one NAT egress IP, so ten wrong
 * passwords from one person locked out the ENTIRE office for fifteen minutes.
 * Observed live during the 2026-08-16 audit: four unrelated accounts were
 * locked out by one probe. That is a trivial internal denial of service and a
 * standing support burden.
 *
 * Layer 1 (per account+IP) is the credential-stuffing guard: it bounds guesses
 * against any ONE username without punishing colleagues behind the same IP.
 * Layer 2 (per IP, much wider) still bounds a distributed sweep that rotates
 * usernames from a single source.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Normalised username for keying; falsy/oversized input collapses to a constant. */
function usernameKeyPart(req: import('express').Request): string {
  const raw = (req.body as { username?: unknown } | undefined)?.username;
  if (typeof raw !== 'string') return '_';
  const trimmed = raw.trim().toLowerCase();
  // Bound the key so a hostile client cannot grow the limiter's memory with
  // unique multi-kilobyte usernames.
  return trimmed ? trimmed.slice(0, 64) : '_';
}

const loginLimiter = rateLimit({
  windowMs: ATTEMPT_WINDOW_MS,
  max: 10,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${usernameKeyPart(req)}`,
  message: { error: 'Too many login attempts for this account. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Whole-IP ceiling. Sized so a full branch (reception, registrars, finance,
 * teachers) can legitimately sign in and mistype during one window, while a
 * scripted sweep across many usernames from one host is still stopped.
 */
const loginIpLimiter = rateLimit({
  windowMs: ATTEMPT_WINDOW_MS,
  max: 100,
  message: { error: 'Too many login attempts from this network. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Student portal logins share the office network IP with many students, so a
 * tight per-IP limit would lock out the whole reception. Separate limiter:
 * 60 attempts / 15 minutes still bounds brute-force while allowing a class of
 * students to sign in during one session.
 */
const studentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many student sign-in attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetUserByIdSafe = db.prepare('SELECT id, username, full_name, email, role, branch_id, must_change_password, session_version FROM users WHERE id = ?');
const stmtGetUserByIdFull = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtUpdateLastLogin = db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?");
const stmtUpdatePassword = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?");

// Dummy hash to prevent timing attacks during username enumeration
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMy.Mrq8JjCqDwBvVj9oGm6ZvXqJqoYtXa';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  full_name: string;
  email: string | null;
  role: 'owner' | 'manager' | 'finance' | 'registrar' | 'teacher' | 'head_of_department' | 'counselor' | 'donor_manager';
  branch_id: string;
  is_active: number;
  must_change_password: number;
  session_version: number;
}

function buildRequiredRbacContext(row: Pick<UserRow, 'id' | 'username' | 'full_name' | 'role' | 'branch_id'>): RbacUserContext {
  try {
    return buildRbacContext(db, row);
  } catch {
    throw new HttpError(503, 'Authorization service is unavailable. Please try again later.');
  }
}

authRouter.post(
  '/login',
  loginIpLimiter,
  loginLimiter,
  ah(async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      throw new HttpError(400, 'Username and password are required.');
    }

    const row = stmtGetUserByUsername.get(username) as UserRow | undefined;
    const isPasswordValid = row 
      ? await verifyPassword(password, row.password_hash) 
      : await verifyPassword(password, DUMMY_HASH);

    if (!row || !isPasswordValid) {
      throw new HttpError(401, 'Invalid username or password.');
    }

    if (!row.is_active) {
      throw new HttpError(403, 'This account has been deactivated. Contact the system administrator.');
    }

    const token = signToken({
      userId: row.id,
      username: row.username,
      role: row.role,
      branchId: row.branch_id,
      fullName: row.full_name,
      sessionVersion: row.session_version,
    });

    stmtUpdateLastLogin.run(row.id);
    setSessionCookie(res, token);

    req.user = { userId: row.id, username: row.username, role: row.role, branchId: row.branch_id, fullName: row.full_name, sessionVersion: row.session_version };
    writeAudit(req, 'User logged in');

    const rbac = buildRequiredRbacContext({
      id: row.id, username: row.username, full_name: row.full_name, role: row.role, branch_id: row.branch_id,
    });
    
    const tabAccess: Record<string, boolean> = {};
    for (const [tab, perm] of Object.entries(TAB_PERMISSION_MAP)) {
      tabAccess[tab] = rbac.permissionCodes.has(perm) || hasRole(rbac, 'owner');
    }
    
    res.json({
      ...(process.env.NODE_ENV === 'production' ? {} : { token }),
      user: {
        id: row.id, username: row.username, fullName: row.full_name, email: row.email,
        role: row.role, branchId: row.branch_id, mustChangePassword: !!row.must_change_password,
        permissions: Array.from(rbac.permissionCodes), 
        roles: rbac.roles, 
        tabAccess,
      },
    });
  })
);

authRouter.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    const row = stmtGetUserByIdSafe.get(req.user!.userId) as
      | { id: string; username: string; full_name: string; email: string | null; role: string; branch_id: string; must_change_password: number }
      | undefined;
      
    if (!row) throw new HttpError(404, 'User not found.');
    
    const rbac = req.rbac || buildRequiredRbacContext({
      id: row.id, username: row.username, full_name: row.full_name, role: row.role as UserRow['role'], branch_id: row.branch_id,
    });
    
    const tabAccess: Record<string, boolean> = {};
    for (const [tab, perm] of Object.entries(TAB_PERMISSION_MAP)) {
      tabAccess[tab] = rbac.permissionCodes.has(perm) || hasRole(rbac, 'owner');
    }
    
    res.json({
      id: row.id, username: row.username, fullName: row.full_name, email: row.email,
      role: row.role, branchId: row.branch_id, mustChangePassword: !!row.must_change_password,
      permissions: Array.from(rbac.permissionCodes), 
      roles: rbac.roles, 
      tabAccess,
    });
  })
);

/**
 * Student self-service login: student code + full name only.
 * The account is auto-provisioned on first login, tied to the student's
 * branch + campus, and the token carries role 'student' — which grants no
 * administrative permission anywhere. The student can only reach the
 * read-only portal endpoints (object-checked against linked_student_id).
 */
authRouter.post(
  '/student-login',
  studentLoginLimiter,
  ah(async (req, res) => {
    const { studentCode, fullName } = req.body ?? {};
    if (!studentCode || !fullName) throw new HttpError(400, 'Student code and full name are required.');
    const code = String(studentCode).trim();
    const name = String(fullName).trim();
    if (!code || !name) throw new HttpError(400, 'Student code and full name are required.');

    const student = db.prepare(`SELECT * FROM students WHERE LOWER(TRIM(student_code)) = LOWER(TRIM(?))`).get(code) as
      | { id: string; student_code: string; full_name: string; branch_id: string; status: string } | undefined;
    if (!student) throw new HttpError(404, 'No student found with this code.');
    if (student.status === 'suspended' || student.status === 'inactive') {
      throw new HttpError(403, 'This student account is not active. Contact the office.');
    }
    if (String(student.full_name).trim().toLowerCase() !== name.toLowerCase()) {
      throw new HttpError(401, 'The name does not match this student code.');
    }

    // Reuse an existing portal account if one exists; otherwise auto-provision.
    let user = db.prepare('SELECT * FROM users WHERE linked_student_id = ?').get(student.id) as
      | { id: string; username: string; full_name: string; role: string; branch_id: string; session_version: number; must_change_password: number } | undefined;
    if (!user) {
      const newId = id('usr');
      const baseUsername = `stu_${code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
      let username = baseUsername;
      let suffix = 1;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        username = `${baseUsername}_${suffix}`;
        suffix += 1;
      }
      // No password: the portal authenticates by code + name. The hash is a
      // random opaque value so the row satisfies NOT NULL and can never be
      // used for a password login.
      const randomHash = await hashPassword(`student-portal-${newId}-${Date.now()}`);
      const campus = (db.prepare('SELECT b.campus_id FROM branches b WHERE b.id = ?').get(student.branch_id) as { campus_id?: string | null } | undefined)?.campus_id ?? null;
      db.transaction(() => {
        db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, branch_id, campus_id, linked_student_id, is_active, must_change_password, session_version)
          VALUES (?, ?, ?, ?, 'student', ?, ?, ?, 1, 0, 1)`).run(newId, username, randomHash, student.full_name, student.branch_id, campus, student.id);
        syncPrimaryUserRole(db, newId, 'student', student.branch_id, 'system');
      })();
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId) as typeof user;
      // Account auto-provisioning is an identity/security mutation: record it
      // with the student as the operator (portal principals hold no staff
      // position, so operator_role is 'student').
      req.user = { userId: user!.id, username: user!.username, role: 'student' as UserRow['role'], branchId: user!.branch_id, fullName: user!.full_name, sessionVersion: 1 };
      writeAudit(req, `Auto-provisioned student portal account for ${student.full_name} (${code})`, { newValue: JSON.stringify({ userId: user!.id, studentId: student.id, branchId: student.branch_id }) });
    }

    const token = signToken({
      userId: user!.id, username: user!.username, role: 'student', branchId: user!.branch_id,
      fullName: user!.full_name, sessionVersion: user!.session_version,
    });
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user!.id);
    setSessionCookie(res, token);

    res.json({
      ...(process.env.NODE_ENV === 'production' ? {} : { token }),
      user: {
        id: user!.id, username: user!.username, fullName: user!.full_name, email: null,
        role: 'student', branchId: user!.branch_id, mustChangePassword: false,
        permissions: [], roles: [{ roleId: 'student', roleCode: 'student', roleName: 'Student', scopeType: 'branch', scopeId: user!.branch_id }],
        tabAccess: {},
      },
    });
  })
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    // Revoke the session server-side: bumping session_version invalidates every
    // previously issued JWT for this user (authenticate() compares versions),
    // so a captured token cannot outlive an explicit logout.
    const header = req.headers.authorization;
    const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const cookieToken = readSessionCookie(req);
    const token = cookieToken || bearerToken;
    if (token) {
      try {
        const decoded = verifyToken(token);
        if (decoded?.userId) {
          db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(decoded.userId);
        }
      } catch {
        // Unverifiable/expired token: nothing to revoke.
      }
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

authRouter.post(
  '/change-password',
  authenticate,
  ah(async (req, res) => {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 12) {
      throw new HttpError(400, 'New password must be at least 12 characters.');
    }

    const row = stmtGetUserByIdFull.get(req.user!.userId) as UserRow | undefined;
    if (!row) throw new HttpError(404, 'User not found.');
    if (!currentPassword || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw new HttpError(401, 'Current password is incorrect.');
    }
    const newHash = await hashPassword(newPassword);
    stmtUpdatePassword.run(newHash, row.id);
    const nextSessionVersion = row.session_version + 1;
    const renewedToken = signToken({
      userId: row.id, username: row.username, role: row.role, branchId: row.branch_id,
      fullName: row.full_name, sessionVersion: nextSessionVersion,
    });
    setSessionCookie(res, renewedToken);

    writeAudit(req, 'Changed personal password');
    res.json({ ok: true });
  })
);

export default authRouter;