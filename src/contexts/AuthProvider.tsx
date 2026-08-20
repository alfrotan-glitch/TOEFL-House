/**
 * Authentication provider — the only export of this file (fast-refresh
 * friendly). Owns the session state, login/logout/password flows and the
 * unauthorized-session listener.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, setToken, onUnauthorized } from '../api/client';
import { canAccessTab as checkTabAccess } from '../config/permissions';
import { AuthContext, AuthUser, AuthContextValue, USER_ROLES } from './auth-context';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const logout = useCallback(() => {
    void fetch(`${import.meta.env.VITE_API_URL || '/api'}/auth/logout`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } }).catch(() => undefined);
    setToken(null);
    setUser(null);
  }, []);
  const logoutRef = useRef(logout);
  useEffect(() => { logoutRef.current = logout; }, [logout]);

  // Helper to normalize API response (convert array to Set)
  const normalizeUser = (rawUser: unknown): AuthUser => {
    if (!rawUser || typeof rawUser !== 'object') throw new Error('Invalid user payload.');
    const value = rawUser as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.username !== 'string' || typeof value.fullName !== 'string' ||
        (value.email !== null && typeof value.email !== 'string') || typeof value.role !== 'string' ||
        typeof value.branchId !== 'string' || typeof value.mustChangePassword !== 'boolean') {
      throw new Error('Invalid user payload.');
    }
    const permissions = Array.isArray(value.permissions)
      ? value.permissions.filter((permission): permission is string => typeof permission === 'string')
      : [];
    const roles = Array.isArray(value.roles) ? value.roles.filter((role): role is NonNullable<AuthUser['roles']>[number] =>
      !!role && typeof role === 'object' && typeof role.roleId === 'string' && typeof role.roleCode === 'string' &&
      typeof role.roleName === 'string' && typeof role.scopeType === 'string' &&
      (role.scopeId === null || typeof role.scopeId === 'string')) : [];
    const tabAccess = value.tabAccess && typeof value.tabAccess === 'object'
      ? Object.fromEntries(Object.entries(value.tabAccess).filter(([, allowed]) => typeof allowed === 'boolean')) as Record<string, boolean>
      : undefined;
    if (!USER_ROLES.has(value.role as AuthUser['role'])) throw new Error('Invalid user role.');
    return {
      id: value.id,
      username: value.username,
      fullName: value.fullName,
      email: value.email as string | null,
      role: value.role as AuthUser['role'],
      branchId: value.branchId,
      mustChangePassword: value.mustChangePassword,
      permissions: new Set(permissions),
      roles,
      tabAccess,
    };
  };

  const refreshUser = useCallback(async () => {
    // Authentication is cookie-based; getToken() is intentionally null.
    // Always ask the server for the current session and let a 401 mean
    // there is no authenticated session.
    try {
      const rawMe = await api.get<unknown>('/auth/me');
      setUser(normalizeUser(rawMe));
    } catch {
      setToken(null); 
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Register the unauthorized listener once
    onUnauthorized(() => logoutRef.current());
    void (async () => { await refreshUser(); })();
  }, [refreshUser]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.post<{ token?: string; user: AuthUser }>('/auth/login', { username, password });
    setToken(null);
    setUser(normalizeUser(result.user));
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.post('/auth/change-password', { currentPassword, newPassword });
    setUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
  }, []);
  const can = useCallback((permissionCode: string) => {
    if (!user) return false;
    if (user.role === 'owner') return true;
    return user.permissions ? user.permissions.has(permissionCode) : false;
  }, [user]);
  const canAccessTab = useCallback((tabId: string) => {
    if (!user) return false;
    return checkTabAccess(tabId, user.tabAccess);
  }, [user]);

  const value: AuthContextValue = { user, isLoading, login, logout, changePassword, refreshUser, can, canAccessTab };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
