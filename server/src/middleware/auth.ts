import type { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../utils/auth.js';
import { db } from '../db/connection.js';
import {
  buildRbacContext, hasAnyPermission, hasRole, isGlobalOwner,
  canAccessBranchForRequirement, canAccessAllBranchesForRequirement,
  type BranchAccessRequirement, type RbacUserContext,
} from '../core/rbac/rbac-service.js';
import type { RoleCode } from '../core/rbac/permission-catalog.js';
import { HttpError } from './errorHandler.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
      rbac?: RbacUserContext;
      branchAccessRequirement?: BranchAccessRequirement;
    }
  }
}

// ── Performance Optimization ───────────────────────────────────────────────
const getActiveUserStmt = db.prepare(
  'SELECT id, username, full_name, branch_id, session_version, must_change_password FROM users WHERE id = ? AND is_active = 1'
);

// While a user's password is flagged as must-change (first install, forced
// reset), the account is quarantined: only these endpoints are reachable.
// The rest of the API responds 403 until the password is changed. This is
// server-side enforcement of the change-password gate the frontend renders —
// the initial owner credential must never be usable against the full API.
const MUST_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/me',
]);

function isAllowedDuringPasswordQuarantine(req: Request): boolean {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return MUST_CHANGE_ALLOWED_PATHS.has(path);
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName !== 'erp_session') continue;
    const value = rest.join('=');
    try { return decodeURIComponent(value); } catch { return null; }
  }
  return null;
}

/**
 * Authentication Middleware.
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const cookieToken = readSessionCookie(req);
  const allowBearer = process.env.NODE_ENV !== 'production' || process.env.ALLOW_BEARER_AUTH === 'true';
  if (bearerToken && !allowBearer) {
    return res.status(401).json({ error: 'Bearer authentication is disabled in production. Use the secure session cookie.' });
  }
  const token = cookieToken || bearerToken;
  if (!token) {
    return res.status(401).json({ error: 'Authentication session not found. Please log in again.' });
  }
  
  try {
    const decodedToken = verifyToken(token);
    if (!decodedToken) {
      return res.status(401).json({ error: 'Your session has expired or is invalid. Please log in again.' });
    }

    const row = getActiveUserStmt.get(decodedToken.userId) as
      | { id: string; username: string; full_name: string; branch_id: string; session_version: number; must_change_password: number }
      | undefined;

    if (!row) {
      return res.status(401).json({ error: 'User account is inactive or no longer exists.' });
    }
    if (decodedToken.sessionVersion !== row.session_version) {
      return res.status(401).json({ error: 'Your session has been revoked. Please sign in again.' });
    }

    // Password-change quarantine (see MUST_CHANGE_ALLOWED_PATHS above).
    if (row.must_change_password === 1 && !isAllowedDuringPasswordQuarantine(req)) {
      return res.status(403).json({ error: 'You must change your password before continuing.' });
    }

    req.user = {
      ...decodedToken,
      userId: row.id,
      username: row.username,
      fullName: row.full_name,
      branchId: row.branch_id,
      sessionVersion: row.session_version,
    };

    try {
      req.rbac = buildRbacContext(db, row);
    } catch {
      return res.status(503).json({ error: 'Authorization service is unavailable. Please try again later.' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed. Please log in again.' });
  }
}

/**
 * Role-based authorization middleware.
 *
 * Roles are named by their canonical code — the same value stored in
 * `roles.code` and referenced by `user_roles`. There is no second role
 * vocabulary and no translation step: a name that does not exist in the
 * catalog matches nothing and therefore denies.
 */
export function requestHasRole(req: Request, role: RoleCode): boolean {
  if (!req.rbac) return false;
  return hasRole(req.rbac, role);
}

export function requestHasAnyRole(req: Request, roles: RoleCode[]): boolean {
  return roles.some((role) => requestHasRole(req, role));
}

function addBranchAccessRequirement(req: Request, requirement: BranchAccessRequirement): void {
  req.branchAccessRequirement = {
    roleCodes: Array.from(new Set([...(req.branchAccessRequirement?.roleCodes ?? []), ...(requirement.roleCodes ?? [])])),
    permissionCodes: Array.from(new Set([...(req.branchAccessRequirement?.permissionCodes ?? []), ...(requirement.permissionCodes ?? [])])),
  };
}

