import type { NavSectionConfig } from '../types/navigation';

/**
 * Enterprise navigation — single source of truth for Sidebar + TAB_ACCESS.
 *
 * Rules:
 * - Every item.id MUST exist as a case in App.tsx (no dead links).
 * - Roles gate visibility; permissions.ts derives TAB_ACCESS from this file.
 *
 * Product map alignment:
 *   Dashboard → Admissions → Academic → HR → Finance → Inventory
 *   → Automation → Reports → Administration
 */
export const NAVIGATION_SECTIONS: NavSectionConfig[] = [
  {
    id: 'core',
    label: 'Core',
    defaultOpen: true,
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: 'LayoutDashboard',
        roles: ['owner', 'manager', 'finance', 'registrar', 'teacher', 'head_of_department', 'counselor', 'donor_manager'],
        description: 'Role-aware daily workspace and KPIs',
        keywords: ['home', 'overview', 'kpi', 'bos', 'dashboard'],
      },
    ],
  },
  {
    id: 'admissions',
    label: 'Admissions & CRM',
    defaultOpen: true,
    items: [
      {
        id: 'visitors',
        label: 'Admissions & Visitors',
        icon: 'UserPlus',
        roles: ['owner', 'manager', 'registrar', 'counselor'],
        description: 'Leads, follow-up, placement, and visitor-to-student conversion',
        keywords: ['crm', 'leads', 'visitors', 'enrollment', 'admissions', 'pipeline'],
      },
    ],
  },
  {
    id: 'academic',
    label: 'Academic Operations',
    defaultOpen: true,
    items: [
      {
        id: 'students',
        label: 'Students',
        icon: 'Users',
        roles: ['owner', 'manager', 'finance', 'registrar', 'teacher', 'head_of_department'],
        description: 'Student records, enrollment, payments, and academic progress',
        keywords: ['student', 'enrollment', 'roster', 'profiles'],
      },
      {
        id: 'classes',
        label: 'Classes',
        icon: 'GraduationCap',
        roles: ['owner', 'manager', 'registrar', 'teacher', 'head_of_department'],
        description: 'Classes, capacity, teachers, rooms, and lifecycle',
        keywords: ['class', 'course', 'section', 'capacity'],
      },
      {
        id: 'sessions',
        label: 'Sessions & Attendance',
        icon: 'CalendarClock',
        roles: ['owner', 'manager', 'registrar', 'teacher', 'head_of_department'],
        description: 'Timetable, sessions, attendance, and teaching operations',
        keywords: ['session', 'attendance', 'schedule', 'roster'],
      },
      {
        id: 'exams',
        label: 'Exams & Certificates',
        icon: 'FileText',
        roles: ['owner', 'manager', 'registrar', 'teacher', 'head_of_department'],
        description: 'Assessments, results, placement, and certificates',
        keywords: ['exam', 'certificate', 'score', 'results'],
      },
    ],
  },
  {
    id: 'hr',
    label: 'HR & Payroll',
    defaultOpen: false,
    items: [
      {
        id: 'teachers',
        label: 'Faculty & Staff',
        icon: 'ClipboardList',
        roles: ['owner', 'manager', 'finance', 'head_of_department'],
        description: 'Teacher & employee roster, skills, payroll, transfers',
        keywords: ['teacher', 'employee', 'payroll', 'salary', 'hr', 'staff', 'leave', 'faculty'],
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance & Inventory',
    defaultOpen: true,
    items: [
      {
        id: 'finance',
        label: 'Finance Desk',
        icon: 'Calculator',
        roles: ['owner', 'manager', 'finance'],
        description: 'Budget, expenses, invoices, student payments',
        keywords: ['budget', 'expense', 'income', 'invoice', 'payment', 'accounting', 'finance'],
      },
      {
        id: 'books',
        label: 'Books & Assets',
        icon: 'BookOpen',
        roles: ['owner', 'manager', 'finance', 'registrar'],
        description: 'Book inventory, sales, and stock levels',
        keywords: ['book', 'inventory', 'stock', 'sale', 'assets'],
      },
      {
        id: 'funding',
        label: 'Funding & Donors',
        icon: 'HandCoins',
        roles: ['owner', 'manager', 'finance', 'donor_manager'],
        description: 'Donor funding and grants',
        keywords: ['donor', 'funding', 'grant', 'sponsorship'],
      },
    ],
  },
  {
    id: 'automation',
    label: 'Automation & Governance',
    defaultOpen: false,
    items: [
      {
        id: 'workflows',
        label: 'Approvals & Workflows',
        icon: 'Workflow',
        roles: ['owner', 'manager'],
        description: 'Controlled approvals, requests, and automation',
        keywords: ['workflow', 'approval', 'scheduler', 'automation'],
      },
      {
        id: 'rules',
        label: 'Cross-Cutting Rules',
        icon: 'Scale',
        roles: ['owner', 'manager'],
        description: 'Only cross-cutting rules; academic policies stay in Academic Control Center',
        keywords: ['rules', 'policy', 'engine', 'automation'],
      },
    ],
  },
  {
    id: 'reports',
    label: 'Analytics & Reports',
    defaultOpen: false,
    items: [
      {
        id: 'operations-report',
        label: 'Operations Report',
        icon: 'BarChart3',
        roles: ['owner', 'manager', 'finance', 'registrar', 'head_of_department'],
        description: 'Enrollment, class capacity, gender mix',
        keywords: ['report', 'enrollment', 'gender', 'operations', 'analytics'],
      },
      {
        id: 'impact',
        label: 'Executive & Impact',
        icon: 'Heart',
        roles: ['owner', 'manager'],
        description: 'Impact metrics and executive summaries',
        keywords: ['report', 'executive', 'impact', 'analytics', 'ngo'],
      },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    defaultOpen: false,
    items: [
      {
        id: 'academic-setup',
        label: 'Academic Control Center',
        icon: 'Settings',
        roles: ['owner', 'manager'],
        description: 'Programs, levels, fees, time slots, rooms, calendar',
        keywords: ['academic', 'program', 'level', 'room', 'timeslot', 'fee', 'configuration', 'setup'],
      },
      {
        id: 'settings',
        label: 'System Administration',
        icon: 'Settings',
        roles: ['owner', 'manager'],
        description: 'Organization, campuses, branches, users',
        keywords: ['settings', 'config', 'campus', 'branch', 'users', 'roles', 'system'],
      },
      {
        id: 'audit',
        label: 'Audit Log',
        icon: 'Shield',
        roles: ['owner', 'manager'],
        description: 'Security and change audit trail',
        keywords: ['audit', 'log', 'security', 'trail'],
      },
    ],
  },
];