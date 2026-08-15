/**
 * useAuth — the consumer hook for the authentication context.
 * Kept in its own file so the context module stays fast-refresh friendly.
 */
import { useContext } from 'react';
import { AuthContext, AuthContextValue } from './auth-context';

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
