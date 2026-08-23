/**
 * TOEFL House ERP — Permission Catalog
 */

export type PermissionScope = 'organization' | 'campus' | 'branch' | 'department' | 'program' | 'class' | 'own';

export interface PermissionDef {
  code: string; resource: string; action: string; description: string; category: string;
}

/**
 * Every role the system recognises. This tuple is the single source of the
 * role vocabulary: `RoleCode` is derived from it, `ROLE_DEFINITIONS` is typed
 * by it, and `authorize()` accepts nothing else. A misspelled role is a
 * compile error rather than a guard that silently matches no one.
 */
export const ROLE_CODES = [
  'owner',
  'general_manager',
  'head_of_department',
  'finance_manager',
  'receptionist',
  'counselor',
  'teacher',
  'data_entry',
  'student',
  'donor_manager',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export interface RoleDef {
  code: RoleCode; name: string; description: string; isSystem: boolean; sortOrder: number;
  permissions: Record<string, PermissionScope>;
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  { code: 'Dashboard.View', resource: 'Dashboard', action: 'View', description: 'View operational dashboard', category: 'dashboard' },
  { code: 'Dashboard.Executive', resource: 'Dashboard', action: 'Executive', description: 'View executive KPI dashboard', category: 'dashboard' },
  { code: 'Analytics.View', resource: 'Analytics', action: 'View', description: 'View analytics', category: 'dashboard' },
  { code: 'Impact.View', resource: 'Impact', action: 'View', description: 'View derived impact reports', category: 'dashboard' },
  { code: 'Impact.Edit', resource: 'Impact', action: 'Edit', description: 'Generate derived impact reports', category: 'dashboard' },
  { code: 'Student.View', resource: 'Student', action: 'View', description: 'View students', category: 'academic' },
  { code: 'Student.Create', resource: 'Student', action: 'Create', description: 'Register students', category: 'academic' },
  { code: 'Student.Edit', resource: 'Student', action: 'Edit', description: 'Edit students', category: 'academic' },
  { code: 'Student.Delete', resource: 'Student', action: 'Delete', description: 'Delete students', category: 'academic' },
  { code: 'Student.Suspend', resource: 'Student', action: 'Suspend', description: 'Suspend students', category: 'academic' },
  { code: 'Student.Resume', resource: 'Student', action: 'Resume', description: 'Resume students', category: 'academic' },
  { code: 'Student.Transfer', resource: 'Student', action: 'Transfer', description: 'Transfer students', category: 'academic' },
  { code: 'Student.Print', resource: 'Student', action: 'Print', description: 'Print student documents', category: 'academic' },
  { code: 'Student.Export', resource: 'Student', action: 'Export', description: 'Export students', category: 'academic' },
  { code: 'Lead.View', resource: 'Lead', action: 'View', description: 'View CRM leads', category: 'admissions' },
  { code: 'Lead.Create', resource: 'Lead', action: 'Create', description: 'Create leads', category: 'admissions' },
  { code: 'Lead.Edit', resource: 'Lead', action: 'Edit', description: 'Edit leads', category: 'admissions' },
  { code: 'Lead.Delete', resource: 'Lead', action: 'Delete', description: 'Delete leads', category: 'admissions' },
  { code: 'Lead.Convert', resource: 'Lead', action: 'Convert', description: 'Convert lead to student', category: 'admissions' },
  { code: 'Lead.Assign', resource: 'Lead', action: 'Assign', description: 'Assign leads', category: 'admissions' },
  { code: 'Class.View', resource: 'Class', action: 'View', description: 'View classes', category: 'academic' },
  { code: 'Class.Create', resource: 'Class', action: 'Create', description: 'Create classes', category: 'academic' },
  { code: 'Class.Edit', resource: 'Class', action: 'Edit', description: 'Edit classes', category: 'academic' },
  { code: 'Class.Delete', resource: 'Class', action: 'Delete', description: 'Delete classes', category: 'academic' },
  { code: 'Class.Assign', resource: 'Class', action: 'Assign', description: 'Assign to class', category: 'academic' },
  { code: 'Session.View', resource: 'Session', action: 'View', description: 'View sessions', category: 'academic' },
  { code: 'Session.Create', resource: 'Session', action: 'Create', description: 'Create sessions', category: 'academic' },
  { code: 'Session.Edit', resource: 'Session', action: 'Edit', description: 'Edit sessions', category: 'academic' },
  { code: 'Attendance.View', resource: 'Attendance', action: 'View', description: 'View attendance', category: 'academic' },
  { code: 'Attendance.Edit', resource: 'Attendance', action: 'Edit', description: 'Edit attendance', category: 'academic' },
  { code: 'Attendance.Override', resource: 'Attendance', action: 'Override', description: 'Override attendance', category: 'academic' },
  { code: 'Exam.View', resource: 'Exam', action: 'View', description: 'View exams', category: 'academic' },
  { code: 'Exam.Create', resource: 'Exam', action: 'Create', description: 'Create exams', category: 'academic' },
  { code: 'Exam.Edit', resource: 'Exam', action: 'Edit', description: 'Edit exams', category: 'academic' },
  { code: 'Exam.Publish', resource: 'Exam', action: 'Publish', description: 'Publish exams', category: 'academic' },
  { code: 'Grade.View', resource: 'Grade', action: 'View', description: 'View grades', category: 'academic' },
  { code: 'Grade.Edit', resource: 'Grade', action: 'Edit', description: 'Edit grades', category: 'academic' },
  { code: 'Grade.Override', resource: 'Grade', action: 'Override', description: 'Override grades', category: 'academic' },
  { code: 'Promotion.Approve', resource: 'Promotion', action: 'Approve', description: 'Approve promotion', category: 'academic' },
  { code: 'Certificate.Issue', resource: 'Certificate', action: 'Issue', description: 'Issue certificates', category: 'academic' },
  { code: 'Certificate.Print', resource: 'Certificate', action: 'Print', description: 'Print certificates', category: 'academic' },
  { code: 'Teacher.View', resource: 'Teacher', action: 'View', description: 'View teachers', category: 'hr' },
  { code: 'Teacher.Create', resource: 'Teacher', action: 'Create', description: 'Create teachers', category: 'hr' },
  { code: 'Teacher.Edit', resource: 'Teacher', action: 'Edit', description: 'Edit teachers', category: 'hr' },
  { code: 'Teacher.Delete', resource: 'Teacher', action: 'Delete', description: 'Delete teachers', category: 'hr' },
  { code: 'Employee.View', resource: 'Employee', action: 'View', description: 'View employees', category: 'hr' },
  { code: 'Employee.Edit', resource: 'Employee', action: 'Edit', description: 'Edit employees', category: 'hr' },
  { code: 'Payroll.View', resource: 'Payroll', action: 'View', description: 'View payroll', category: 'hr' },
  { code: 'Payroll.Edit', resource: 'Payroll', action: 'Edit', description: 'Edit payroll', category: 'hr' },
  { code: 'Payroll.Approve', resource: 'Payroll', action: 'Approve', description: 'Approve payroll', category: 'hr' },
  { code: 'Payment.View', resource: 'Payment', action: 'View', description: 'View payments', category: 'finance' },
  { code: 'Payment.Create', resource: 'Payment', action: 'Create', description: 'Create payments', category: 'finance' },
  { code: 'Payment.Edit', resource: 'Payment', action: 'Edit', description: 'Edit payments', category: 'finance' },
  { code: 'Payment.Delete', resource: 'Payment', action: 'Delete', description: 'Delete payments', category: 'finance' },
  { code: 'Invoice.View', resource: 'Invoice', action: 'View', description: 'View invoices', category: 'finance' },
  { code: 'Invoice.Create', resource: 'Invoice', action: 'Create', description: 'Create invoices', category: 'finance' },
  { code: 'Invoice.Edit', resource: 'Invoice', action: 'Edit', description: 'Edit invoices', category: 'finance' },
  { code: 'Refund.View', resource: 'Refund', action: 'View', description: 'View refunds', category: 'finance' },
  { code: 'Refund.Approve', resource: 'Refund', action: 'Approve', description: 'Approve refunds', category: 'finance' },
  { code: 'Discount.View', resource: 'Discount', action: 'View', description: 'View discounts', category: 'finance' },
  { code: 'Discount.Approve', resource: 'Discount', action: 'Approve', description: 'Approve discounts', category: 'finance' },
  { code: 'Budget.View', resource: 'Budget', action: 'View', description: 'View budget', category: 'finance' },
  { code: 'Budget.Edit', resource: 'Budget', action: 'Edit', description: 'Edit budget', category: 'finance' },
  { code: 'Budget.Allocate', resource: 'Budget', action: 'Allocate', description: 'Allocate funds from main account to budget lines', category: 'finance' },
  { code: 'Expense.View', resource: 'Expense', action: 'View', description: 'View expenses', category: 'finance' },
  { code: 'Expense.Create', resource: 'Expense', action: 'Create', description: 'Create expenses', category: 'finance' },
  { code: 'Expense.Approve', resource: 'Expense', action: 'Approve', description: 'Approve expenses', category: 'finance' },
  { code: 'FeeStructure.Edit', resource: 'FeeStructure', action: 'Edit', description: 'Edit fee structure', category: 'finance' },
  { code: 'Finance.Report', resource: 'Finance', action: 'Report', description: 'Finance reports', category: 'finance' },
  { code: 'Ledger.View', resource: 'Ledger', action: 'View', description: 'View ledger', category: 'finance' },
  { code: 'Book.View', resource: 'Book', action: 'View', description: 'View books', category: 'inventory' },
  { code: 'Book.Create', resource: 'Book', action: 'Create', description: 'Add books', category: 'inventory' },
  { code: 'Book.Edit', resource: 'Book', action: 'Edit', description: 'Edit books', category: 'inventory' },
  { code: 'Book.Sell', resource: 'Book', action: 'Sell', description: 'Sell books', category: 'inventory' },
  { code: 'Funding.View', resource: 'Funding', action: 'View', description: 'View funding', category: 'funding' },
  { code: 'Funding.RecordDonation', resource: 'Funding', action: 'RecordDonation', description: 'Record donation income only', category: 'funding' },
  { code: 'Funding.Edit', resource: 'Funding', action: 'Edit', description: 'Manage donors, campaigns and aid funding', category: 'funding' },
  { code: 'Workflow.View', resource: 'Workflow', action: 'View', description: 'View workflows', category: 'automation' },
  { code: 'Workflow.Approve', resource: 'Workflow', action: 'Approve', description: 'Approve workflows', category: 'automation' },
  { code: 'Workflow.Reject', resource: 'Workflow', action: 'Reject', description: 'Reject workflows', category: 'automation' },
  { code: 'Workflow.Trigger', resource: 'Workflow', action: 'Trigger', description: 'Start workflows for authorized resources', category: 'automation' },
  { code: 'Workflow.Cancel', resource: 'Workflow', action: 'Cancel', description: 'Cancel workflows', category: 'automation' },
  { code: 'Waitlist.View', resource: 'Waitlist', action: 'View', description: 'View class waitlists', category: 'academic' },
  { code: 'Waitlist.Manage', resource: 'Waitlist', action: 'Manage', description: 'Manage class waitlists', category: 'academic' },
  { code: 'Enrollment.FreezeRequest', resource: 'Enrollment', action: 'FreezeRequest', description: 'Create enrollment freeze requests', category: 'academic' },
  { code: 'Enrollment.TransferRequest', resource: 'Enrollment', action: 'TransferRequest', description: 'Create enrollment transfer requests', category: 'academic' },
  { code: 'Rule.View', resource: 'Rule', action: 'View', description: 'View rules', category: 'automation' },
  { code: 'Rule.Edit', resource: 'Rule', action: 'Edit', description: 'Edit rules', category: 'automation' },
  { code: 'User.View', resource: 'User', action: 'View', description: 'View users', category: 'security' },
  { code: 'User.Create', resource: 'User', action: 'Create', description: 'Create users', category: 'security' },
  { code: 'User.Edit', resource: 'User', action: 'Edit', description: 'Edit users', category: 'security' },
  { code: 'User.Delete', resource: 'User', action: 'Delete', description: 'Delete users', category: 'security' },
  { code: 'Role.View', resource: 'Role', action: 'View', description: 'View roles', category: 'security' },
  { code: 'Role.Edit', resource: 'Role', action: 'Edit', description: 'Edit roles', category: 'security' },
  { code: 'Permission.View', resource: 'Permission', action: 'View', description: 'View permissions', category: 'security' },
  { code: 'Permission.Override', resource: 'Permission', action: 'Override', description: 'Override permissions', category: 'security' },
  { code: 'Audit.View', resource: 'Audit', action: 'View', description: 'View audit log', category: 'security' },
  { code: 'Event.View', resource: 'Event', action: 'View', description: 'View events', category: 'security' },
  { code: 'Settings.View', resource: 'Settings', action: 'View', description: 'View settings', category: 'security' },
  { code: 'Settings.Edit', resource: 'Settings', action: 'Edit', description: 'Edit settings', category: 'security' },
  { code: 'Branch.View', resource: 'Branch', action: 'View', description: 'View branches', category: 'security' },
  { code: 'Branch.Edit', resource: 'Branch', action: 'Edit', description: 'Edit branches', category: 'security' },
  { code: 'AcademicSetup.View', resource: 'AcademicSetup', action: 'View', description: 'View academic setup', category: 'security' },
  // ==========================================================================
  // ACADEMIC SETUP — ONE CANONICAL AUTHORITY PER OPERATION
  // ==========================================================================
  // `AcademicSetup.Edit` alone would gate four genuinely different concerns at
  // once: curriculum authoring, placement policy, promotion thresholds and fee
  // configuration. A single code that coarse cannot be granted safely, which is
  // why the General Manager could save a placement PROFILE (role-gated in
  // academic.routes) yet receive 403 creating a program VERSION (permission-
  // gated in catalog.routes) from the very same screen.
  //
  // It is therefore split into atomic capabilities, following the granularity
  // the catalog already uses elsewhere (Student has 9 actions, Class has 5,
  // and money authority is already separated as `FeeStructure.Edit`):
  //
  //   AcademicSetup.Edit             — academic infrastructure: terms, time
  //                                    slots, rooms, programs, levels.
  //   Curriculum.Author              — curriculum structure: program versions
  //                                    (create/publish), subjects, modules.
  //   Curriculum.PlacementPolicy     — placement assessment profile and the
  //                                    placement banding rules. These two are
  //                                    the same decision expressed in two
  //                                    tables and must never diverge again.
  //
  // Deliberately NOT folded into the split:
  //   • Promotion thresholds keep requiring `Promotion.Approve` — promotion
  //     authority already exists and is held by general_manager AND
  //     head_of_department. Reusing it avoids inventing a second authority.
  //   • Fee rules / branch fee profile keep requiring `FeeStructure.Edit` or
  //     `Settings.Edit`. Money authority stays where it is.
  //
  // Grants are derived from behaviour that already shipped, not invented:
  //   • general_manager receives `AcademicSetup.Edit` and
  //     `Curriculum.PlacementPolicy` because `authorize('owner','general_manager')`
  //     already let it write terms, slots, rooms, programs, levels and the
  //     placement profile. Encoding that as permissions grants nothing new.
  //   • general_manager receives `Curriculum.Author` because the same role
  //     already holds `Class.Create`, which `requirePermission` (OR semantics)
  //     accepted for class generation from a program version — it could
  //     already generate classes from curriculum it was forbidden to author.
  //     This removes the contradiction rather than widening reach.
  //   • head_of_department, receptionist, teacher, data_entry and student
  //     receive NONE of these codes; their access is unchanged.
  { code: 'AcademicSetup.Edit', resource: 'AcademicSetup', action: 'Edit', description: 'Edit academic infrastructure (terms, slots, rooms, programs, levels)', category: 'security' },
  { code: 'Curriculum.Author', resource: 'Curriculum', action: 'Author', description: 'Create and publish program versions, subjects and modules', category: 'security' },
  { code: 'Curriculum.PlacementPolicy', resource: 'Curriculum', action: 'PlacementPolicy', description: 'Configure placement assessment policy and placement banding rules', category: 'security' },
  { code: 'Curriculum.TestBank', resource: 'Curriculum', action: 'TestBank', description: 'Author placement test-bank content: tests, sections, questions, rubrics, audio', category: 'security' },
  { code: 'Report.View', resource: 'Report', action: 'View', description: 'View operational and financial reports', category: 'reporting' },
];
export type PermissionCode = typeof PERMISSION_CATALOG[number]['code'];
function allPerms(scope: PermissionScope, exclude: PermissionCode[] = []): Record<string, PermissionScope> {
  return Object.fromEntries(
    PERMISSION_CATALOG
      .filter(p => !exclude.includes(p.code))
      .map(p => [p.code, scope])
  );
}
function pick(codes: PermissionCode[], scope: PermissionScope): Record<string, PermissionScope> {
  return Object.fromEntries(codes.map(c => [c, scope]));
}

export const ROLE_DEFINITIONS: RoleDef[] = [
  {
    code: 'owner', name: 'Owner', description: 'Organization-wide executive access',
    isSystem: true, sortOrder: 10,
    // NOTE: Middleware currently bypasses Owner completely. These DB permissions are for audit/logging completeness.
    permissions: allPerms('organization', ['Attendance.Edit', 'Grade.Edit', 'Student.Delete', 'Payment.Delete']),
  },
  {
    code: 'general_manager', name: 'General Manager', description: 'Campus/branch operations',
    isSystem: true, sortOrder: 20,
    permissions: pick([
      'Dashboard.View','Analytics.View','Student.View','Student.Create','Student.Edit','Student.Suspend','Student.Resume','Student.Transfer','Student.Print',
      'Lead.View','Lead.Create','Lead.Edit','Lead.Convert','Lead.Assign',
      'Class.View','Class.Create','Class.Edit','Class.Assign','Session.View','Session.Create','Session.Edit',
      'Attendance.View','Attendance.Edit','Exam.View','Exam.Create','Exam.Edit','Exam.Publish','Grade.View','Grade.Edit','Promotion.Approve',
      'Certificate.Issue','Certificate.Print','Teacher.View','Teacher.Edit','Teacher.Create','Teacher.Delete','Employee.View','Employee.Edit','Payroll.View','Payroll.Edit',
      'Payment.View','Payment.Create','Invoice.View','Invoice.Create','Discount.View','Expense.View','Expense.Create','Expense.Approve','Budget.View','Budget.Edit','Budget.Allocate','Finance.Report','Refund.Approve','Report.View','Funding.View','Funding.RecordDonation','Funding.Edit','Impact.View','Impact.Edit',
      'Book.View','Book.Sell','Workflow.View','Workflow.Trigger','Workflow.Approve','Workflow.Reject','Workflow.Cancel','Waitlist.View','Waitlist.Manage','Enrollment.FreezeRequest','Enrollment.TransferRequest','Rule.View','Audit.View','Settings.View','Branch.View','AcademicSetup.View','Curriculum.TestBank',
      // Academic Setup authority, encoding access general_manager already
      // exercised through authorize('owner','general_manager') and Class.Create.
      // See the AcademicSetup block in PERMISSION_CATALOG for the evidence.
      'AcademicSetup.Edit','Curriculum.Author','Curriculum.PlacementPolicy',
    ], 'branch'),
  },
  {
    code: 'head_of_department', name: 'Head of Department', description: 'Academic scope only',
    isSystem: true, sortOrder: 30,
    permissions: pick([
      'Dashboard.View','Student.View','Class.View','Class.Edit','Class.Assign','Session.View','Session.Create','Session.Edit',
      'Attendance.View','Attendance.Edit','Exam.View','Exam.Create','Exam.Edit','Exam.Publish','Grade.View','Grade.Edit','Waitlist.View','Waitlist.Manage','Enrollment.FreezeRequest','Enrollment.TransferRequest',
      'Promotion.Approve','Certificate.Issue','Certificate.Print','Teacher.View','Report.View','Curriculum.TestBank',
    ], 'department'),
  },
  {
    code: 'finance_manager', name: 'Finance Manager', description: 'Finance desk — payments & ledger; no treasury allocation',
    isSystem: true, sortOrder: 40,
    permissions: pick([
      'Dashboard.View','Student.View','Payment.View','Payment.Create','Payment.Edit','Invoice.View','Invoice.Create','Invoice.Edit',
      'Refund.View','Refund.Approve','Discount.View','Budget.View','Expense.View','Expense.Create',
      'Finance.Report','Ledger.View','Report.View','Payroll.View','Payroll.Edit','Teacher.View','Teacher.Create','Teacher.Edit','Employee.View','Book.View','Book.Sell','Funding.View','Funding.RecordDonation','Workflow.View',
    ], 'branch'),
  },
  {
    code: 'receptionist', name: 'Receptionist', description: 'Front desk admissions and receipts',
    isSystem: true, sortOrder: 50,
    permissions: pick([
      'Dashboard.View','Lead.View','Lead.Create','Lead.Edit','Lead.Convert','Student.View','Student.Create','Student.Edit','Student.Print','Student.Transfer',
      'Class.View','Class.Assign','Session.View','Attendance.View','Exam.View','Waitlist.View','Waitlist.Manage','Enrollment.FreezeRequest','Enrollment.TransferRequest','Payment.Create','Payment.View','Invoice.View','Invoice.Create','Book.View','Book.Sell','Report.View',
    ], 'branch'),
  },
  {
    code: 'counselor', name: 'Counselor', description: 'CRM follow-up',
    isSystem: true, sortOrder: 55,
    permissions: pick(['Dashboard.View','Lead.View','Lead.Create','Lead.Edit','Lead.Assign','Student.View','Class.View'], 'branch'),
  },
  {
    code: 'teacher', name: 'Teacher', description: 'Own classes only',
    isSystem: true, sortOrder: 60,
    permissions: {
      'Dashboard.View': 'own', 'Student.View': 'class', 'Class.View': 'own', 'Session.View': 'own', 'Session.Edit': 'own',
      'Attendance.View': 'own', 'Attendance.Edit': 'own', 'Exam.View': 'own', 'Grade.View': 'own', 'Grade.Edit': 'own',
    },
  },
  {
    code: 'data_entry', name: 'Data Entry', description: 'Data entry without delete/finance',
    isSystem: true, sortOrder: 70,
    permissions: pick([
      'Dashboard.View','Student.View','Student.Create','Student.Edit','Attendance.View','Attendance.Edit',
      'Grade.View','Grade.Edit','Exam.View','Class.View','Session.View',
    ], 'branch'),
  },
  {
    code: 'student', name: 'Student', description: 'Read-only self-service portal — own profile only',
    isSystem: true, sortOrder: 90,
    // Deliberately empty: student portal endpoints are role-gated
    // (authorize('student')) and object-checked against linked_student_id;
    // the student must never inherit any administrative permission.
    permissions: {},
  },
  {
    code: 'donor_manager', name: 'Donor Manager', description: 'Funding and impact',
    isSystem: true, sortOrder: 90,
    permissions: {
      'Dashboard.View': 'branch', 'Funding.View': 'organization', 'Funding.RecordDonation': 'organization', 'Funding.Edit': 'organization',
      'Impact.View': 'organization', 'Impact.Edit': 'organization', 'Student.View': 'branch', 'Finance.Report': 'branch',
    },
  },
];

export const TAB_PERMISSION_MAP: Record<string, PermissionCode> = {
  dashboard: 'Dashboard.View',
  visitors: 'Lead.View',
  students: 'Student.View',
  teachers: 'Teacher.View',
  classes: 'Class.View',
  sessions: 'Session.View',
  exams: 'Exam.View',
  finance: 'Finance.Report',
  funding: 'Funding.View',
  impact: 'Impact.View',
  books: 'Book.View',
  workflows: 'Workflow.View',
  rules: 'Rule.View',
  audit: 'Audit.View',
  settings: 'Settings.View',
  'academic-setup': 'AcademicSetup.View',
  'operations-report': 'Report.View',
  'test-bank': 'Curriculum.TestBank',
  reports: 'Report.View',
};
