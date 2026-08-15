/**
Default workflow definitions that the system starts with.
This function is idempotent — if at least one workflow definition
already exists, it does nothing, so calling it on every server
startup is safe.
*/
import { db } from '../db/connection.js';
import { id } from './ids.js';

interface DefaultWorkflowStep {
  order: number;
  role: string;
  action: 'review' | 'approve' | 'notify' | 'execute';
  label: string;
  slaHours: number;
}

interface DefaultWorkflowDefinition {
  name: string;
  trigger: string;
  steps: DefaultWorkflowStep[];
}

const DEFAULT_WORKFLOWS: DefaultWorkflowDefinition[] = [
  {
    name: 'Budget Expense Approval',
    trigger: 'expense.requested',
    steps: [
      { order: 1, role: 'manager', action: 'review', label: 'Branch manager review', slaHours: 24 },
      { order: 2, role: 'owner', action: 'approve', label: 'Founder final approval', slaHours: 48 },
      { order: 3, role: 'finance', action: 'execute', label: 'Finance department payment', slaHours: 24 },
    ],
  },
  {
    name: 'Refund Request',
    trigger: 'payment.refund_requested',
    steps: [
      { order: 1, role: 'registrar', action: 'review', label: 'Registrar verification', slaHours: 12 },
      { order: 2, role: 'manager', action: 'approve', label: 'Branch manager approval', slaHours: 24 },
      { order: 3, role: 'finance', action: 'execute', label: 'Finance refund processing', slaHours: 24 },
    ],
  },
  {
    name: 'Teacher Salary Payment',
    trigger: 'teacher.salary_requested',
    steps: [
      { order: 1, role: 'head_of_department', action: 'review', label: 'Academic head review', slaHours: 24 },
      { order: 2, role: 'finance', action: 'approve', label: 'Finance approval', slaHours: 24 },
      { order: 3, role: 'owner', action: 'approve', label: 'Founder final approval', slaHours: 48 },
      { order: 4, role: 'finance', action: 'execute', label: 'Finance payment execution', slaHours: 12 },
    ],
  },
  {
    name: 'Student Withdrawal',
    trigger: 'student.withdrawal_requested',
    steps: [
      { order: 1, role: 'registrar', action: 'review', label: 'Registrar review', slaHours: 24 },
      { order: 2, role: 'manager', action: 'approve', label: 'Branch manager approval', slaHours: 48 },
      { order: 3, role: 'finance', action: 'execute', label: 'Finance settlement', slaHours: 24 },
    ],
  },
  {
    name: 'Budget Reallocation',
    trigger: 'budget.reallocation_requested',
    steps: [
      { order: 1, role: 'finance', action: 'review', label: 'Finance review', slaHours: 24 },
      { order: 2, role: 'owner', action: 'approve', label: 'Founder approval', slaHours: 48 },
    ],
  },
  {
    name: 'Scholarship Award',
    trigger: 'scholarship.award_requested',
    steps: [
      { order: 1, role: 'manager', action: 'review', label: 'Manager eligibility review', slaHours: 48 },
      { order: 2, role: 'donor_manager', action: 'review', label: 'Donor manager verification', slaHours: 48 },
      { order: 3, role: 'owner', action: 'approve', label: 'Founder final approval', slaHours: 72 },
      { order: 4, role: 'finance', action: 'execute', label: 'Finance payment execution', slaHours: 24 },
    ],
  },
];

// ── Performance: Module-level Prepared Statements ──────────────────────────
const stmtCountWorkflows = db.prepare('SELECT COUNT(*) as c FROM workflow_definitions');
const stmtInsertWorkflowDef = db.prepare(
  `INSERT INTO workflow_definitions (id, name, trigger, steps, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
);

export function seedDefaultWorkflowDefinitions(): void {
  const existing = stmtCountWorkflows.get() as { c: number };
  if (existing.c > 0) return;
  // If an error occurs mid-loop, all insertions are rolled back.
  const insertTx = db.transaction(() => {
    for (const def of DEFAULT_WORKFLOWS) {
      stmtInsertWorkflowDef.run(id('wfd'), def.name, def.trigger, JSON.stringify(def.steps));
    }
  });
  
  insertTx();
}