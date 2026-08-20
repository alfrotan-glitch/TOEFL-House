import { USER_ROLE_CODES, type UserRole } from '../types';

/**
 * Human-readable label for every canonical role code.
 *
 * Typed `Record<UserRole, string>` on purpose: the compiler rejects a key that
 * is not a role and requires an entry for each one, so this map cannot drift
 * away from the vocabulary the server enforces.
 */
export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Owner',
  general_manager: 'General Manager',
  finance_manager: 'Finance Manager',
  receptionist: 'Receptionist',
  teacher: 'Teacher',
  head_of_department: 'Head of Department',
  data_entry: 'Data Entry',
  student: 'Student',
  counselor: 'Counselor',
  donor_manager: 'Donor Manager',
};

/**
 * Roles the "Add user" form offers, and why the rest are not offered.
 *
 * This is a presentation list, never an authorization decision — the server
 * re-validates the submitted role against its own allow-list before assigning
 * anything.
 *
 *   owner       — the organization superuser is provisioned at bootstrap, not
 *                 handed out from a form.
 *   data_entry  — defined in the permission catalog but not offered as an
 *                 account type, matching the server's `ALLOWED_ROLES`.
 *   student     — a portal account must be linked to a student record
 *                 (`linkedStudentId`), which this form does not collect.
 *
 * Derived by exclusion from `USER_ROLE_CODES` rather than retyped, so adding a
 * role to the vocabulary surfaces it here instead of silently omitting it.
 */
const NOT_OFFERED_AS_ACCOUNT_TYPE: ReadonlySet<UserRole> = new Set<UserRole>([
  'owner',
  'data_entry',
  'student',
]);

export const ASSIGNABLE_ROLES: UserRole[] = USER_ROLE_CODES.filter(
  (role) => !NOT_OFFERED_AS_ACCOUNT_TYPE.has(role),
);

/**
 * Display label for a role code.
 *
 * Accepts `string` because the caller's value often arrives from the API as an
 * untyped field. An unrecognized code is title-cased rather than dropped, so an
 * unexpected value stays visible to the operator instead of rendering blank.
 */
export function getRoleLabel(role: string): string {
  if (role in ROLE_LABELS) {
    return ROLE_LABELS[role as UserRole];
  }
  return role
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
