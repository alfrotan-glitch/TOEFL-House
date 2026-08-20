import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim() ?? '';
  if (!secret) throw new Error('JWT_SECRET is not configured.');
  return secret;
}

export function resolveJwtExpiresInSeconds(): number {
  const raw = (process.env.JWT_EXPIRES_IN || '12h').trim().toLowerCase();
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(raw);
  if (!match) return 12 * 60 * 60;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return 12 * 60 * 60;
  const multiplier = match[2] === 'd' ? 86400 : match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1;
  return value * multiplier;
}

const INSECURE_JWT_SECRETS = new Set([
  'dev-only-secret-change-me',
  'change-this-to-a-long-random-secret-in-production',
  'secret',
  'jwt-secret',
]);

export function assertJwtSecretConfigured(): void {
  const secret = process.env.JWT_SECRET?.trim() ?? '';
  if (!secret || secret.length < 32 || INSECURE_JWT_SECRETS.has(secret)) {
    throw new Error('FATAL: JWT_SECRET must be a unique value of at least 32 characters.');
  }
}


/**
 * The values `users.role` may hold. This mirrors the CHECK constraint on that
 * column exactly — 'staff' and 'partner' used to appear here and in the token
 * allow-list, but the database has never accepted either, so they were values
 * no user could actually have.
 *
 * This is a profile attribute, not an authorization input: what a principal
 * may do comes from `user_roles`. See docs/registries/canonical-authority.md.
 */
export type UserRole =
  | 'owner' | 'manager' | 'finance' | 'registrar'
  | 'teacher' | 'head_of_department' | 'counselor'
  | 'donor_manager' | 'student';

/** Every role signToken may emit — single source of truth for the
 *  role allow-list in isTokenPayload (drift here would silently break
 *  authentication for that role at runtime). */
export const KNOWN_USER_ROLES: readonly UserRole[] = [
  'owner', 'manager', 'finance', 'registrar', 'teacher',
  'head_of_department', 'counselor', 'donor_manager', 'student',
];

export interface TokenPayload {
  userId: string;
  username: string;
  role: UserRole;
  branchId: string;
  fullName: string;
  sessionVersion?: number;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: TokenPayload): string {
  const normalized = { ...payload, sessionVersion: payload.sessionVersion ?? 1 };
  const options: SignOptions = { expiresIn: resolveJwtExpiresInSeconds() };
  return jwt.sign(normalized, getJwtSecret(), options);
}

function isTokenPayload(value: unknown): value is TokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.userId === 'string' &&
    typeof payload.username === 'string' &&
    typeof payload.branchId === 'string' &&
    typeof payload.fullName === 'string' &&
    typeof payload.sessionVersion === 'number' && Number.isInteger(payload.sessionVersion) && payload.sessionVersion >= 1 &&
    typeof payload.role === 'string' &&
    (KNOWN_USER_ROLES as readonly string[]).includes(payload.role);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, getJwtSecret());
    return isTokenPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}
