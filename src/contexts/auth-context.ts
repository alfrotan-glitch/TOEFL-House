/**
 * Context object + types for authentication.
 * Kept separate from the provider and hook so each file exports a single
 * cohesive unit (fast-refresh friendly): auth-context (context + types),
 * AuthProvider (provider component), useAuth (hook).
 */
import { createContext } from 'react';
import { USER_ROLE_CODES, UserRole } from '../types';

export const USER_ROLES = new Set<UserRole>(USER_ROLE_CODES);

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  role: UserRole;
  branchId: string;
  mustChangePassword: boolean;
  permissions?: Set<string>;
  roles?: { roleId: string; roleCode: string; roleName: string; scopeType: string; scopeId: string | null }[];
  tabAccess?: Record<string, boolean>;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (permissionCode: string) => boolean;
  canAccessTab: (tabId: string) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
