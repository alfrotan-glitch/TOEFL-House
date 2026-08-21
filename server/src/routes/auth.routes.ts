import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../db/connection.js';
import { hashPassword, verifyPassword, signToken, verifyToken, resolveJwtExpiresInSeconds } from '../utils/auth.js';
import { authenticate, readSessionCookie } from '../middleware/auth.js';
import {
  buildRbacContext,
  effectivePermissionCodes,
  effectiveTabAccess,
  isGlobalOwner,
  type RbacUserContext,
} from '../core/rbac/rbac-service.js';
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
  skipSuccessfulRequests: true,
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
  skipSuccessfulRequests: true,
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
  skipSuccessfulRequests: true,
  message: { error: 'Too many student sign-in attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetUserByIdSafe = db.prepare('SELECT id, username, full_name, email, branch_id, must_change_password, session_version FROM users WHERE id = ?');
const stmtGetUserByIdFull = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtUpdateLastLogin = db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ? AND password_hash = ? AND session_version = ? AND is_active = 1");
const stmtUpdatePassword = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ? AND session_version = ?");

// Dummy hash to prevent timing attacks during username enumeration
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMy.Mrq8JjCqDwBvVj9oGm6ZvXqJqoYtXa';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  full_name: string;
  email: string | null;
  branch_id: string;
  is_active: number;
  must_change_password: number;
  session_version: number;
}

function buildRequiredRbacContext(row: Pick<UserRow, 'id' | 'username' | 'full_name' | 'branch_id'>): RbacUserContext {
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
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof body.username !== 'string' || !body.username || typeof body.password !== 'string' || !body.password) {
      throw new HttpError(400, 'Username and password are required.');
    }

    const row = stmtGetUserByUsername.get(body.username) as UserRow | undefined;
    const isPasswordValid = row
      ? await verifyPassword(body.password, row.password_hash)
      : await verifyPassword(body.password, DUMMY_HASH);

    if (!row || !isPasswordValid) throw new HttpError(401, 'Invalid username or password.');
    if (!row.is_active) throw new HttpError(403, 'This account has been deactivated. Contact the system administrator.');

    // Resolve authorization before issuing a session or recording a successful
    // login. An identity without a live primary assignment has no workspace.
    const rbac = buildRequiredRbacContext({
      id: row.id, username: row.username, full_name: row.full_name, branch_id: row.branch_id,
    });
    if (!rbac.primaryRole) throw new HttpError(403, 'This account has no active primary position.');

    // Password verification is asynchronous. A reset/deactivation can occur
    // while bcrypt runs; this conditional write detects that race so the route
    // never returns a successful session that is already revoked.
    if (stmtUpdateLastLogin.run(row.id, row.password_hash, row.session_version).changes !== 1) {
      throw new HttpError(401, 'Account state changed during sign-in. Please try again.');
    }

    const token = signToken({
      userId: row.id,
      username: row.username,
      branchId: row.branch_id,
      fullName: row.full_name,
      sessionVersion: row.session_version,
    });
    setSessionCookie(res, token);

    req.user = { userId: row.id, username: row.username, branchId: row.branch_id, fullName: row.full_name, sessionVersion: row.session_version };
    req.rbac = rbac;
    writeAudit(req, 'User logged in');

    res.json({
      ...(process.env.NODE_ENV === 'production' ? {} : { token }),
      user: {
        id: row.id, username: row.username, fullName: row.full_name, email: row.email,
        role: rbac.primaryRole, branchId: row.branch_id, mustChangePassword: !!row.must_change_password,
        isGlobalOwner: isGlobalOwner(rbac),
        permissions: effectivePermissionCodes(rbac),
        roles: rbac.roles,
        tabAccess: effectiveTabAccess(rbac),
      },
    });
  })
);

authRouter.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    const row = stmtGetUserByIdSafe.get(req.user!.userId) as
      | { id: string; username: string; full_name: string; email: string | null; branch_id: string; must_change_password: number }
      | undefined;
      
    if (!row) throw new HttpError(404, 'User not found.');
    
    const rbac = req.rbac || buildRequiredRbacContext({
      id: row.id, username: row.username, full_name: row.full_name, branch_id: row.branch_id,
    });
    
    res.json({
      id: row.id, username: row.username, fullName: row.full_name, email: row.email,
      role: rbac.primaryRole, branchId: row.branch_id, mustChangePassword: !!row.must_change_password,
      isGlobalOwner: isGlobalOwner(rbac),
      permissions: effectivePermissionCodes(rbac),
      roles: rbac.roles,
      tabAccess: effectiveTabAccess(rbac),
    });
  })
);

/**
 * Student self-service login: student code + PORTAL SECRET.
 *
 * SPA-1 — this endpoint requires a portal secret. Accepting
 * `studentCode + fullName` and auto-provisioning on first contact would
 * authenticate nobody: neither factor is a secret.
 * `student_code` is issued from a sequential counter (utils/receipt.ts,
 * `student_code_counter`, base 1000) and a student's full name is public to
 * classmates and staff, so knowing a classmate's name was enough to walk the
 * low-entropy code space and take over their portal session.
 *
 * `student_code` is now an IDENTIFIER only. Authentication is delegated to the
 * same canonical primitive staff logins use — `verifyPassword` against
 * `users.password_hash` — including the constant-time dummy-hash comparison on
 * the miss path so a wrong secret and an unknown/unprovisioned code are
 * indistinguishable to the caller. No second authentication authority is
 * introduced.
 *
 * Onboarding and rotation reuse the existing owner-only authorities
 * (`POST /api/users` with role 'student' + linkedStudentId, and
 * `POST /api/users/:id/reset-password`, which bumps session_version in the
 * same statement). Self-service rotation reuses `POST /api/auth/change-password`.
 * Because a portal account is now credentialed, it is no longer created
 * implicitly here: a student without an account cannot log in, and no account
 * is silently minted by an anonymous request.
 *
 * The issued token still carries role 'student', which holds no permission
 * anywhere; the portal remains object-checked against linked_student_id.
 */
