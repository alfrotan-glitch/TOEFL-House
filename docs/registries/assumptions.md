# Assumption Register

§90 requires explicit separation of FACT · INFERENCE · ASSUMPTION · DECISION · UNKNOWN,
and requires work to STOP when an ASSUMPTION or UNKNOWN affects finance, security, data
integrity, RBAC or a core workflow.

| # | Statement | Class | Affects | Basis / why unresolved |
|---|---|---|---|---|
| A-1 | The system has no production dataset requiring preservation | **DECISION** (owner, recorded) | Everything | Stated explicitly by the owner and repeated in §0. All destructive authority derives from it |
| A-2 | AFN is the only currency the system will ever handle | **UNKNOWN** | Finance | Repository shows AFN-only with no FX code, but absence of code is not a requirement. §20 demands the currency policy be *established*, not inferred |
| A-3 | Money is transacted in whole AFN; sub-unit amounts are not operationally real | **UNKNOWN** | Finance | Storage is 2dp, display is 0dp. One of the two is wrong under §20's "one canonical rounding". Cannot be resolved from code |
| A-4 | Persian/Dari is **not** a supported UI language; the interface is English-LTR with Persian data | **INFERENCE** | UI/UX, §26 scope | Every view root is `dir="ltr"`, `<html lang="en">`. Consistent enough to look deliberate, but §26 conditions a large scope item on this answer |
| A-5 | The report set implemented today is the report set required | **UNKNOWN** | Reporting | §30 lists daily/weekly/monthly/quarterly/annual/payroll/management/audit reports "as applicable". Inventing the missing ones would violate §0 |
| A-6 | "Books" means retail sale only, not lending/issuance | **INFERENCE** | WP-10 | Repository implements `book_sales` and restock, with no loan or return model. §9/§29 list "Book issuance" as a distinct concept |
| A-7 | "Diplomas" is satisfied by the existing `certificates` model | **INFERENCE** | WP-06 | Repository has `certificates`; §9/§29 name "Diplomas" separately |
| A-8 | Multiple simultaneous positions per user is a real requirement | **UNKNOWN** | RBAC | `user_roles` supports many rows with one `is_primary`; §22 says "where required". Whether it is required — and how conflicting scopes resolve — is policy, not code |
| A-9 | Notifications are in scope | **UNKNOWN** | §9 | A `notifications` table and `addNotification()` exist, but §9 lists notifications "where applicable" |
| A-10 | The BOS profit-withdrawal tiers and the six-month reserve multiple are business policy, not placeholders | **ASSUMPTION** | Finance | Hard-coded tier thresholds in `bos.routes.ts` with no stated authority — a §2 LAW 7 ("no magic") violation unless an owner decision backs the numbers |

**Blocking status:** A-2, A-3, A-5 and A-8 affect finance, reporting or RBAC and are
therefore STOP conditions under §90 and §105. A-4 gates the size of the UI Work Packages.
None may be resolved by inference.
