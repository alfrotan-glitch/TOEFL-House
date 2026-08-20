/**
 * Finance category taxonomy — THE canonical, hierarchical accounting model.
 * ============================================================================
 *
 * This module is the ONLY definition of what a finance category is. It is read
 * by
 *
 *   · `db/financeCategoryCatalog.ts`  (seeds `finance_categories` + channels)
 *   · `db/organizationHierarchy.ts`   (branch provisioning)
 *   · `core/finance/ledger-classification.ts` (P&L / cash flow / reports)
 *   · `routes/finance.routes.ts`      (GET /finance/categories)
 *   · the test-suite
 *
 * so a change lands in exactly one place instead of five.
 *
 * THE MODEL
 * ---------
 *   TAXONOMY   Category → Subcategory → Channel
 *              Organization-wide, complete, immutable in shape.
 *
 *   BUDGET     Branch → Budget Line → Allocation
 *              Sparse and deliberate. A budget line names one envelope of money
 *              under one SUBCATEGORY. A subcategory existing does NOT imply
 *              that any branch funds it, and the system never invents envelopes
 *              to make the taxonomy look complete.
 *
 *   LEDGER     `financial_transactions.finance_category_id` is a foreign key
 *              into this taxonomy. Accounting classification is resolved by
 *              joining `finance_categories.classification` — never by matching
 *              a category name or any other string.
 *
 * RULES ENCODED HERE
 * ------------------
 * · IDs are STABLE CODES, never display names. Renaming "Rent Expense" must not
 *   orphan a budget line or a ledger row.
 * · Exactly two taxonomy levels. A budget line is the third level and lives in
 *   `budget_lines`, so a category is never redefined inside a budget line.
 * · Every node carries an explicit ACCOUNTING CLASSIFICATION. Nothing is
 *   "assumed to be an operating expense".
 * · Facebook is a CHANNEL under Marketing & Promotion → Digital Advertising.
 *   It is deliberately NOT an accounting category — see CANONICAL_CHANNELS.
 */

export type FinanceCategoryClassification =
  | 'operating_expense'
  | 'capital_expenditure'
  | 'non_expense_cash_movement';

export const FINANCE_CATEGORY_CLASSIFICATIONS: readonly FinanceCategoryClassification[] = [
  'operating_expense',
  'capital_expenditure',
  'non_expense_cash_movement',
] as const;

export type FinanceCategoryLevel = 'category' | 'subcategory';