authRouter.post(
  '/student-login',
  studentLoginLimiter,
  ah(async (req, res) => {
    const { studentCode, password } = req.body ?? {};
    // A credential must be a STRING, never coerced. `String(['secret'])`
    // yields 'secret', so accepting an array would let `password: ["s3cret"]`
    // authenticate — caught in adversarial testing of this very handler.
    if (typeof studentCode !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'Student code and password are required.');
    }
    const code = studentCode.trim();
    const secret = password;
    if (!code || !secret) throw new HttpError(400, 'Student code and password are required.');

    const student = db.prepare(`SELECT * FROM students WHERE LOWER(TRIM(student_code)) = LOWER(TRIM(?))`).get(code) as
      | { id: string; student_code: string; full_name: string; branch_id: string; status: string } | undefined;

    // A portal login is admitted only through a live PRIMARY student
    // assignment. A secondary student label on a staff account must never turn
    // the low-strength portal credential into an administrative session.
    const user = student
      ? (db.prepare(`SELECT u.* FROM users u
             JOIN user_roles ur ON ur.user_id = u.id AND ur.is_primary = 1
               AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
             JOIN roles r ON r.id = ur.role_id AND r.code = 'student' AND r.is_active = 1
            WHERE u.linked_student_id = ?`).get(student.id) as UserRow | undefined)
      : undefined;

    const passwordMatches = user
      ? await verifyPassword(secret, user.password_hash)
      : await verifyPassword(secret, DUMMY_HASH);

    // One indistinguishable answer for: unknown code, no portal account,
    // wrong secret. Enumerating student codes must not be possible here.
    if (!student || !user || !passwordMatches) throw new HttpError(401, 'Invalid student code or password.');
    if (!user.is_active) throw new HttpError(403, 'This portal account has been deactivated. Contact the office.');
    if (student.status === 'suspended' || student.status === 'inactive') {
      throw new HttpError(403, 'This student account is not active. Contact the office.');
    }
    if (user.branch_id !== student.branch_id) throw new HttpError(403, 'This portal account is not linked to the student branch.');

    const rbac = buildRequiredRbacContext({
      id: user.id, username: user.username, full_name: user.full_name, branch_id: user.branch_id,
    });
    if (rbac.primaryRole !== 'student' || rbac.roles.some((role) => role.roleCode !== 'student') || effectivePermissionCodes(rbac).length > 0) {
      throw new HttpError(403, 'This account is not eligible for the student portal.');
    }
    if (stmtUpdateLastLogin.run(user.id, user.password_hash, user.session_version).changes !== 1) {
      throw new HttpError(401, 'Account state changed during sign-in. Please try again.');
    }

    const token = signToken({
      userId: user.id, username: user.username, branchId: user.branch_id,
      fullName: user.full_name, sessionVersion: user.session_version,
    });
    setSessionCookie(res, token);

    req.user = {
      userId: user.id, username: user.username,
      branchId: user.branch_id, fullName: user.full_name, sessionVersion: user.session_version,
    };
    req.rbac = rbac;
    writeAudit(req, 'Student portal login', { branchId: user.branch_id });

    res.json({
      ...(process.env.NODE_ENV === 'production' ? {} : { token }),
      user: {
        id: user.id, username: user.username, fullName: user.full_name, email: user.email,
        role: rbac.primaryRole, branchId: user.branch_id,
        mustChangePassword: !!user.must_change_password,
        isGlobalOwner: isGlobalOwner(rbac),
        permissions: effectivePermissionCodes(rbac),
        roles: rbac.roles,
        tabAccess: effectiveTabAccess(rbac),
      },
    });
  })
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    // Revoke the session server-side: bumping session_version invalidates every
    // JWT issued to this user before it (authenticate() compares versions),
    // so a captured token cannot outlive an explicit logout.
    const header = req.headers.authorization;
    const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const cookieToken = readSessionCookie(req);
    const token = cookieToken || bearerToken;
    if (token) {
      try {
        const decoded = verifyToken(token);
        if (decoded?.userId && decoded.sessionVersion) {
          // A stale token may clear its own cookie, but it cannot keep revoking
          // sessions established after that token was superseded.
          db.prepare(`UPDATE users
                         SET session_version = session_version + 1
                       WHERE id = ? AND session_version = ?`)
            .run(decoded.userId, decoded.sessionVersion);
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
    const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
      throw new HttpError(400, 'Current password is required.');
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 12) {
      throw new HttpError(400, 'New password must be at least 12 characters.');
    }

    const row = stmtGetUserByIdFull.get(req.user!.userId) as UserRow | undefined;
    if (!row) throw new HttpError(404, 'User not found.');
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw new HttpError(401, 'Current password is incorrect.');
    }
    const newHash = await hashPassword(body.newPassword);
    const changed = stmtUpdatePassword.run(newHash, row.id, row.session_version);
    if (changed.changes !== 1) throw new HttpError(409, 'Password changed concurrently. Please sign in again.');
    const nextSessionVersion = row.session_version + 1;
    const renewedToken = signToken({
      userId: row.id, username: row.username, branchId: row.branch_id,
      fullName: row.full_name, sessionVersion: nextSessionVersion,
    });
    setSessionCookie(res, renewedToken);

    writeAudit(req, 'Changed personal password');
    res.json({ ok: true });
  })
);

export default authRouter;