export function authorize(...roles: RoleCode[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    // The Course Owner is the application superuser. The permission catalog
    // documents that middleware bypasses the Owner ("Middleware currently
    // bypasses Owner completely"), the frontend workspace configuration
    // exposes every role workspace to the owner, and handler-level checks
    // (e.g. assertCanMarkSession) explicitly allow the owner. Role-gated
    // route lists therefore implicitly include the owner; business-rule gates
    // (grade locks, rescore guards, cancellation reasons, etc.) still apply
    // independently of this role check.
    addBranchAccessRequirement(req, { roleCodes: roles });
    if (req.rbac && isGlobalOwner(req.rbac)) return next();
    if (requestHasAnyRole(req, roles)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this operation.' });
  };
}

/**
 * Organization-global configuration is stricter than an `owner` role-name
 * check. A campus- or branch-scoped owner is intentionally not the application
 * superuser (D-60), so global hierarchy, equity and policy routes use this
 * guard after `authenticate` rather than silently widening a scoped grant.
 */
export function requireGlobalOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  if (req.rbac && isGlobalOwner(req.rbac)) return next();
  return res.status(403).json({ error: 'Only an organization-scoped owner may perform this operation.' });
}

/**
 * Strict Permission-based authorization middleware.
 */
export function requirePermission(...codes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    // The Course Owner is the application superuser with equivalent unrestricted
    // access (Owner model): role-gated routes grant the owner through authorize();
    // permission-gated routes must not exclude the owner merely because the
    // catalog omits a code for audit documentation purposes.
    addBranchAccessRequirement(req, { permissionCodes: codes });
    if (req.rbac && isGlobalOwner(req.rbac)) return next();
    if (req.rbac && hasAnyPermission(req.rbac, codes)) return next();
    return res.status(403).json({
      error: 'You do not have permission to perform this operation.',
      required: codes,
    });
  };
}

/**
 * Denies users whose resolved position grants no permission at all (e.g. the
 * student portal role). Data-driven: any position that carries at least one
 * permission passes; positions with an empty permission set are treated as
 * self-service principals that must never reach branch-wide data.
 */
export function denyPermissionless(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  if (req.rbac && req.rbac.permissionCodes.size > 0) return next();
  return res.status(403).json({ error: 'You do not have permission to perform this operation.' });
}

/** Central request-level branch resource authorization. */
export function canAccessBranchResource(req: Request, branchId: string): boolean {
  if (!req.user) return false;
  const context = req.rbac ?? buildRbacContext(db, {
    id: req.user.userId,
    username: req.user.username,
    full_name: req.user.fullName,
    branch_id: req.user.branchId,
  });
  return canAccessBranchForRequirement(db, context, branchId, req.branchAccessRequirement);
}

interface BranchScopeOptions {
  /** Use the all-branches scope when no branch was requested and RBAC permits it. */
  defaultToAllAuthorized?: boolean;
  /** Aggregators that gate each result category separately resolve only the assignment envelope. */
  ignoreAccessRequirement?: boolean;
}

/** Resolves requested/default branch scope exclusively from live RBAC assignments. */
export function resolveBranchScope(
  req: Request,
  options: BranchScopeOptions = {},
): { branchId: string | null; isAll: boolean } {
  const user = req.user;
  if (!user) return { branchId: null, isAll: false };

  const requested = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
  const context = req.rbac ?? buildRbacContext(db, {
    id: user.userId, username: user.username, full_name: user.fullName, branch_id: user.branchId,
  });
  const accessRequirement = options.ignoreAccessRequirement ? undefined : req.branchAccessRequirement;

  const authorizedHomeScope = (): { branchId: string; isAll: false } => {
    if (!canAccessBranchForRequirement(db, context, user.branchId, accessRequirement)) {
      throw new HttpError(403, 'No authorized branch scope is available for this request.');
    }
    return { branchId: user.branchId, isAll: false };
  };

  if (requested === 'all') {
    return canAccessAllBranchesForRequirement(context, accessRequirement)
      ? { branchId: null, isAll: true }
      : authorizedHomeScope();
  }

  if (requested) {
    return canAccessBranchForRequirement(db, context, requested, accessRequirement)
      ? { branchId: requested, isAll: false }
      : authorizedHomeScope();
  }

  if (options.defaultToAllAuthorized && canAccessAllBranchesForRequirement(context, accessRequirement)) {
    return { branchId: null, isAll: true };
  }

  return authorizedHomeScope();
}
