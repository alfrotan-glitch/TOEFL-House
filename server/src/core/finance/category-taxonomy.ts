/**
 * Finance category taxonomy — THE canonical, hierarchical expense model.
 * ============================================================================
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this module the ERP had no finance category entity at all. What the
 * product called a "finance category" was one of three unrelated things:
 *
 *   1. `budget_lines`                   flat, per-branch, keyed by `purpose`
 *   2. `financial_transactions.category` free TEXT, no CHECK, no FK
 *   3. `payments.category`               student BILLING categories (fee/book/…)
 *
 * (3) is a different bounded context and is not touched here.
 *
 * The taxonomy below is the single source of truth used by
 *
 *   · `db/migrations/077_finance_category_hierarchy.sql` (via the seeder)
 *   · `db/organizationHierarchy.ts`   (fresh install + every branch)
 *   · `core/finance/ledger-classification.ts` (P&L / cash flow / reports)
 *   · `routes/finance.routes.ts`      (GET /finance/categories)
 *   · the test-suite
 *
 * so a change lands in exactly one place instead of five.
 *
 * DESIGN RULES ENCODED HERE
 * -------------------------
 * · IDs are STABLE CODES, never display names. Renaming "Rent Expense" to
 *   "Premises Rent" must not orphan a single budget line or ledger row.
 * · Exactly two levels: category → subcategory. A budget line is the third
 *   level and lives in `budget_lines`, so a category definition is never
 *   duplicated inside a budget line.
 * · Every node carries an explicit ACCOUNTING CLASSIFICATION. Nothing is
 *   "assumed to be an operating expense".
 * · Facebook is a CHANNEL under Marketing & Promotion → Digital Advertising.
 *   It is deliberately NOT an accounting category — see CANONICAL_CHANNELS.
 */

/**
 * The three accounting treatments the business must be able to tell apart.
 *
 * `operating_expense`         hits the trading result (P&L cost)
 * `capital_expenditure`       buys a fixed asset — cash out, NOT a P&L cost
 * `non_expense_cash_movement` advances, refunds, owner draws, charity — cash
 *                             moves but no operating cost is incurred
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
 * PRODUCT RULE: "Facebook" is a MARKETING CHANNEL, not an accounting category.
 * A separate "Facebook Advertising" ledger category would fragment the
 * marketing spend line and make Digital Advertising unauditable, so the
 * platform is modelled one level BELOW the subcategory instead.
 */
export const CANONICAL_CHANNELS: ReadonlyArray<{
  id: string;
  categoryId: string;
  name: string;
  kind: 'channel' | 'vendor';
}> = [{ id: 'chn_facebook', categoryId: 'sub_digital_advertising', name: 'Facebook', kind: 'channel' }] as const;

/**
 * How a legacy budget line maps onto the canonical taxonomy.
 *
 * `mapped`           → `categoryId` is a SUBCATEGORY. Unambiguous.
 * `needs_review`     → `categoryId` is a CATEGORY (the accounting treatment is
 *                      certain, the subcategory is not) or NULL (not even the
 *                      parent could be established without guessing). Surfaced
 *                      to the operator; never silently invented.
 * `out_of_taxonomy`  → deliberately outside the canonical model.
 */
export type BudgetLineMappingStatus = 'mapped' | 'needs_review' | 'out_of_taxonomy';

export const BUDGET_LINE_MAPPING_STATUSES: readonly BudgetLineMappingStatus[] = [
  'mapped',
  'needs_review',
  'out_of_taxonomy',
] as const;

export interface LegacyPurposeMapping {
  /** Canonical node this legacy purpose resolves to. NULL = undecidable. */
  categoryId: string | null;
  status: BudgetLineMappingStatus;
  /** Why this mapping is safe — or why it could not be decided. */
  rationale: string;
}

/**
 * Deterministic legacy `budget_lines.purpose` → canonical node mapping.
 *
 * Every entry is justified. Nothing here was decided because two names looked
 * alike: `electricity`, `water` and `gas` all fold under ONE subcategory
 * (Utilities) yet remain THREE separate budget lines, because merging them
 * would destroy three independently funded envelopes.
 */
