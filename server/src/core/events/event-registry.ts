/**
 * Canonical domain-event registry.
 *
 * Every executable surface that names a domain event — code, routes, seeds,
 * workflow triggers, automation triggers and runtime introspection — must read
 * one shared vocabulary so configuration cannot drift from emitted events.
 */

export const DOMAIN_EVENT_CATALOG = [
  // CRM / Lead Pipeline
  { type: 'lead.created', category: 'crm', description: 'A new lead/visitor was created' },
  { type: 'lead.followed_up', category: 'crm', description: 'A follow-up was logged for a lead' },
  { type: 'lead.placement_scheduled', category: 'crm', description: 'Placement test scheduled' },
  { type: 'lead.placement_completed', category: 'crm', description: 'Placement test completed' },
  { type: 'lead.converted', category: 'crm', description: 'Lead converted to student' },
  { type: 'lead.lost', category: 'crm', description: 'Lead marked as lost' },
  // Student
  { type: 'student.registered', category: 'student', description: 'New student registered' },
  { type: 'student.enrolled', category: 'student', description: 'Student enrolled in a class' },
  { type: 'student.status_changed', category: 'student', description: 'Student status changed' },
  { type: 'student.card_issued', category: 'student', description: 'Smart ID card issued' },
  { type: 'student.graduated', category: 'student', description: 'Student graduated' },
  // Academic / Session
  { type: 'class.created', category: 'academic', description: 'New class created' },
  { type: 'class.updated', category: 'academic', description: 'Class details updated' },
  { type: 'class.lifecycle_changed', category: 'academic', description: 'Class lifecycle stage changed' },
  { type: 'class.activated', category: 'academic', description: 'Class activated' },
  { type: 'session.scheduled', category: 'academic', description: 'Session scheduled' },
  { type: 'session.completed', category: 'academic', description: 'Session completed' },
  { type: 'session.cancelled', category: 'academic', description: 'Session cancelled' },
  { type: 'attendance.marked', category: 'academic', description: 'Attendance marked' },
  // Assessment
  { type: 'exam.created', category: 'assessment', description: 'New exam created' },
  { type: 'exam.result_recorded', category: 'assessment', description: 'Exam result recorded' },
  { type: 'exam.certificate_issued', category: 'assessment', description: 'Certificate issued' },
  // Teacher / HR
  { type: 'teacher.created', category: 'hr', description: 'New teacher added' },
  { type: 'teacher.updated', category: 'hr', description: 'Teacher details updated' },
  { type: 'teacher.skill_assigned', category: 'hr', description: 'Skill assigned to teacher' },
  { type: 'teacher.salary_paid', category: 'hr', description: 'Teacher salary paid' },
  { type: 'employee.created', category: 'hr', description: 'New employee added' },
  { type: 'employee.salary_paid', category: 'hr', description: 'Employee salary paid' },
  // Finance
  { type: 'payment.received', category: 'finance', description: 'Payment received' },
  { type: 'payment.refunded', category: 'finance', description: 'Payment refunded' },
  { type: 'invoice.created', category: 'finance', description: 'Invoice created' },
  { type: 'invoice.paid', category: 'finance', description: 'Invoice paid' },
  { type: 'budget.charged', category: 'finance', description: 'Budget line charged' },
  { type: 'budget.month_end_settled', category: 'finance', description: 'Month-end budget settled' },
  { type: 'expense.requested', category: 'finance', description: 'Expense request submitted' },
  { type: 'expense.approved', category: 'finance', description: 'Expense approved' },
  { type: 'expense.rejected', category: 'finance', description: 'Expense rejected' },
  { type: 'saving.transferred', category: 'finance', description: 'Saving transfer executed' },
  { type: 'profit.withdrawn', category: 'finance', description: 'Profit withdrawn' },
  // Inventory
  { type: 'book.added', category: 'inventory', description: 'Book added to inventory' },
  { type: 'book.restocked', category: 'inventory', description: 'Book restocked' },
  { type: 'book.sold', category: 'inventory', description: 'Book sold' },
  { type: 'book.sale_refunded', category: 'inventory', description: 'Book sale refunded' },
  // Funding / Donation
  { type: 'donor.created', category: 'funding', description: 'New donor registered' },
  { type: 'donation.received', category: 'funding', description: 'Donation received' },
  { type: 'campaign.created', category: 'funding', description: 'Funding campaign created' },
  { type: 'scholarship.awarded', category: 'funding', description: 'Scholarship awarded' },
  { type: 'sponsorship.created', category: 'funding', description: 'Sponsorship agreement created' },
  // Impact
  { type: 'impact.report_generated', category: 'impact', description: 'Impact report generated' },
  // Workflow / Automation
  { type: 'workflow.started', category: 'workflow', description: 'Workflow instance started' },
  { type: 'workflow.step_completed', category: 'workflow', description: 'Workflow step completed' },
  { type: 'workflow.completed', category: 'workflow', description: 'Workflow completed' },
  { type: 'workflow.rejected', category: 'workflow', description: 'Workflow rejected' },
  { type: 'automation.triggered', category: 'automation', description: 'Automation triggered' },
  // System
  { type: 'user.created', category: 'system', description: 'User account created' },
  { type: 'user.password_changed', category: 'system', description: 'Password changed' },
  { type: 'branch.created', category: 'system', description: 'Branch created' },
  { type: 'settings.updated', category: 'system', description: 'System settings updated' },
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_CATALOG)[number]['type'];
export type DomainEventCategory = (typeof DOMAIN_EVENT_CATALOG)[number]['category'];

export const DOMAIN_EVENT_TYPES = DOMAIN_EVENT_CATALOG.map((entry) => entry.type) as readonly DomainEventType[];
const DOMAIN_EVENT_TYPE_SET = new Set<string>(DOMAIN_EVENT_TYPES);

export function isDomainEventType(value: string): value is DomainEventType {
  return DOMAIN_EVENT_TYPE_SET.has(value);
}

export type WorkflowTrigger = DomainEventType | 'manual';
export const WORKFLOW_TRIGGER_MANUAL = 'manual' as const;

export function isWorkflowTrigger(value: string): value is WorkflowTrigger {
  return value === WORKFLOW_TRIGGER_MANUAL || isDomainEventType(value);
}
