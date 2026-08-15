-- ============================================================================
-- 053 — Remove the obsolete 'designer' role
-- ============================================================================
-- The designer role was never assignable: no UserRole maps to it, the user
-- admin allow-list excludes it, and the permission catalog no longer defines
-- it. Clean it (and any stray assignments) from existing databases so the
-- roles table reflects only real positions.
-- ============================================================================

DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE code = 'designer');
DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code = 'designer');
DELETE FROM roles WHERE code = 'designer';