export interface CanonicalCategory {
  /** Stable business identifier. NEVER a display name. */
  id: string;
  name: string;
  classification: FinanceCategoryClassification;
  /** Ordered leaf nodes. A budget line attaches to one of these. */
  children: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * The canonical taxonomy, in canonical display order.
 *
 * Ordering is DATA, not an accident of `ORDER BY name`: the seeder writes
 * `sort_order` from these array positions, so "Personnel & Payroll" always
 * precedes "Premises & Facilities" regardless of locale collation.
 */
export const CANONICAL_CATEGORIES: readonly CanonicalCategory[] = [
  {
    id: 'cat_personnel_payroll',
    name: 'Personnel & Payroll',
    classification: 'operating_expense',
    children: [
      { id: 'sub_salaries_wages', name: 'Salaries & Wages' },
      { id: 'sub_staff_benefits', name: 'Staff Benefits' },
      { id: 'sub_staff_training', name: 'Staff Training & Development' },
      { id: 'sub_recruitment', name: 'Recruitment Expenses' },
    ],
  },
  {
    id: 'cat_premises_facilities',
    name: 'Premises & Facilities',
    classification: 'operating_expense',
    children: [
      { id: 'sub_rent', name: 'Rent Expense' },
      { id: 'sub_utilities', name: 'Utilities' },
      { id: 'sub_internet_communication', name: 'Internet & Communication' },
      { id: 'sub_telephone', name: 'Telephone Expenses' },
      { id: 'sub_cleaning_sanitation', name: 'Cleaning & Sanitation' },
      { id: 'sub_security', name: 'Security Expenses' },
      { id: 'sub_repair_maintenance', name: 'Repair & Maintenance' },
    ],
  },
  {
    id: 'cat_office_admin',
    name: 'Office & Administration',
    classification: 'operating_expense',
    children: [
      { id: 'sub_office_supplies', name: 'Office Supplies' },
      { id: 'sub_stationery', name: 'Stationery Expenses' },
      { id: 'sub_printing', name: 'Printing Expenses' },
      { id: 'sub_postage_courier', name: 'Postage & Courier' },
      { id: 'sub_software_subscriptions', name: 'Software & Subscriptions' },
      { id: 'sub_legal_professional', name: 'Legal & Professional Services' },
      { id: 'sub_insurance', name: 'Insurance Expenses' },
      { id: 'sub_licenses_permits', name: 'Business Licenses & Permits' },
    ],
  },
  {
    id: 'cat_academic_student_ops',
    name: 'Academic & Student Operations',
    classification: 'operating_expense',
    children: [
      { id: 'sub_teaching_materials', name: 'Teaching Materials' },
      { id: 'sub_books_educational', name: 'Books & Educational Materials' },
      { id: 'sub_examination_testing', name: 'Examination & Testing Expenses' },
      { id: 'sub_student_activities', name: 'Student Activities & Events' },
      { id: 'sub_teacher_training', name: 'Teacher Training & Development' },
    ],
  },
  {
    id: 'cat_marketing_promotion',
    name: 'Marketing & Promotion',
    classification: 'operating_expense',
    children: [
      { id: 'sub_digital_advertising', name: 'Digital Advertising' },
      { id: 'sub_traditional_advertising', name: 'Traditional Advertising' },
      { id: 'sub_promotional_materials', name: 'Promotional Materials' },
    ],
  },
  {
    id: 'cat_transport_logistics',
    name: 'Transportation & Logistics',
    classification: 'operating_expense',
    children: [
      { id: 'sub_fuel', name: 'Fuel Expenses' },
      { id: 'sub_taxi_transportation', name: 'Taxi & Transportation' },
      { id: 'sub_delivery_courier', name: 'Delivery & Courier' },
      { id: 'sub_travel_accommodation', name: 'Travel & Accommodation' },
    ],
  },
  {
    id: 'cat_financial_tax',
    name: 'Financial & Tax',
    classification: 'operating_expense',
    children: [
      { id: 'sub_bank_payment_fees', name: 'Bank & Payment Processing Fees' },
      { id: 'sub_taxes_duties', name: 'Taxes & Duties' },
      { id: 'sub_tax_clearance', name: 'Tax Clearance Fees' },
    ],
  },
  {
    id: 'cat_food_general_ops',
    name: 'Food & General Operations',
    classification: 'operating_expense',
    children: [
      { id: 'sub_food_catering', name: 'Food & Catering' },
      { id: 'sub_miscellaneous', name: 'Miscellaneous Expenses' },
    ],
  },
  {
    // A fixed asset purchase is CASH OUT, not a cost of trading. Keeping it in
    // operating expenses understates profit in the month of purchase and
    // overstates it in every month afterwards.
    id: 'cat_capital_expenditure',
    name: 'Capital Expenditure',
    classification: 'capital_expenditure',
    children: [
      { id: 'sub_it_equipment', name: 'IT Equipment' },
      { id: 'sub_office_equipment', name: 'Office Equipment' },
      { id: 'sub_furniture_fixtures', name: 'Furniture & Fixtures' },
      { id: 'sub_vehicles', name: 'Vehicles' },
      { id: 'sub_other_fixed_assets', name: 'Other Fixed Assets' },
    ],
  },
  {
    // Money leaves the till but no operating cost is incurred: an advance is a
    // receivable, a refund is contra-revenue, a drawing is equity, and a
    // charitable contribution is a distribution — none of them are trading cost.
    id: 'cat_non_expense_cash',
    name: 'Non-Expense Cash Movements',
    classification: 'non_expense_cash_movement',
    children: [
      { id: 'sub_salary_advances', name: 'Salary Advances' },
      { id: 'sub_refunds', name: 'Refunds' },
      { id: 'sub_owner_drawings', name: "Owner's Drawings" },
      { id: 'sub_charitable_contributions', name: 'Charitable Contributions' },
    ],
  },
] as const;

/**
 * Channels / vendors.
 *
 * PRODUCT RULE: a platform such as Facebook is a MARKETING CHANNEL, not an
 * accounting category. Giving each platform its own ledger category would
 * fragment marketing spend and make Digital Advertising unauditable, so
 * platforms are modelled one level BELOW the subcategory instead — which also
 * means adding a platform is data entry, not an accounting change.
 */
export const CANONICAL_CHANNELS: ReadonlyArray<{
  id: string;
  categoryId: string;
  name: string;
  kind: 'channel' | 'vendor';
}> = [{ id: 'chn_facebook', categoryId: 'sub_digital_advertising', name: 'Facebook', kind: 'channel' }] as const;

/** Category ids of every canonical node, for fast membership checks. */
export const CANONICAL_CATEGORY_IDS: ReadonlySet<string> = new Set(
  CANONICAL_CATEGORIES.flatMap((c) => [c.id, ...c.children.map((s) => s.id)]),
);

/** subcategory id → parent category id. */
export const SUBCATEGORY_PARENT: ReadonlyMap<string, string> = new Map(
  CANONICAL_CATEGORIES.flatMap((c) => c.children.map((s) => [s.id, c.id] as const)),
);

/** Every canonical node id → its accounting classification. */
export const CATEGORY_CLASSIFICATION: ReadonlyMap<string, FinanceCategoryClassification> = new Map(
  CANONICAL_CATEGORIES.flatMap((c) => [
    [c.id, c.classification] as const,
    ...c.children.map((s) => [s.id, c.classification] as const),
  ]),
);

/** Canonical node id → display name (presentation only, never an identifier). */
export const CATEGORY_NAME: ReadonlyMap<string, string> = new Map(
  CANONICAL_CATEGORIES.flatMap((c) => [
    [c.id, c.name] as const,
    ...c.children.map((s) => [s.id, s.name] as const),
  ]),
);

/**
 * Rows the seeder must write, in canonical order, flattened.
 * Used by both the migration path and the fresh-install path so the two can
 * never disagree.
 */
export interface CanonicalCategoryRow {
  id: string;
  parentId: string | null;
  name: string;
  level: FinanceCategoryLevel;
  classification: FinanceCategoryClassification;
  sortOrder: number;
}

export function canonicalCategoryRows(): CanonicalCategoryRow[] {
  const rows: CanonicalCategoryRow[] = [];
  CANONICAL_CATEGORIES.forEach((category, categoryIndex) => {
    rows.push({
      id: category.id,
      parentId: null,
      name: category.name,
      level: 'category',
      classification: category.classification,
      sortOrder: (categoryIndex + 1) * 10,
    });
    category.children.forEach((sub, subIndex) => {
      rows.push({
        id: sub.id,
        parentId: category.id,
        name: sub.name,
        level: 'subcategory',
        classification: category.classification,
        sortOrder: (subIndex + 1) * 10,
      });
    });
  });
  return rows;
}

/**
 * Resolve the accounting classification of a canonical node id.
 * Unknown ids fall back to `operating_expense`, which is the behaviour the
 * system had before the taxonomy existed — an unknown category must never
 * silently disappear from the cost side of the P&L.
 */
export function classificationOf(categoryId: string | null | undefined): FinanceCategoryClassification {
  if (!categoryId) return 'operating_expense';
  return CATEGORY_CLASSIFICATION.get(categoryId) ?? 'operating_expense';
}

// ── Payroll envelopes ───────────────────────────────────────────────────────
/**
 * Which payroll run a budget line funds.
 *
 * "This envelope funds teacher payroll" is a business relationship, so it is
 * modelled as one rather than inferred from a name. The database allows at most
 * one envelope per (branch, target), and teacher and employee budgets stay
 * SEPARATE: two envelopes with independent balances that happen to share the
 * Salaries & Wages subcategory.
 */
export type PayrollTarget = 'teacher' | 'employee';

export const PAYROLL_TARGETS: readonly PayrollTarget[] = ['teacher', 'employee'] as const;

export interface PayrollEnvelope {
  target: PayrollTarget;
  name: string;
  categoryId: string;
  icon: string;
  costType: 'fixed' | 'variable';
  sortOrder: number;
}

/**
 * The ONLY budget lines a branch is provisioned with.
 *
 * Payroll cannot run without an envelope to debit — `pay-salary` answers 500
 * "…budget line is not configured" — so these two are a structural requirement,
 * not a convenience. Everything else is created deliberately by an authorised
 * user through `POST /finance/budget-lines`, because a branch that never pays a
 * taxi fare should not carry a Taxi & Transportation envelope.
 */
export const PAYROLL_ENVELOPES: readonly PayrollEnvelope[] = [
  { target: 'teacher', name: 'Teacher Salaries', categoryId: 'sub_salaries_wages', icon: 'GraduationCap', costType: 'fixed', sortOrder: 10 },
  { target: 'employee', name: 'Employee Salaries', categoryId: 'sub_salaries_wages', icon: 'Users', costType: 'fixed', sortOrder: 20 },
] as const;

/** Deterministic id for a branch's payroll envelope. */
export function payrollEnvelopeId(target: PayrollTarget, branchId: string): string {
  return `bl_payroll_${target}_${branchId}`;
}

/**
 * Canonical ledger node for a payroll payment.
 *
 * A genuine ADVANCE can exceed salary already earned, so it is a receivable
 * against future pay — cash out, but not an operating cost. A full or partial
 * payment settles salary that has already accrued and is a wage expense. Only
 * the EMPLOYEE path can produce a genuine advance; see `teachers.routes.ts`.
 */
export function payrollLedgerCategoryId(isGenuineAdvance: boolean): string {
  return isGenuineAdvance ? 'sub_salary_advances' : 'sub_salaries_wages';
}

/** Every SUBCATEGORY id — the only nodes a budget line may attach to. */
export const SUBCATEGORY_IDS: ReadonlySet<string> = new Set(
  CANONICAL_CATEGORIES.flatMap((c) => c.children.map((s) => s.id)),
);

/** True when the id names a subcategory (and therefore a legal budget-line parent). */
export function isSubcategoryId(id: string | null | undefined): boolean {
  return !!id && SUBCATEGORY_IDS.has(id);
}
