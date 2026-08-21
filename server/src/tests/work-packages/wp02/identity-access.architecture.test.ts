import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../../../db/connection.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe('WP-02 identity and access architecture', () => {
  it('keeps role assignment out of the users identity row', () => {
    initSchema();
    expect(columns('users')).not.toContain('role');
    expect(columns('users')).toEqual(expect.arrayContaining([
      'linked_student_id', 'linked_teacher_id', 'linked_employee_id', 'linked_partner_id',
    ]));
  });

  it('keeps each staff link on the canonical account side only', () => {
    initSchema();
    expect(columns('teachers')).not.toContain('user_id');
    expect(columns('employees')).not.toContain('user_id');

    const foreignKeys = db.prepare('PRAGMA foreign_key_list(users)').all() as Array<{ from: string; table: string; to: string }>;
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'linked_teacher_id', table: 'teachers', to: 'id' }),
      expect.objectContaining({ from: 'linked_employee_id', table: 'employees', to: 'id' }),
    ]));
  });

  it('enforces one account per linked business identity', () => {
    initSchema();
    const indexes = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'users' AND name LIKE 'idx_users_linked_%'`).all() as Array<{ name: string; sql: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual([
      'idx_users_linked_employee',
      'idx_users_linked_partner',
      'idx_users_linked_student',
      'idx_users_linked_teacher',
    ]);
    for (const index of indexes) {
      expect(index.sql).toMatch(/CREATE UNIQUE INDEX/i);
      expect(index.sql).toMatch(/WHERE linked_\w+_id IS NOT NULL/i);
    }
  });

  it('has no delegation table or second role authority', () => {
    initSchema();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_delegations'").get()).toBeUndefined();
    expect(read('server/src/db/schema.sql')).not.toMatch(/CREATE TABLE IF NOT EXISTS role_delegations/i);
    expect(read('server/src/core/rbac/rbac-service.ts')).not.toMatch(/role_delegations/);
  });

  it('keeps role and permission claims out of session tokens', () => {
    const authSource = read('server/src/utils/auth.ts');
    const payload = authSource.match(/export interface TokenPayload\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(payload).not.toMatch(/\brole\b/);
    expect(payload).not.toMatch(/permission/i);
    expect(payload).toMatch(/sessionVersion/);
  });

  it('does not mount a broad rate limiter over the auth router', () => {
    const indexSource = read('server/src/index.ts');
    expect(indexSource).toContain("app.use('/api/auth', authRouter)");
    expect(indexSource).not.toMatch(/app\.use\(\s*['"]\/api\/auth['"]\s*,\s*\w*[Ll]imit/);
  });

  it('uses the server-resolved global-owner fact instead of an Owner label bypass in the UI', () => {
    const files = [
      'src/App.tsx',
      'src/contexts/AuthProvider.tsx',
      'src/components/academic/AcademicSetupView.tsx',
      'src/components/books/BooksView.tsx',
      'src/components/classes/ClassesView.tsx',
      'src/components/dashboard/DashboardView.tsx',
      'src/components/exams/ExamsView.tsx',
      'src/components/finance/FinanceView.tsx',
      'src/components/funding/FundingView.tsx',
      'src/components/rules/RulesManagementView.tsx',
      'src/components/sessions/SessionsView.tsx',
      'src/components/settings/SettingsView.tsx',
      'src/components/students/StudentsView.tsx',
      'src/components/teachers/TeachersView.tsx',
      'src/components/workflows/WorkflowsView.tsx',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/(?:activeRole|role)\s*===\s*['"]owner['"]/);
      expect(source, file).not.toMatch(/['"]owner['"][^\n]*\.includes\(activeRole\)/);
    }
    expect(read('src/contexts/auth-context.ts')).toContain('isGlobalOwner: boolean');
    expect(read('server/src/routes/auth.routes.ts')).toContain('isGlobalOwner: isGlobalOwner(rbac)');
  });

  it('awaits server logout before clearing the local principal', () => {
    const provider = read('src/contexts/AuthProvider.tsx');
    expect(provider).toMatch(/const logout = useCallback\(async/);
    expect(provider).toMatch(/await fetch\([\s\S]*?\/auth\/logout/);
    expect(read('src/contexts/auth-context.ts')).toContain('logout: () => Promise<void>');
  });
});
