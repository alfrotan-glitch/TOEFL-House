import type { AppRole, AppTabId } from '../types/navigation';
import { NAVIGATION_SECTIONS } from './navigation';

/**
 * Derives a map of TabId -> AppRole[] directly from the navigation config.
 */
export const TAB_ACCESS: Record<AppTabId, AppRole[]> = (() => {
  const map = {} as Record<AppTabId, AppRole[]>;
  for (const section of NAVIGATION_SECTIONS) {
    for (const item of section.items) {
      if (!map[item.id]) {
        map[item.id] = item.roles;
      }
    }
  }
  return map;
})();

/**
 * Legacy role compatibility helper. Modern tab access comes from the backend `tabAccess` map.
 */
function hasCode(codes: string[] | Set<string> | undefined, code: string): boolean {
  if (!codes) return false;
  if (codes instanceof Set) return codes.has(code);
  if (Array.isArray(codes)) return codes.includes(code);
  return false;
}

/**
 * Core Access Guard.
 * Determines if a user can access a specific tab based on context, permissions, or role.
 */
export function canAccessTab(
  tab: string,
  role: string,
  permissionCodes?: string[] | Set<string>,
  tabAccess?: Record<string, boolean>
): boolean {
  // 1. Highest priority: Explicit tab access map from backend context
  if (tabAccess && tab in tabAccess) {
    return !!tabAccess[tab];
  }

  // 2. Modern RBAC is authoritative whenever the backend supplied a permission set.
  // An empty set is an intentional deny rather than a reason to fall back to UI roles.
  if (permissionCodes !== undefined) {
    return tabAccess ? !!tabAccess[tab] : false;
  }

  // 3. Role metadata is only a compatibility path for pre-RBAC payloads.
  if (role === 'owner') return true;
  const allowedRoles = TAB_ACCESS[tab as AppTabId];
  return allowedRoles ? allowedRoles.includes(role as AppRole) : false;
}

/**
 * Finds the first tab the user is allowed to view.
 * Used for redirecting users away from restricted pages.
 */
export function firstAllowedTab(
  role: string,
  permissionCodes?: string[] | Set<string>,
  tabAccess?: Record<string, boolean>
): AppTabId {
  for (const section of NAVIGATION_SECTIONS) {
    for (const item of section.items) {
      if (canAccessTab(item.id, role, permissionCodes, tabAccess)) {
        return item.id;
      }
    }
  }
  return 'dashboard'; // Absolute fallback
}

/**
 * Generic permission checker for conditional rendering inside components.
 */
export function hasPermission(
  permissionCodes: string[] | Set<string> | undefined,
  code: string,
  role?: string
): boolean {
  if (role === 'owner') return true;
  return hasCode(permissionCodes, code);
}
