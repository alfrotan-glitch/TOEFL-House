# Decision Log

Final architectural decisions only. This is history — it stays here and **out of source
comments**, per the source-cleanliness rule in the protocol.

| Date | WP | Decision | Alternatives considered | Evidence class | Reversible? | Approved by |
|---|---|---|---|---|---|---|
| 2026-08-20 | WP-07 | Adopt a two-level canonical finance taxonomy (10 categories / 45 subcategories) with channels below subcategories | keep the flat per-branch `purpose` model; three-level taxonomy | PROVEN | Yes (migration) | Owner |
| 2026-08-20 | WP-07 | Facebook is modelled as a **channel** of Digital Advertising, never an accounting category | a `Facebook Advertising` subcategory | PROVEN | Yes | Owner |
| 2026-08-20 | WP-07 | `financial_transactions.finance_category_id` (FK) replaces the copied category string as the accounting authority | keep the string and a lookup table | PROVEN | No (forward-only migration) | Owner |
| 2026-08-20 | WP-07 | **Clean-slate exception**: delete the legacy budget model outright rather than preserving compatibility. Ground: pre-operational system, no production financial data. Scope: WP-07 category/budget model only. **Spent — does not carry forward.** | extend-and-map (migrations 077/078, superseded) | PROVEN | No | Owner |
| 2026-08-20 | WP-07 | Taxonomy and budget are separate concerns: a fresh branch is provisioned with **2** payroll envelopes, not one line per subcategory | seed 45 zero-value lines per branch | PROVEN | Yes | Owner |
| 2026-08-20 | WP-07/08 | Payroll resolves its envelope through `budget_lines.payroll_target`, a modelled business relationship | reuse a name/purpose string; single shared Salaries & Wages line; caller-supplied id | PROVEN | Yes | Owner (option E-1) |
| 2026-08-20 | WP-08 | Teacher `advance` removed — capped at the period's remaining due, so it was a partial payment of earned salary. Employee `advance` retained and classified as a Non-Expense Cash Movement. | reclassify both; reclassify neither | PROVEN | Yes | Owner (option 11-C) |
| 2026-08-20 | WP-07 | Reserve is **not** part of the expense taxonomy and has no budget line; the six-month reserve rule stays treasury/BOS policy | model Reserve as an expense subcategory | PROVEN | Yes | Owner |
| 2026-08-20 | — | Adopt Engineering Protocol v2: Work Package scope, CHECKPOINT before irreversible actions, mandatory INDEPENDENT REVIEW, three certification statuses | keep Protocol v1 (58 phases, whole system, one pass) | SUPPORTED | Yes | Owner |
| 2026-08-20 | — | Registries are executable: `npm run audit:registries` runs in the release gate, so a stale registry fails the build | keep registries as prose | PROVEN | Yes | Agent, under protocol §5 |

## Tracked risks (READY WITH TRACKED RISK items)

| # | Risk | Severity | WP | Owner | Target |
|---|---|---|---|---|---|
| TR-1 | Bidirectional text embedding unverified: Persian labels and Persian-Indic digits inside LTR containers have no test asserting punctuation/digit ordering | Low | WP-11 | Owner | next UI pass |
| TR-2 | Money displayed with 0 decimals while stored with 2; a displayed total can differ from the sum of displayed parts by up to one unit | Low | WP-07 | Owner | accepted, revisit if a second currency is added |
| TR-3 | No `POST /finance/budget-lines` audit of *deactivation* flow in the UI — the API supports `isActive:false` but no screen exposes it | Low | WP-07 | Owner | next Finance UI pass |
| TR-4 | INDEPENDENT REVIEW is performed by the same agent; mitigated by artifact-only review and executable findings, not eliminated | Medium | — | Owner | structural, needs a second reviewer |
