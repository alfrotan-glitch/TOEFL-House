-- 016 — Enterprise RBAC + Scope-Based Permissions
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, resource TEXT NOT NULL, action TEXT NOT NULL,
  description TEXT, category TEXT NOT NULL DEFAULT 'general', is_system INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS role_permissions (
  id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  default_scope TEXT NOT NULL DEFAULT 'branch' CHECK (default_scope IN ('organization','campus','branch','department','program','class','own')),
  UNIQUE(role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'branch' CHECK (scope_type IN ('organization','campus','branch','department','program','class','own')),
  scope_id TEXT, is_primary INTEGER NOT NULL DEFAULT 0, assigned_by TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT,
  UNIQUE(user_id, role_id, scope_type, scope_id)
);
CREATE TABLE IF NOT EXISTS permission_overrides (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  scope_type TEXT NOT NULL DEFAULT 'branch' CHECK (scope_type IN ('organization','campus','branch','department','program','class','own')),
  scope_id TEXT, reason TEXT, granted_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT
);
CREATE TABLE IF NOT EXISTS role_delegations (
  id TEXT PRIMARY KEY, from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'branch', scope_id TEXT, reason TEXT,
  starts_at TEXT NOT NULL DEFAULT (datetime('now')), ends_at TEXT NOT NULL, created_by TEXT, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_permission_overrides_user ON permission_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
CREATE INDEX IF NOT EXISTS idx_permissions_code ON permissions(code);
CREATE INDEX IF NOT EXISTS idx_roles_code ON roles(code);
