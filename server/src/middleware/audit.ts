import type { Request } from 'express';
import { db } from '../db/connection.js';
import { id, today, nowTimeFa } from '../utils/ids.js';
import { canAccessBranchResource } from './auth.js';
import { createLogger } from '../core/observability/logger.js';
const log = createLogger('audit');

/**
 * Defines the expected shape of the authenticated user object on the request.
 * This prevents runtime errors when accessing user properties.
 */
interface AuditUser {
  userId?: string;
  fullName?: string;
  branchId?: string;
  role?: string;
}

/**
 * Performance Optimization: Prepare the SQL statement ONCE at module load.
 * better-sqlite3 handles concurrent writes safely, and preparing it once
 * eliminates parsing overhead on every single audit log entry.
 */
const insertAuditFailureStmt = db.prepare(`INSERT INTO audit_failures (id, request_id, operator_id, branch_id, action, error, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`);

const insertAuditStmt = db.prepare(
  `INSERT INTO audit_logs (
    id, operator_id, operator_name, operator_role, action, date, time, 
    old_value, new_value, ip, device, branch_id
  ) VALUES (
    @id, @operator_id, @operator_name, @operator_role, @action, @date, @time, 
    @old_value, @new_value, @ip, @device, @branch_id
  )`
);

/**
 * Writes an audit log entry. Mirrors the behaviour of the original frontend's logAudit(),
 * but now derives the operator identity from the verified JWT instead of a client-side dropdown,
 * and derives the IP address from the real request instead of a random fake value.
 *
 * Resilience: If the database insert fails, the error is logged to the console
 * but does NOT crash the main Express request flow.
 */
/**
 * The branch a request is acting ON, when it differs from the operator's own.
 *
 * Owners and managers work across branches: the branch they are creating a
 * student, book, or teacher in arrives in the request body (or as an explicit
 * ?branchId query), while their JWT still carries their home branch. Falling
 * straight back to `user.branchId` filed those events under the wrong branch —
 * a student created in West Branch produced an audit row stamped with the
 * operator's Main Branch, and West Branch's audit view returned nothing at all.
 *
 * Only a branch the caller is actually authorized for is honoured, so this
 * cannot be used to forge attribution: an unauthorized value is ignored and the
 * operator's own branch is recorded instead.
 */
function requestTargetBranchId(req: Request): string | null {
  const body = req.body as { branchId?: unknown } | undefined;
  const raw = typeof body?.branchId === 'string' ? body.branchId
    : typeof req.query?.branchId === 'string' ? req.query.branchId
    : null;
  if (!raw || raw === 'all') return null;
  try {
    return canAccessBranchResource(req, raw) ? raw : null;
  } catch {
    // Attribution must never break the write that is being audited.
    return null;
  }
}

export function writeAudit(
  req: Request,
  action: string,
  opts?: { oldValue?: string; newValue?: string; branchId?: string }
): void {
  // Safely cast req.user to our expected interface
  const user = (req.user || {}) as AuditUser;

  // Express resolves req.ip according to the explicitly configured trusted-proxy boundary.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  const params = {
    id: id('log'),
    operator_id: user.userId || null,
    operator_name: user.fullName || 'System',
    operator_role: req.rbac?.primaryRole ?? null,
    action: action,
    date: today(),
    time: nowTimeFa(),
    old_value: opts?.oldValue || null,
    new_value: opts?.newValue || null,
    ip: ip,
    device: req.headers['user-agent'] || 'unknown',
    branch_id: opts?.branchId || requestTargetBranchId(req) || user.branchId || null,
  };

  try {
    insertAuditStmt.run(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('❌ Failed to write audit log:', message);
    // Never lose the forensic signal silently. Capture the failure in a durable
    // side-channel so operations can reconcile the missing audit record.
    try {
      insertAuditFailureStmt.run(
        id('auditfail'),
        req.get('X-Request-Id') || null,
        params.operator_id,
        params.branch_id,
        params.action,
        message,
        JSON.stringify({ oldValue: params.old_value, newValue: params.new_value, path: req.originalUrl })
      );
    } catch (fallbackError) {
      log.error('❌ CRITICAL: audit failure could not be persisted:', fallbackError);
    }
  }
}