import type { AppRole } from '../types/navigation';

/**
 * Maps internal role keys (including legacy aliases) to human-readable labels.
 * This acts as the translation layer for displaying roles in the UI.
 */
export const ROLE_LABELS: Record<string, string> = {
  // Modern RBAC Roles
  owner: 'Owner',
  manager: 'General Manager',
  finance: 'Finance Manager',
  registrar: 'Receptionist',
  teacher: 'Teacher',
  head_of_department: 'Head of Department',
  counselor: 'Counselor',
  donor_manager: 'Donor Manager',
  student: 'Student',
  
  // Legacy Role Aliases (for backward compatibility with older database records)
  general_manager: 'General Manager',
  finance_manager: 'Finance Manager',
  receptionist: 'Receptionist',
  data_entry: 'Data Entry',
};

/**
 * The canonical list of active application roles recognized by the system.
 */
export const ALL_ROLES: AppRole[] = [
  'owner',
  'manager',
  'finance',
  'registrar',
  'teacher',
  'head_of_department',
  'counselor',
  'donor_manager',
];

/**
 * Safely retrieves the display label for a given role.
 * Falls back to a title-cased version of the role string if the role is not found in the map.
 * 
 * @param role - The role key (e.g., 'finance_manager')
 * @returns The human-readable label (e.g., 'Finance Manager')
 */
export function getRoleLabel(role: string): string {
  if (ROLE_LABELS[role]) {
    return ROLE_LABELS[role];
  }
  // Fallback: convert 'some_unknown_role' to 'Some Unknown Role'
  return role
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}