import { NAVIGATION_SECTIONS } from './navigation';
import type { AppTabId } from '../types/navigation';

/**
 * Access questions have exactly one answer: the server's.
 *
 * `tabAccess` and `permissions` arrive resolved on the session payload —
 * `/auth/login` and `/auth/me` both compute them through
 * `effectiveTabAccess` / `effectivePermissionCodes`, which already apply the
 * owner bypass. The client's job is to read that answer, not to reconstruct it.
 *
 * These helpers decide what to OFFER. They are not a security boundary: every
 * route re-authorizes server-side, so a wrong answer here is a usability bug,
 * not a hole. That is precisely why it must not be computed a second way — a
 * second computation drifts silently and nobody notices until an operator
 * cannot find a screen.
 */

/**
 * May this tab be shown?
 *
 * An unknown tab, or a session with no resolved access map, answers false.
 * Absence is a denial rather than a reason to guess.
 */
export function canAccessTab(tab: string, tabAccess?: Record<string, boolean>): boolean {
  return tabAccess ? tabAccess[tab] === true : false;
}

/**
 * The first tab this user may open, in sidebar order, for redirecting away from
 * a tab they cannot see.
 */
export function firstAllowedTab(tabAccess?: Record<string, boolean>): AppTabId {
  for (const section of NAVIGATION_SECTIONS) {
    for (const item of section.items) {
      if (canAccessTab(item.id, tabAccess)) return item.id;
    }
  }
  return 'dashboard';
}

/**
 * Does this user hold a permission? Used for conditional controls inside a
 * screen (a Create button, a Delete action).
 */
export function hasPermission(
  permissionCodes: string[] | Set<string> | undefined,
  code: string,
): boolean {
  if (!permissionCodes) return false;
  return permissionCodes instanceof Set
    ? permissionCodes.has(code)
    : permissionCodes.includes(code);
}