export const LEGACY_PURPOSE_MAP: Readonly<Record<string, LegacyPurposeMapping>> = {
  teacher_salary: {
    categoryId: 'sub_salaries_wages',
    status: 'mapped',
    rationale: 'Teacher payroll is a wage cost.',
  },
  employee_salary: {
    categoryId: 'sub_salaries_wages',
    status: 'mapped',
    rationale: 'Staff payroll is a wage cost. Kept as a SEPARATE budget line from teacher payroll — same subcategory, distinct envelope.',
  },
  rent: { categoryId: 'sub_rent', status: 'mapped', rationale: 'Premises rent.' },
  electricity: { categoryId: 'sub_utilities', status: 'mapped', rationale: 'Utility supply.' },
  water: { categoryId: 'sub_utilities', status: 'mapped', rationale: 'Utility supply.' },
  gas: { categoryId: 'sub_utilities', status: 'mapped', rationale: 'Utility supply.' },
  internet: {
    categoryId: 'sub_internet_communication',
    status: 'mapped',
    rationale: 'Connectivity, distinct from Telephone Expenses.',
  },
  printing: { categoryId: 'sub_printing', status: 'mapped', rationale: 'Print production cost.' },
  maintenance: {
    categoryId: 'sub_repair_maintenance',
    status: 'mapped',
    rationale: 'Legacy name "Maintenance & Repairs" is the same scope as Repair & Maintenance.',
  },
  cleaning: { categoryId: 'sub_cleaning_sanitation', status: 'mapped', rationale: 'Cleaning & hygiene of the premises.' },
  kitchen: {
    categoryId: 'sub_food_catering',
    status: 'mapped',
    rationale: 'Legacy "Kitchen & Refreshments" is catering spend.',
  },
  misc: { categoryId: 'sub_miscellaneous', status: 'mapped', rationale: 'Residual operating spend.' },
  equipment: {
    // Owner decision, 2026-08-20, taken from evidence inside the model rather
    // than from the word "Equipment": the seed catalogue gives this line the
    // `Monitor` icon (a computer display), which identifies it as TECHNOLOGY
    // equipment rather than general office furniture.
    categoryId: 'sub_it_equipment',
    status: 'mapped',
    rationale: 'Seed catalogue icon is `Monitor` (computer display) — technology equipment, therefore Capital Expenditure → IT Equipment.',
  },
  marketing: {
    // The row carries no channel information (`is_marketing = 1` only), and the
    // target taxonomy splits marketing three ways. The CATEGORY is certain, the
    // SUBCATEGORY is not, so the subcategory is left for a human.
    categoryId: 'cat_marketing_promotion',
    status: 'needs_review',
    rationale: 'Accounting treatment is certain (operating expense, Marketing & Promotion) but Digital vs Traditional vs Promotional cannot be established from the data.',
  },
  transport: {
    categoryId: 'cat_transport_logistics',
    status: 'needs_review',
    rationale: 'Category certain; Fuel vs Taxi vs Delivery vs Travel is not recorded anywhere in the model.',
  },
  purchases: {
    // "General Purchases" could sit under Office & Administration, Academic &
    // Student Operations or Food & General Operations. Not even the parent is
    // decidable, so nothing is asserted.
    categoryId: null,
    status: 'needs_review',
    rationale: 'Neither the category nor the subcategory can be established: Office Supplies, Teaching Materials and Miscellaneous are all consistent with the data.',
  },
  reserve: {
    // A contingency fund, not an expense classification. The BOS profit
    // withdrawal rule already depends on a reserve target, so the line stays
    // fully operational — it is simply outside the expense taxonomy.
    categoryId: null,
    status: 'out_of_taxonomy',
    rationale: 'Contingency reserve. The canonical taxonomy has no equivalent node and inventing one would misstate it as spend.',
  },
};

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
