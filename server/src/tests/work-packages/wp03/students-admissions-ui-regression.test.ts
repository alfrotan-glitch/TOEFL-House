import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
const readUi = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const studentsView = readUi('src/components/students/StudentsView.tsx');
const studentProfileDrawer = readUi('src/components/students/StudentProfileDrawer.tsx');
const apiStore = readUi('src/apiStore.ts');

describe('WP-03 row-correlated UI authority', () => {
  it('keeps finance projection and resume dispatch tied to the actual student row', () => {
    // A permission code is the union of the actor's assignments. On an
    // organization-wide roster it must be correlated with both the redacted
    // student projection and the balance row before any amount is displayed.
    expect(studentsView).toMatch(
      /const canViewStudentFinance = \(student: Student\): boolean =>\s*hasPaymentView\s*&& student\.discountPercent !== undefined\s*&& financeByStudent\.has\(student\.id\);/,
    );
    expect(studentsView).toContain(
      'const showFinanceColumn = displayedStudents.some(canViewStudentFinance);',
    );
    expect(studentsView).toContain('!mayViewRowFinance');
    expect(studentsView).toContain('Restricted');
    expect(studentsView).toContain('canViewFinance={canViewActiveFinance}');
    expect(studentsView).not.toContain('canViewFinance={hasPaymentView}');

    // A full-database search row need not exist in the cached roster. Dispatch
    // must therefore use the opened row's status, not look it up in that cache,
    // or Resume would incorrectly call the ordinary status endpoint.
    expect(studentProfileDrawer).toContain(
      'updateStudentStatus(student.id, to, student.status)',
    );
    expect(apiStore).toContain("fromStatus === 'suspended' && status === 'active'");
    expect(apiStore).not.toMatch(/students\.find\([^)]*studentId/);
  });
});
